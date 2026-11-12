import { describe, expect, it } from 'vitest';
import { isTextBlock, isToolResultBlock, type ForkInfo, type SchedulerAction } from '@protea/protocol';
import { reply, sleep, textReply, toolCall, type ProviderRequest, type ScriptStep, type ToolSpec } from '../src/index.js';
import { makeHarness, waitFor, type Harness } from './helpers.js';

function hasEvent(req: ProviderRequest, text: string): boolean {
  return req.messages.some((m) => m.content.some((b) => isTextBlock(b) && b.text.includes(text)));
}

const forkRounds = (req: ProviderRequest): number => req.messages.filter((m) => m.role === 'assistant').length;

function stepTool(ms: number, log: string[] = []): ToolSpec<never> {
  const spec: ToolSpec<Record<string, unknown>> = {
    name: 'step',
    description: 'One unit of background work.',
    inputSchema: { type: 'object' },
    handler: async () => {
      log.push('step');
      await sleep(ms);
      return 'step done';
    },
  };
  return spec as unknown as ToolSpec<never>;
}

/** Fork script: `n` rounds of the step tool, then a final summary. */
function forkWork(n: number, summary = 'all done'): ScriptStep {
  return (req) => (forkRounds(req) < n ? reply([toolCall('step', {})]) : textReply(summary));
}

function route(main: ScriptStep, fork: ScriptStep): ScriptStep {
  return (req, i, ctx) => (req.role === 'main' ? main(req, i, ctx) : fork(req, i, ctx));
}

const idleMain: ScriptStep = () => reply([toolCall('idle', {})]);

async function waitState(h: Harness, id: string, state: ForkInfo['state'], timeoutMs = 5000): Promise<ForkInfo> {
  await waitFor(() => h.forks.get(id)?.state === state, timeoutMs, `fork ${id} ${state}`);
  return h.forks.get(id) as ForkInfo;
}

