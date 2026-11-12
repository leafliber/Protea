import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, type Host, type PluginDefinition, type PluginTool } from '@protea/plugin-sdk';
import { DEFAULT_SANDBOX_SOCKET, SandboxClient, clipOutput, commandEnv, formatResult, resolveCwd, runCommand, type JobEnded, type JobInfo, type RunResult } from '@protea/sandbox';

export { clipOutput, commandEnv, formatResult, resolveCwd, runCommand, type RunResult };

export interface ShellConfig {
  /** `sandbox`: the separate container. `local`: inside the daemon's container, without isolation (ADR-0013). */
  backend?: 'sandbox' | 'local';
  socket?: string;
  timeoutSec?: number;
  maxOutputKb?: number;
  shell?: string;
  maxConcurrent?: number;
  env?: Record<string, string>;
  jobs?: { max?: number; logMb?: number };
}

const DEFAULT_LOG_TAIL_KB = 16;
const MAX_EVENT_TAIL = 2000;

function describeJob(j: JobInfo): string {
  const end = j.state === 'running' ? 'running' : `${j.state}${j.exitCode !== undefined && j.exitCode !== null ? ` (exit ${j.exitCode})` : j.signal ? ` (${j.signal})` : ''}`;
  return `${j.id}${j.name ? ` ${j.name}` : ''} [${end}] since ${j.startedAt}: ${j.command.length > 200 ? `${j.command.slice(0, 200)}…` : j.command}`;
}

