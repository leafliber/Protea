import type { EventEnvelope, StatusResponse } from '@protea/protocol';

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
  ].join('\n');
}