describe('forks', () => {
  it('runs a fork spawned by the main session and reports its result back as an event', async () => {
    const h = makeHarness({
      extraTools: [stepTool(5)],
      steps: [
        route(
          (req) => {
            if (hasEvent(req, 'type="fork.completed"')) return reply([toolCall('say', { text: 'brief ready' }), toolCall('idle', {})]);
            if (req.messages.length === 1) return reply([toolCall('fork_spawn', { goal: 'Collect the three top headlines.' })]);
            return reply([toolCall('idle', {})]);
          },
          forkWork(2, 'Headlines: A, B, C.'),
        ),
      ],
    });
    try {
      const brief = h.push({ text: 'morning brief', level: 3, trigger: 'flush', type: 'cron.tick' }, 'cron', 3);
      await waitFor(() => h.forks.list().length === 1);
      const id = (h.forks.list()[0] as ForkInfo).id;
      // It reported, and now waits with its conversation for follow-up work.
      const done = await waitState(h, id, 'idle');
      await waitFor(() => h.store.query({ type: 'fork.completed' })[0]?.state === 'delivered', 3000);
      await h.idle();

      expect(done).toMatchObject({ level: 3, model: 'fork', rounds: 3, summary: 'Headlines: A, B, C.' });
      expect(h.outputs).toEqual(['brief ready']);
      const report = h.store.query({ type: 'fork.completed' })[0];
      expect(report).toMatchObject({ source: 'core', origin: 'internal', effLevel: 3, effTrigger: 'flush', correlation: id });
      expect(report?.text).toContain('Headlines: A, B, C.');
      expect(report?.batchId).not.toBe(h.store.get(brief.cursor as number)?.batchId);

      // The fork's own requests: fork model role, no session-control or fork tools, goal first.
      const provider = h.provider as unknown as { calls: ProviderRequest[] };
      const forkReq = provider.calls.find((c) => c.role === 'fork') as ProviderRequest;
      expect(forkReq.system.map((s) => s.id)).toEqual(['runtime']);
      expect(forkReq.tools.map((t) => t.name)).toEqual(['events_promote', 'events_query', 'say', 'step']);
      const transcript = h.forks.transcript(id) ?? [];
      expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      const first = transcript[0]?.content[0];
      expect(first && isTextBlock(first) ? first.text : '').toContain(`<fork id="${id}" level="3"`);
      // A fork sees no events and no status snapshot, so its first message carries the time.
      expect(first && isTextBlock(first) ? first.text : '').toMatch(/ now="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00">/);
      // Usage is attributed to the fork and its level.
      const usage = h.db.prepare('SELECT role, session_id AS s, level FROM usage WHERE role = ?').all('fork') as Array<{ s: string; level: number }>;
      expect(usage).toHaveLength(3);
      expect(usage.every((u) => u.s === id && u.level === 3)).toBe(true);
      expect(h.sessions.get(id)).toMatchObject({ kind: 'fork', state: 'idle', level: 3, parentId: h.store.get(brief.cursor as number)?.batchId });
    } finally {
      await h.close();
    }
  });

  it('pauses while the main session serves the owner, then resumes and completes', async () => {
    const log: string[] = [];
    const h = makeHarness({
      extraTools: [stepTool(60, log)],
      steps: [
        route(async (req, _i, { signal }) => {
          if (forkRounds(req) === 0) await sleep(300, signal); // the owner's turn takes a while
          return reply([toolCall('idle', {})]);
        }, forkWork(4, 'report written')),
      ],
    });
    const acts: SchedulerAction[] = [];
    h.bus.on('scheduler.action', (a) => acts.push(a));
    const states: string[] = [];
    try {
      const f = h.forks.spawn({ goal: 'write the weekly report', level: 3 });
      h.bus.on('fork.changed', (i) => {
        if (i.id === f.id) states.push(`${i.state}${i.pauseReason ? `:${i.pauseReason}` : ''}`);
      });
      await waitFor(() => log.length >= 1);
      const ownerTurn = { batchId: '', startSteps: -1, endSteps: -1 };
      h.bus.on('batch.started', (b) => {
        if (b.level !== 1) return;
        ownerTurn.batchId = b.batchId;
        ownerTurn.startSteps = log.length;
      });
      h.bus.on('batch.ended', (b) => {
        if (b.batchId === ownerTurn.batchId) ownerTurn.endSteps = log.length;
      });
      h.push({ text: 'hi', level: 1, trigger: 'flush' });
      await waitState(h, f.id, 'paused');
      expect(h.main.busy).toBe(true);
      expect(h.forks.get(f.id)?.pauseReason).toBe('yield');
      const done = await waitState(h, f.id, 'idle');
      await h.idle();

      expect(done.summary).toBe('report written');
      // At most the step already in flight finished during the owner's turn; no new one started.
      expect(ownerTurn.startSteps).toBeGreaterThanOrEqual(1);
      expect(ownerTurn.endSteps - ownerTurn.startSteps).toBe(0);
      expect(states).toEqual(['running', 'paused:yield', 'running', 'running', 'running', 'running', 'idle']);
      expect(acts.map((a) => a.kind)).toEqual(['fork_yield', 'fork_resume']);
      expect(log).toHaveLength(4);
      const msgs = h.forks.transcript(f.id) ?? [];
      expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(5);
    } finally {
      await h.close();
    }
  });

  it('cancels the model call of a low-priority fork that does not yield in time, and re-issues it', async () => {
    let forkCalls = 0;
    const h = makeHarness({
      forks: { yieldTimeoutMs: 80 },
      steps: [
        route(
          async (req, _i, { signal }) => {
            if (forkRounds(req) === 0) await sleep(200, signal);
            return reply([toolCall('idle', {})]);
          },
          async (_req, _i, { signal }) => {
            forkCalls++;
            if (forkCalls === 1) await sleep(5000, signal); // a very long first call
            return textReply('finished');
          },
        ),
      ],
    });
    try {
      const f = h.forks.spawn({ goal: 'slow job', level: 4 });
      await waitFor(() => forkCalls === 1);
      const t0 = Date.now();
      h.push({ text: 'hi', level: 1, trigger: 'flush' });
      await waitState(h, f.id, 'paused');
      expect(Date.now() - t0).toBeLessThan(1000);
      const done = await waitState(h, f.id, 'idle');
      expect(forkCalls).toBe(2);
      expect(done.rounds).toBe(1); // the cancelled call left nothing behind
    } finally {
      await h.close();
    }
  });

  it('pauses at shutdown and continues after a restart', async () => {
    const h1 = makeHarness({ extraTools: [stepTool(200)], steps: [route(idleMain, forkWork(3, 'survived'))] });
    const f = h1.forks.spawn({ goal: 'survive a restart', level: 3 });
    await waitFor(() => (h1.forks.get(f.id)?.rounds ?? 0) >= 1);
    await h1.close(0); // no grace: the running step is cancelled
    const h2 = makeHarness({ dir: h1.dir, extraTools: [stepTool(5)], steps: [route(idleMain, forkWork(3, 'survived'))] });
    try {
      const done = await waitState(h2, f.id, 'idle');
      expect(done.summary).toBe('survived');
      const results = (h2.forks.transcript(f.id) ?? []).flatMap((m) => m.content.filter(isToolResultBlock));
      expect(results.some((r) => r.content === 'step was cancelled')).toBe(true);
      await waitFor(() => h2.store.query({ type: 'fork.completed' }).length === 1);
    } finally {
      await h2.close();
    }
  });

  it('queues forks beyond the concurrency limit', async () => {
    const h = makeHarness({ forks: { maxConcurrent: 1 }, extraTools: [stepTool(30)], steps: [route(idleMain, forkWork(2))] });
    try {
      const a = h.forks.spawn({ goal: 'a', level: 3 });
      const b = h.forks.spawn({ goal: 'b', level: 3 });
      expect([a.state, b.state]).toEqual(['running', 'queued']);
      await waitState(h, a.id, 'idle');
      await waitState(h, b.id, 'idle');
    } finally {
      await h.close();
    }
  });

  it('cancels a fork without reporting it', async () => {
    const h = makeHarness({
      steps: [
        route(idleMain, async (_req, _i, { signal }) => {
          await sleep(5000, signal);
          return textReply('never');
        }),
      ],
    });
    try {
      const f = h.forks.spawn({ goal: 'cancel me', level: 3 });
      await waitFor(() => h.forks.get(f.id)?.state === 'running');
      h.forks.cancel(f.id);
      await waitState(h, f.id, 'cancelled');
      expect(h.store.query({ type: 'fork.cancelled' })).toEqual([]);
      expect(h.sessions.get(f.id)?.state).toBe('cancelled');
    } finally {
      await h.close();
    }
  });

  it('takes patterns in a fork\'s tool list, side effects included, and refuses one that matches nothing', async () => {
    let forkTools: string[] = [];
    const h = makeHarness({
      steps: [
        route(
          (req) => {
            if (req.messages.length === 1) {
              return reply([toolCall('fork_spawn', { goal: 'by pattern', tools: ['sa?', 'events_*'] }), toolCall('fork_spawn', { goal: 'nothing', tools: ['nope_*'] })]);
            }
            return reply([toolCall('idle', {})]);
          },
          (req) => {
            forkTools = req.tools.map((t) => t.name);
            return textReply('ok');
          },
        ),
      ],
    });
    try {
      h.push({ text: 'tick', level: 3, trigger: 'flush' }, 'cron', 3);
      await waitFor(() => forkTools.length > 0);
      await h.idle();
      expect(forkTools.sort()).toEqual(['events_promote', 'events_query', 'say']);
      const results = h.transcript.messages.flatMap((m) => m.content.filter(isToolResultBlock));
      expect(results[1]).toMatchObject({ is_error: true, content: 'fork not started: these tools are not available to forks: nope_*' });
    } finally {
      await h.close();
    }
  });

  it('clamps the level of a spawned fork and rejects tools forks may not use', async () => {
    const h = makeHarness({
      steps: [
        route(
          (req) => {
            if (req.messages.length === 1) {
              return reply([
                toolCall('fork_spawn', { goal: 'urgent?', level: 1 }),
                toolCall('fork_spawn', { goal: 'with idle', tools: ['idle'] }),
              ]);
            }
            return reply([toolCall('idle', {})]);
          },
          () => textReply('ok'),
        ),
      ],
    });
    try {
      h.push({ text: 'tick', level: 3, trigger: 'flush' }, 'cron', 3);
      await waitFor(() => h.transcript.messages.length >= 3);
      await h.idle();
      const results = h.transcript.messages.flatMap((m) => m.content.filter(isToolResultBlock));
      expect(results[0]?.content).toContain('at level 3');
      expect(results[0]?.content).toContain('level raised to 3');
      expect(results[1]).toMatchObject({ is_error: true, content: 'fork not started: these tools are not available to forks: idle' });
      expect(h.forks.list().map((f) => f.level)).toEqual([3]);
    } finally {
      await h.close();
    }
  });

  /** Fork script: the goal takes one step; each <followup> is answered from what it already knows. */
  const reusable: ScriptStep = (req) => {
    const said = req.messages.flatMap((m) => m.content.filter(isTextBlock).map((b) => b.text)).join('\n');
    const followups = (said.match(/<followup from="main"/g) ?? []).length;
    const answered = req.messages.filter((m) => m.role === 'assistant' && !m.content.some((b) => b.type === 'tool_use')).length;
    if (followups >= answered && followups > 0) return textReply(`follow-up ${followups} done${said.includes('<message from="main"') ? ' (with the note)' : ''}`);
    return forkRounds(req) < 1 ? reply([toolCall('step', {})]) : textReply('first result');
  };

  it('keeps a fork that reported, gives it follow-up work with its conversation, and releases it when none comes', async () => {
    const h = makeHarness({ forks: { idleTtlMs: 150 }, extraTools: [stepTool(5)], steps: [route(idleMain, reusable)] });
    try {
      const f = h.forks.spawn({ goal: 'look into A', level: 3 });
      const idle = await waitState(h, f.id, 'idle');
      expect(idle).toMatchObject({ summary: 'first result', rounds: 2 });
      expect(Date.parse(idle.idleUntil as string) - Date.now()).toBeLessThanOrEqual(150);
      await waitFor(() => h.store.query({ type: 'fork.completed' }).length === 1);
      expect(h.store.query({ type: 'fork.completed' })[0]?.text).toMatch(/The fork stays idle with its conversation until .+: fork_send gives it follow-up work\./);
      // An idle fork is not work in progress.
      expect(h.forks.activeCount()).toBe(0);

      expect(h.forks.send(f.id, 'now look into B')).toMatchObject({ delivery: 'resumed', fork: { state: 'running' } });
      await waitFor(() => h.store.query({ type: 'fork.completed' }).length === 2);
      const again = await waitState(h, f.id, 'idle');
      expect(again).toMatchObject({ summary: 'follow-up 1 done', rounds: 3, tasks: 2 });
      expect(h.store.query({ type: 'fork.completed' }).some((e) => e.text.includes('completed (follow-up 1)'))).toBe(true);
      // One conversation: the goal, its work, the first answer, then the follow-up and its answer.
      const t = h.forks.transcript(f.id) ?? [];
      expect(t.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      const followup = t[4]?.content[0];
      expect(followup && isTextBlock(followup) ? followup.text : '').toMatch(/^<followup from="main" task="2" max_rounds="20" now="[^"]+">\nnow look into B\n<\/followup>$/);

      // Nothing more comes: it is released, quietly, and can take no more work.
      await sleep(170);
      expect(h.forks.sweep()).toBe(1);
      expect(h.forks.get(f.id)).toMatchObject({ state: 'completed', summary: 'follow-up 1 done' });
      expect(h.forks.get(f.id)?.idleUntil).toBeUndefined();
      expect(h.sessions.get(f.id)?.state).toBe('completed');
      expect(h.store.query({ type: 'fork.completed' })).toHaveLength(2);
      expect(() => h.forks.send(f.id, 'one more')).toThrow(/is completed and its conversation is closed; spawn a new fork/);
    } finally {
      await h.close();
    }
  });

  it('hands a message to a fork that is still working at its next step', async () => {
    const h = makeHarness({
      extraTools: [stepTool(60)],
      steps: [
        route(idleMain, (req) => {
          const said = req.messages.flatMap((m) => m.content.filter(isTextBlock).map((b) => b.text)).join('\n');
          return forkRounds(req) < 2 ? reply([toolCall('step', {})]) : textReply(said.includes('<message from="main"') ? 'done, with the correction' : 'done');
        }),
      ],
    });
    try {
      const f = h.forks.spawn({ goal: 'long job', level: 3 });
      await waitFor(() => (h.forks.get(f.id)?.rounds ?? 0) >= 1);
      expect(h.forks.send(f.id, 'use the 2026 figures')).toMatchObject({ delivery: 'queued' });
      const done = await waitState(h, f.id, 'idle');
      expect(done).toMatchObject({ summary: 'done, with the correction' });
      // A correction is part of the work in hand, not a piece of work of its own.
      expect(done.tasks).toBeUndefined();
      expect(h.store.query({ type: 'fork.completed' })).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('keeps at most maxIdle forks, and ends at once a fork nobody will follow up on', async () => {
    const h = makeHarness({ forks: { maxIdle: 1 }, steps: [route(idleMain, () => textReply('ok'))] });
    try {
      const a = h.forks.spawn({ goal: 'a', level: 3 });
      await waitState(h, a.id, 'idle');
      const b = h.forks.spawn({ goal: 'b', level: 3 });
      await waitState(h, b.id, 'idle');
      // The one idle longest made room.
      expect(h.forks.get(a.id)?.state).toBe('completed');
      // A fork that reports to nobody (the nightly consolidation) has no one to follow up.
      const quiet = h.forks.spawn({ goal: 'quiet', level: 3, reportTo: 'none' });
      await waitState(h, quiet.id, 'completed');
      // Releasing by hand: cancelling an idle fork ends it without calling it cancelled.
      expect(h.forks.cancel(b.id)).toMatchObject({ state: 'completed' });
      expect(h.store.query({ type: 'fork.cancelled' })).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('ends forks at once when idle time is turned off', async () => {
    const h = makeHarness({ forks: { idleTtlMs: 0 }, steps: [route(idleMain, () => textReply('ok'))] });
    try {
      const f = h.forks.spawn({ goal: 'a', level: 3 });
      await waitState(h, f.id, 'completed');
      expect(h.store.query({ type: 'fork.completed' })[0]?.text).not.toContain('fork_send');
    } finally {
      await h.close();
    }
  });

  it('keeps an idle fork across a restart, where it still takes follow-up work', async () => {
    const h1 = makeHarness({ extraTools: [stepTool(5)], steps: [route(idleMain, reusable)] });
    const f = h1.forks.spawn({ goal: 'look into A', level: 3 });
    await waitState(h1, f.id, 'idle');
    await h1.close();
    const h2 = makeHarness({ dir: h1.dir, extraTools: [stepTool(5)], steps: [route(idleMain, reusable)] });
    try {
      expect(h2.forks.get(f.id)).toMatchObject({ state: 'idle', summary: 'first result' });
      h2.forks.send(f.id, 'and B?');
      await waitFor(() => h2.forks.get(f.id)?.summary === 'follow-up 1 done');
      expect(h2.forks.get(f.id)?.state).toBe('idle');
    } finally {
      await h2.close();
    }
  });

  it('lets the main session reuse a fork with fork_send', async () => {
    let sent = false;
    const h = makeHarness({
      extraTools: [stepTool(5)],
      steps: [
        route((req) => {
          const reports = req.messages.flatMap((m) => m.content.filter(isTextBlock)).filter((b) => b.text.includes('type="fork.completed"'));
          const id = /Fork (f_[A-Z0-9]+) completed/.exec(reports.map((b) => b.text).join('\n'))?.[1];
          if (reports.length > 0 && id && !sent) {
            sent = true;
            return reply([toolCall('fork_send', { id, message: 'and the weather?' })]);
          }
          if (req.messages.length === 1) return reply([toolCall('fork_spawn', { goal: 'Collect headlines.' })]);
          return reply([toolCall('idle', {})]);
        }, reusable),
      ],
    });
    try {
      h.push({ text: 'brief', level: 3, trigger: 'flush' }, 'cron', 3);
      await waitFor(() => h.store.query({ type: 'fork.completed' }).length === 2, 8000);
      await h.idle();
      const results = h.transcript.messages.flatMap((m) => m.content.filter(isToolResultBlock)).map((r) => String(r.content));
      expect(results.some((r) => /^Fork f_\w+ took the follow-up work and is (running|queued)\. Its result arrives as a fork\.completed event\.$/.test(r))).toBe(true);
      expect(h.forks.list()).toHaveLength(1);
      expect(h.forks.list()[0]).toMatchObject({ state: 'idle', tasks: 2, summary: 'follow-up 1 done' });
    } finally {
      await h.close();
    }
  });
});
