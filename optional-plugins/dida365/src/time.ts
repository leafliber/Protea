/** Wall-clock reading of an instant in some time zone. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function wallClock(ms: number, tz: string): WallClock {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p['year'] ?? 0, month: p['month'] ?? 1, day: p['day'] ?? 1, hour: p['hour'] ?? 0, minute: p['minute'] ?? 0, second: p['second'] ?? 0 };
}

const asUtc = (w: WallClock): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** The instant at which the zone's clock shows `w`. A time skipped by a clock change lands just after it. */
export function instantOf(w: WallClock, tz: string): number {
  const naive = asUtc(w);
  const offsetAt = (ms: number): number => asUtc(wallClock(ms, tz)) - Math.floor(ms / 1000) * 1000;
  // Two passes: the offset at the first guess can be the one from the other side of a clock change.
  return naive - offsetAt(naive - offsetAt(naive));
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `2026-11-13` */
export function dayOf(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** `2026-11-13 15:00` */
export function minuteOf(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** The API's `yyyy-MM-dd'T'HH:mm:ssZ`, always written in UTC. */
export function toApiTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}+0000`;
}

/** Read a time the API returned (`2019-11-13T03:00:00+0000`, with or without milliseconds). */
export function fromApiTime(s: unknown): number | undefined {
  if (typeof s !== 'string' || s === '') return undefined;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? undefined : t;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function checked(w: WallClock, input: string): WallClock {
  const real = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (real.getUTCMonth() !== w.month - 1 || real.getUTCDate() !== w.day || w.hour > 23 || w.minute > 59 || w.second > 59) throw new Error(`"${input}" is not a real date or time`);
  return w;
}

/**
 * Read a time the model wrote: a day (`2026-11-13`), a wall-clock time in `tz` (`2026-11-13T15:00`),
 * or an instant with its own offset (`2026-11-13T15:00:00+08:00`, `...Z`).
 */
export function parseWhen(input: string, tz: string): { ms: number; dayOnly: boolean } {
  const s = input.trim();
  const day = DAY_RE.exec(s);
  if (day) return { ms: instantOf(checked({ year: Number(day[1]), month: Number(day[2]), day: Number(day[3]), hour: 0, minute: 0, second: 0 }, input), tz), dayOnly: true };
  const local = LOCAL_RE.exec(s);
  if (local) {
    const w = { year: Number(local[1]), month: Number(local[2]), day: Number(local[3]), hour: Number(local[4]), minute: Number(local[5]), second: Number(local[6] ?? 0) };
    return { ms: instantOf(checked(w, input), tz), dayOnly: false };
  }
  const t = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : Number.NaN;
  if (Number.isNaN(t)) throw new Error(`cannot read the time "${input}": write a day as 2026-11-13, a time as 2026-11-13T15:00, or an instant as 2026-11-13T15:00:00+08:00`);
  return { ms: t, dayOnly: false };
}

/** The end of a range: a plain day means the whole day. */
export function parseRangeEnd(input: string, tz: string): number {
  const w = parseWhen(input, tz);
  return w.dayOnly ? w.ms + DAY_MS - 1000 : w.ms;
}

/** `2026-04-07` (or `20260407`) to the API's integer day stamp `20260407`. */
export function toStamp(input: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(input.trim());
  if (!m) throw new Error(`cannot read the day "${input}": write it as 2026-04-07`);
  checked({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0 }, input);
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

/** The API's integer day stamp `20260407` as `2026-04-07`. */
export function fromStamp(stamp: unknown): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(stamp ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
