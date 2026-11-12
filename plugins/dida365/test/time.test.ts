import { describe, expect, it } from 'vitest';
import { dayOf, fromApiTime, fromStamp, instantOf, isTimeZone, minuteOf, parseRangeEnd, parseWhen, toApiTime, toStamp } from '../src/time.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('time helpers', () => {
  it('turns wall-clock times into instants, across clock changes', () => {
    expect(iso(instantOf({ year: 2026, month: 11, day: 13, hour: 15, minute: 0, second: 0 }, 'Asia/Shanghai'))).toBe('2026-11-13T07:00:00.000Z');
    // New York: daylight time from 2026-03-08, standard time from 2026-11-01.
    expect(iso(instantOf({ year: 2026, month: 3, day: 8, hour: 12, minute: 0, second: 0 }, 'America/New_York'))).toBe('2026-03-08T16:00:00.000Z');
    expect(iso(instantOf({ year: 2026, month: 11, day: 1, hour: 12, minute: 0, second: 0 }, 'America/New_York'))).toBe('2026-11-01T17:00:00.000Z');
    expect(iso(instantOf({ year: 2026, month: 3, day: 8, hour: 0, minute: 0, second: 0 }, 'America/New_York'))).toBe('2026-03-08T05:00:00.000Z');
    expect(isTimeZone('Asia/Shanghai')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('reads the three ways a time can be written', () => {
    expect(parseWhen('2026-11-13', 'Asia/Shanghai')).toEqual({ ms: Date.parse('2026-11-12T16:00:00Z'), dayOnly: true });
    expect(parseWhen('2026-11-13T15:00', 'Asia/Shanghai')).toEqual({ ms: Date.parse('2026-11-13T07:00:00Z'), dayOnly: false });
    expect(parseWhen('2026-11-13 15:00:30', 'UTC').ms).toBe(Date.parse('2026-11-13T15:00:30Z'));
    // An offset in the text wins over the zone.
    expect(parseWhen('2026-11-13T15:00:00+0800', 'UTC').ms).toBe(Date.parse('2026-11-13T07:00:00Z'));
    expect(parseWhen('2026-11-13T15:00:00-05:00', 'Asia/Shanghai').ms).toBe(Date.parse('2026-11-13T20:00:00Z'));
    expect(parseWhen('2026-11-13T07:00:00Z', 'Asia/Shanghai').ms).toBe(Date.parse('2026-11-13T07:00:00Z'));
    // The end of a range that names a day is the end of that day.
    expect(iso(parseRangeEnd('2026-11-13', 'UTC'))).toBe('2026-11-13T23:59:59.000Z');
    expect(iso(parseRangeEnd('2026-11-13T10:00', 'UTC'))).toBe('2026-11-13T10:00:00.000Z');
    for (const bad of ['tomorrow', '2026-02-30', '2026-13-01', '2026-11-13T25:00', '13/11/2026']) expect(() => parseWhen(bad, 'UTC'), bad).toThrow();
  });

  it("writes and reads the API's formats", () => {
    expect(toApiTime(Date.parse('2026-11-13T07:00:00.123Z'))).toBe('2026-11-13T07:00:00+0000');
    expect(fromApiTime('2019-11-13T03:00:00+0000')).toBe(Date.parse('2019-11-13T03:00:00Z'));
    expect(fromApiTime('2026-03-05T00:00:00.000+0000')).toBe(Date.parse('2026-03-05T00:00:00Z'));
    expect(fromApiTime('2026-04-07T09:00:00+0800')).toBe(Date.parse('2026-04-07T01:00:00Z'));
    expect(fromApiTime('')).toBeUndefined();
    expect(fromApiTime(null)).toBeUndefined();
    expect(dayOf(Date.parse('2026-11-12T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-13');
    expect(minuteOf(Date.parse('2026-11-12T16:05:00Z'), 'Asia/Shanghai')).toBe('2026-11-13 00:05');
    expect(toStamp('2026-04-07')).toBe(20260407);
    expect(toStamp('20260407')).toBe(20260407);
    expect(() => toStamp('April 7')).toThrow();
    expect(fromStamp(20260407)).toBe('2026-04-07');
    expect(fromStamp(undefined)).toBeUndefined();
  });
});
