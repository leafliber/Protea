export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at the given instant, in minutes (east positive). */
export function tzOffsetMinutes(epochMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const base = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - base) / 60_000);
}

/** ISO 8601 with the zone's offset, second precision: 2026-11-03T09:12:03+08:00 */
export function isoInZone(epochMs: number, timeZone: string): string {
  const off = tzOffsetMinutes(epochMs, timeZone);
  const local = new Date(Math.floor(epochMs / 1000) * 1000 + off * 60_000).toISOString().slice(0, 19);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/**
 * Parse an ISO-like date-time. Strings with `Z` or an offset are absolute;
 * `YYYY-MM-DD[T ]HH:MM[:SS]` without an offset is read as local time in `timeZone`.
 */
export function parseDateTime(input: string, timeZone: string): number | null {
  const s = input.trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0));
  if (Number.isNaN(guess)) return null;
  const off1 = tzOffsetMinutes(guess, timeZone);
  let t = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(t, timeZone);
  if (off2 !== off1) t = guess - off2 * 60_000;
  return t;
}

/** The same instant written in `timeZone` (see isoInZone); a string that is not a date-time is returned unchanged. */
export function stampInZone(ts: string, timeZone: string): string {
  const t = parseDateTime(ts, timeZone);
  return t === null ? ts : isoInZone(t, timeZone);
}

export function defaultTimeZone(): string {
  return process.env['TZ'] || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
