import type { EventEnvelope, ForkInfo, StatusResponse } from '@protea/protocol';

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
    `usage 24h  ${u.calls} calls · ${u.inputTokens} in · ${u.outputTokens} out · cache read ${u.cacheReadTokens} / write ${u.cacheWriteTokens}` +
      `${u.cacheHitRatio === null ? '' : ` · hit ${(u.cacheHitRatio * 100).toFixed(1)}%`} · ~$${u.costUsd.toFixed(4)}`,
    `budget     ${Object.entries(s.budget.levels)
      .map(([l, b]) => `L${l} $${b.spentUsd.toFixed(2)}${b.limitUsd === null ? '' : `/${b.limitUsd.toFixed(2)}`}`)
      .join('  ')}${s.budget.enforced ? '' : dim('  (tracked, not enforced)')}`,
    `forks      ${s.forks.filter((f) => ['queued', 'running', 'paused'].includes(f.state)).length} active` +
      `${s.forks.length > 0 ? dim(` · latest ${(s.forks[0] as ForkInfo).id} ${(s.forks[0] as ForkInfo).state}`) : ''}`,
  ].join('\n');
}
