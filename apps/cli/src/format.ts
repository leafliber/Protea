import type { ApprovalInfo, EventEnvelope, ForkInfo, McpServerStatus, McpToolInfo, PluginStatus, SkillInfo, StatusResponse } from '@protea/protocol';

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint('2');
export const bold = paint('1');
export const cyan = paint('36');
export const yellow = paint('33');
export const red = paint('31');
export const green = paint('32');

const LEVEL_COLOR = [red, yellow, cyan, (s: string) => s, dim];

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatEvent(e: EventEnvelope): string {
  const color = LEVEL_COLOR[e.effLevel] ?? ((s: string) => s);
  const who = e.senderRole === 'owner' ? ' owner' : e.senderRole === 'unknown' ? ` ${e.senderKey ?? '?'}` : '';
  return `${dim(`#${e.cursor}`)} ${color(`L${e.effLevel}`)} ${e.type}${dim(who)} ${dim(`[${e.state}/${e.effTrigger}]`)} ${oneLine(e.text)}`;
}

export function formatFork(f: ForkInfo): string {
  const state =
    f.state === 'completed' ? green(f.state) : f.state === 'failed' ? red(f.state) : f.state === 'running' ? cyan(f.state) : yellow(f.state);
  const why = f.pauseReason ? dim(` (${f.pauseReason})`) : f.error ? red(` ${oneLine(f.error, 80)}`) : '';
  return `${f.id} ${state}${why} L${f.level} ${f.model} ${dim(`${f.rounds} rounds`)}  ${oneLine(f.goal, 80)}`;
}

export function formatPlugin(p: PluginStatus): string {
  const state =
    p.state === 'running' ? green(p.state) : p.state === 'failed' || p.state === 'invalid' || p.state === 'crashed' ? red(p.state) : yellow(p.state);
  const meta = [p.origin, p.version ? `v${p.version}` : '', p.enabled ? 'enabled' : 'disabled', p.tools.length ? `${p.tools.length} tools` : '', p.pid ? `pid ${p.pid}` : '', p.restarts ? `${p.restarts} restarts` : '']
    .filter(Boolean)
    .join(' · ');
  return `${bold(p.id.padEnd(12))} ${state.padEnd(10)} ${dim(meta)}${p.error ? `\n${' '.repeat(13)}${red(oneLine(p.error, 160))}` : ''}`;
}

export function formatMcp(m: McpServerStatus): string {
  const state = m.state === 'running' ? green(m.state) : ['failed', 'crashed', 'auth_required'].includes(m.state) ? red(m.state) : yellow(m.state);
  const meta = [
    m.transport,
    m.enabled ? '' : 'disabled',
    `trust ${m.trust}`,
    `${m.tools.length} tools`,
    m.prompts ? `${m.prompts} prompts` : '',
    m.resources ? 'resources' : '',
    m.server ? `${m.server.name} ${m.server.version}` : '',
    m.pid ? `pid ${m.pid}` : '',
    m.restarts ? `${m.restarts} restarts` : '',
    m.avgLatencyMs !== undefined ? `~${m.avgLatencyMs} ms/call` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const extra = m.authorizeUrl ? `\n${' '.repeat(13)}${yellow(`authorize: ${m.authorizeUrl}`)}` : m.error ? `\n${' '.repeat(13)}${red(oneLine(m.error, 160))}` : '';
  return `${bold(m.id.padEnd(12))} ${state.padEnd(10)} ${dim(meta)}${extra}`;
}

export function formatMcpTool(t: McpToolInfo): string {
  const tags = [t.readOnly ? 'read-only' : '', t.destructive ? red('destructive') : '', t.filtered ? yellow('filtered') : ''].filter(Boolean).join(' ');
  return `${bold(t.name)}${tags ? ` ${tags}` : ''}\n  ${dim(oneLine(t.description, 160))}`;
}

export function formatSkill(k: SkillInfo): string {
  const state = k.errors.length ? red('invalid') : !k.enabled ? dim('disabled') : k.listed ? green('listed') : yellow('hidden');
  const meta = [k.origin + (k.owner ? `:${k.owner}` : ''), k.version ? `v${k.version}` : '', k.loads ? `${k.loads} loads` : '', !k.listed && k.requiresTools.length && k.enabled && !k.errors.length ? `needs ${k.requiresTools.join(' ')}` : '']
    .filter(Boolean)
    .join(' · ');
  const detail = k.errors.length ? red(k.errors.join('; ')) : dim(oneLine(k.description, 140));
  return `${bold(k.name.padEnd(18))} ${state.padEnd(9)} ${dim(meta)}\n${' '.repeat(19)}${detail}${k.warnings.length ? `\n${' '.repeat(19)}${yellow(k.warnings.join('; '))}` : ''}`;
}

export function formatApproval(a: ApprovalInfo): string {
  const state = a.state === 'pending' ? yellow(a.state) : a.state === 'approved' || a.state === 'used' ? green(a.state) : dim(a.state);
  return `${bold(a.id.padEnd(5))} ${state.padEnd(9)} ${oneLine(a.summary, 100)}${a.reason ? dim(` — ${oneLine(a.reason, 60)}`) : ''}${dim(`  (expires ${a.expiresAt}${a.decidedBy ? `, by ${a.decidedBy}` : ''})`)}`;
}

export function formatStatus(s: StatusResponse): string {
  const u = s.usage24h;
  const pending = Object.entries(s.pending)
    .map(([l, n]) => `L${l}=${n}`)
    .join(' ');
  return [
    `${bold('Protea')} ${s.version}  run ${s.runId}  up ${s.uptimeSec}s`,
    `phase      ${s.phase}${s.batchId ? ` (${s.batchId})` : ''}`,
    `pending    ${pending}`,
    `provider   ${s.provider.id}/${s.provider.mainModel} ${s.provider.ready ? green('ready') : red(`not ready: ${s.provider.problem ?? ''}`)}`,
    `plugins    ${s.plugins.map((p) => `${p.id}:${p.state === 'running' ? green(p.state) : red(p.state)}`).join('  ')}`,
    `mcp        ${s.mcp.length ? s.mcp.map((m) => `${m.id}:${m.state === 'running' ? green(m.state) : red(m.state)}`).join('  ') : dim('none')}`,
    `tools      ${s.tools.total}${s.tools.deferred ? ` (${s.tools.deferred} behind tool search)` : ''} · skills ${s.skills.listed} listed${s.skills.rejected ? red(` · ${s.skills.rejected} rejected`) : ''}`,
    `usage 24h  ${u.calls} calls · ${u.inputTokens} in · ${u.outputTokens} out · cache read ${u.cacheReadTokens} / write ${u.cacheWriteTokens}` +
      `${u.cacheHitRatio === null ? '' : ` · hit ${(u.cacheHitRatio * 100).toFixed(1)}%`} · ~$${u.costUsd.toFixed(4)}`,
    `budget     ${Object.entries(s.budget.levels)
      .map(([l, b]) => `L${l} $${b.spentUsd.toFixed(2)}${b.limitUsd === null ? '' : `/${b.limitUsd.toFixed(2)}`}`)
      .join('  ')}${s.budget.enforced ? '' : dim('  (tracked, not enforced)')}`,
    `forks      ${s.forks.filter((f) => ['queued', 'running', 'paused'].includes(f.state)).length} active` +
      `${s.forks.length > 0 ? dim(` · latest ${(s.forks[0] as ForkInfo).id} ${(s.forks[0] as ForkInfo).state}`) : ''}`,
  ].join('\n');
}
