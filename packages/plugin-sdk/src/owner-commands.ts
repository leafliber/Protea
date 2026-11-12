import type { PermissionMode, PermissionModeInfo } from '@protea/protocol';
import type { Host } from './plugin.js';

/** What the owner can type on any chat platform, so every connector understands the same words. */

export const DEFAULT_STOP_WORDS = ['stop', 'wait', '停', '停下', '等一下', '别说了'];

/** Whether the owner's whole message is a stop word (trailing punctuation does not count). */
export function isStopWord(text: string, words: readonly string[] = DEFAULT_STOP_WORDS): boolean {
  return words.map((w) => w.toLowerCase()).includes(text.trim().toLowerCase().replace(/[.!。！]+$/u, ''));
}

/** Split at paragraph or line breaks near the limit, so long replies stay readable. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

/** The reply to /mode. */
export function describeMode(i: PermissionModeInfo): string {
  const lines = [`Permission mode: ${i.mode}${i.override ? ` until ${i.override.until}, then ${i.baseline}` : ''}.`];
  if (i.paused) lines.push(`Auto is paused: ${i.paused.reason}. Send /mode auto to resume.`);
  if (i.mode === 'auto' || i.paused) {
    const { judge, since, allowed, held } = i.auto;
    lines.push(`Judge: ${judge.model}${judge.ready ? '' : ` (not ready: ${judge.problem ?? 'unknown'})`}.`, `Since ${since}: ${allowed} allowed, ${held} sent to you.`);
  }
  return lines.join('\n');
}

export function isModeCommand(text: string): boolean {
  return /^\/mode(\s|$)/i.test(text.trim());
}

/** "/mode", "/mode auto", "/mode auto 2h", "/mode bypass 30m". A bare number means minutes. */
export async function modeCommand<C>(host: Pick<Host<C>, 'permissions'>, senderKey: string, text: string): Promise<string> {
  const m = /^\/mode(?:\s+(ask|auto|bypass|locked)(?:\s+(\d+)\s*(m|min|h|hr)?)?)?\s*$/i.exec(text.trim());
  if (!m) return 'Usage: /mode, /mode ask|auto|locked [30m|2h], /mode bypass 30m';
  const mode = m[1]?.toLowerCase() as PermissionMode | undefined;
  const forMs = m[2] ? Number(m[2]) * (/^h/i.test(m[3] ?? '') ? 3_600_000 : 60_000) : undefined;
  try {
    return describeMode(await host.permissions.mode(senderKey, { ...(mode !== undefined ? { mode } : {}), ...(forMs !== undefined ? { forMs } : {}) }));
  } catch (err) {
    return `Could not change the mode: ${(err as Error).message}`;
  }
}

/**
 * "/approve a12", "/approve a12 1h" (also allows this tool family for an hour), "/deny a12". Null for anything else.
 * Connectors that show requests use `ApprovalInbox.reply`, which also understands buttons and plain words.
 */
export async function approvalCommand<C>(host: Pick<Host<C>, 'approvals'>, senderKey: string, text: string): Promise<string | null> {
  const cmd = /^\/(approve|deny)\s+(a\d+)(?:\s+(\d+)\s*(m|min|h|hr)?)?\s*$/i.exec(text.trim());
  if (!cmd) return null;
  const decision = (cmd[1] as string).toLowerCase() === 'approve' ? 'approve' : 'deny';
  // A bare number means minutes.
  const grantMs = cmd[3] && decision === 'approve' ? Number(cmd[3]) * (/^h/i.test(cmd[4] ?? '') ? 3_600_000 : 60_000) : undefined;
  const r = await host.approvals.decide(cmd[2] as string, decision, senderKey, grantMs !== undefined ? { grantMs } : {}).catch((err: Error) => ({ ok: false, message: err.message }));
  return r.ok ? `${cmd[2]} ${decision === 'approve' ? `approved${grantMs !== undefined ? ` (and its tools for ${cmd[3]}${cmd[4] ?? 'm'})` : ''}` : 'denied'}.` : `Could not ${decision} ${cmd[2]}: ${r.message ?? 'unknown error'}`;
}