export function createShellPlugin(): PluginDefinition<ShellConfig> {
  let running = 0;
  let client: SandboxClient | null = null;
  const workspaceOf = (host: Host<ShellConfig>): string => {
    const ws = path.join(host.hostDataDir, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  };
  const settings = (host: Host<ShellConfig>) => ({
    backend: host.config.backend ?? 'sandbox',
    socket: host.config.socket ?? DEFAULT_SANDBOX_SOCKET,
    timeoutSec: host.config.timeoutSec ?? 120,
    maxOutputKb: host.config.maxOutputKb ?? 64,
    shell: host.config.shell,
    maxConcurrent: host.config.maxConcurrent ?? 2,
    env: host.config.env ?? {},
    jobsMax: host.config.jobs?.max ?? 8,
    jobLogBytes: (host.config.jobs?.logMb ?? 16) * 1024 * 1024,
  });
  const notSandboxed = { text: 'not run: background jobs and shell state need the sandbox (backend: sandbox)', failed: true };

  /** Tell the main session; the agent keeps the news until this has been stored. */
  const report = async (host: Host<ShellConfig>, e: JobEnded): Promise<void> => {
    const j = e.job;
    const how = j.state === 'lost' ? 'was lost: the sandbox restarted while it ran' : j.state === 'stopped' ? 'was stopped' : j.signal ? `was killed by ${j.signal}` : `exited with code ${j.exitCode}`;
    const tail = e.tail.length > MAX_EVENT_TAIL ? `…${e.tail.slice(-MAX_EVENT_TAIL)}` : e.tail;
    try {
      await host.events.push({
        type: j.state === 'lost' ? 'shell.job_lost' : 'shell.job_exited',
        ts: new Date().toISOString(),
        level: 3,
        trigger: 'flush',
        text: `Background job ${j.id}${j.name ? ` (${j.name})` : ''} ${how}.\nCommand: ${j.command.slice(0, 500)}${tail.trim() ? `\nLast output:\n${tail}` : ''}`,
        dedupeKey: `job:${e.instance}:${j.id}:${j.state}`,
        correlation: j.id,
      });
      await client?.jobAck([j.id]);
    } catch (err) {
      host.log.warn('could not report a finished job', { job: j.id, err: (err as Error).message });
    }
  };

  const session = (ctx: { context: { sessionId: string } }): string => ctx.context.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const sandbox = (): SandboxClient => {
    if (!client) throw new Error('the sandbox client is not running');
    return client;
  };
  const guarded = async <T extends { text: string; failed?: boolean }>(f: () => Promise<T | { text: string; failed: boolean }>): Promise<T | { text: string; failed: boolean }> => {
    try {
      return await f();
    } catch (err) {
      return { text: `not run: ${(err as Error).message}`, failed: true };
    }
  };

  const tools: PluginTool<any, ShellConfig>[] = [
    {
      name: 'sh_run',
      approval: { title: { zh: '运行命令', en: 'Run a command' }, target: 'command', fields: { cwd: { zh: '目录', en: 'In' }, timeoutSec: { zh: '超时（秒）', en: 'Timeout (s)' }, stdin: { zh: '标准输入', en: 'Standard input' } } },
      description:
        'Run a non-interactive shell command and return its exit code and output. With the sandbox the shell keeps going between calls: the current directory, exported variables and functions carry over. Long output is cut in the middle; a command that runs past the timeout is killed with everything it started. For anything that should keep running, use sh_job_start.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 20_000, description: 'Shell command line.' },
          cwd: { type: 'string', description: 'Directory to run in, absolute or relative to the workspace (default: where the last command ended).' },
          timeoutSec: { type: 'integer', minimum: 1, description: 'Shorter timeout for this call (capped by the configured one).' },
          stdin: { type: 'string', maxLength: 1_000_000, description: 'Text written to standard input.' },
        },
      },
      flags: { sideEffect: true, interruptible: true },
      // The dispatcher's own timeout must outlast the command's.
      timeoutMs: 3_660_000,
      handler: async (i: { command: string; cwd?: string; timeoutSec?: number; stdin?: string }, ctx, host) => {
        const s = settings(host);
        if (running >= s.maxConcurrent) return { text: `not run: ${running} commands are already running (maxConcurrent ${s.maxConcurrent}); wait for them`, failed: true };
        const timeoutSec = Math.min(i.timeoutSec ?? s.timeoutSec, s.timeoutSec);
        const maxBytes = s.maxOutputKb * 1024;
        running++;
        try {
          host.log.info('running a command', { callId: ctx.callId, backend: s.backend, chars: i.command.length });
          if (s.backend === 'sandbox') {
            return await guarded(async () => {
              const r = await sandbox().run(
                {
                  runId: ctx.callId,
                  session: session(ctx),
                  command: i.command,
                  timeoutMs: timeoutSec * 1000,
                  captureBytes: maxBytes * 4,
                  env: s.env,
                  ...(i.cwd !== undefined ? { cwd: i.cwd } : {}),
                  ...(i.stdin !== undefined ? { stdin: i.stdin } : {}),
                },
                ctx.signal,
              );
              host.log.info('command finished', { callId: ctx.callId, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, ms: r.ms });
              return formatResult(r, maxBytes, timeoutSec, r.cwd);
            });
          }
          const ws = workspaceOf(host);
          let cwd: string;
          try {
            cwd = resolveCwd(ws, i.cwd);
          } catch (err) {
            return { text: `not run: ${(err as Error).message}`, failed: true };
          }
          const r = await runCommand({
            shell: s.shell ?? '/bin/sh',
            command: i.command,
            cwd,
            env: commandEnv(ws, s.env),
            timeoutMs: timeoutSec * 1000,
            ...(i.stdin !== undefined ? { stdin: i.stdin } : {}),
            captureBytes: maxBytes * 4,
            signal: ctx.signal,
          });
          host.log.info('command finished', { callId: ctx.callId, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, ms: r.ms });
          return formatResult(r, maxBytes, timeoutSec);
        } finally {
          running--;
        }
      },
    },
    {
      name: 'sh_job_start',
      approval: { title: { zh: '在后台启动命令', en: 'Start a command in the background' }, target: 'command', fields: { name: { zh: '名称', en: 'Label' }, cwd: { zh: '目录', en: 'In' } } },
      description: 'Start a command in the background (a server, a long build) and return its job id. Its output goes to a log; a shell.job_exited event tells you when it ends.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 20_000 },
          name: { type: 'string', maxLength: 64, description: 'A short label.' },
          cwd: { type: 'string', description: 'Directory to run in, absolute or relative to the workspace.' },
        },
      },
      flags: { sideEffect: true },
      handler: (i: { command: string; name?: string; cwd?: string }, ctx, host) => {
        const s = settings(host);
        if (s.backend !== 'sandbox') return notSandboxed;
        return guarded(async () => {
          const j = await sandbox().jobStart({
            session: session(ctx),
            command: i.command,
            env: s.env,
            maxRunning: s.jobsMax,
            logBytes: s.jobLogBytes,
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.cwd !== undefined ? { cwd: i.cwd } : {}),
          });
          return { text: `started ${describeJob(j)}` };
        });
      },
    },
    {
      name: 'sh_job_list',
      description: 'List background jobs: the running ones and the most recently ended.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      flags: { readOnly: true },
      handler: (_i, _ctx, host) => {
        if (settings(host).backend !== 'sandbox') return notSandboxed;
        return guarded(async () => {
          const jobs = await sandbox().jobList();
          return { text: jobs.length === 0 ? 'no jobs' : jobs.map(describeJob).join('\n') };
        });
      },
    },
    {
      name: 'sh_job_logs',
      description: 'Read the end of a background job\'s output.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string' }, tailKb: { type: 'integer', minimum: 1, maximum: 1024, default: DEFAULT_LOG_TAIL_KB } },
      },
      flags: { readOnly: true },
      handler: (i: { id: string; tailKb?: number }, _ctx, host) => {
        if (settings(host).backend !== 'sandbox') return notSandboxed;
        return guarded(async () => {
          const r = await sandbox().jobLogs(i.id, (i.tailKb ?? DEFAULT_LOG_TAIL_KB) * 1024);
          return { text: `${describeJob(r.job)}\n${r.text || '(no output)'}` };
        });
      },
    },
    {
      name: 'sh_job_stop',
      approval: { title: { zh: '停止后台任务', en: 'Stop a background job' }, target: 'id' },
      description: 'Stop a background job and everything it started.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
      flags: { sideEffect: true },
      timeoutMs: 20_000,
      handler: (i: { id: string }, _ctx, host) => {
        if (settings(host).backend !== 'sandbox') return notSandboxed;
        return guarded(async () => ({ text: describeJob(await sandbox().jobStop(i.id)) }));
      },
    },
    {
      name: 'sh_reset',
      approval: { title: { zh: '重置 shell 状态', en: 'Reset the shell state' } },
      description: 'Forget the shell\'s state (current directory, variables, functions). Files stay.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      flags: { sideEffect: true },
      handler: (_i, ctx, host) => {
        if (settings(host).backend !== 'sandbox') return notSandboxed;
        return guarded(async () => {
          await sandbox().reset(session(ctx));
          return { text: 'the shell state is cleared' };
        });
      },
    },
  ];

  return definePlugin<ShellConfig>({
    displayName: 'Shell',
    start: (host) => {
      const s = settings(host);
      if (s.backend !== 'sandbox') return;
      client = new SandboxClient({
        socket: s.socket,
        onJobEnded: (e) => void report(host, e),
        log: (msg, fields) => host.log.info(msg, fields),
      });
      client.start();
    },
    stop: () => {
      client?.stop();
      client = null;
    },
    health: (host) => {
      // A sandbox that is down makes the tools fail with a reason; restarting this plugin would not bring it back.
      const problem = settings(host).backend === 'sandbox' ? client?.problem : null;
      return problem ? { ok: true, detail: `sandbox: ${problem}` } : { ok: true };
    },
    envPromptVars: (host) => {
      const s = settings(host);
      const sandboxed = s.backend === 'sandbox';
      return { sandboxed, workspace: sandboxed ? (client?.workspace ?? '/workspace') : workspaceOf(host), timeoutSec: s.timeoutSec, maxOutputKb: s.maxOutputKb };
    },
    tools,
  });
}
