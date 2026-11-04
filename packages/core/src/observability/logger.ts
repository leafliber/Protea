import fs from 'node:fs';
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;
export type LogFormat = 'json' | 'pretty' | 'auto';

const LEVEL_NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const SKIP_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'run', 'component']);

/** Minimal human-readable formatter for terminals; the file log stays JSON. */
class PrettyStream {
  write(line: string): void {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stdout.write(line);
      return;
    }
    const time = new Date(Number(o['time'] ?? Date.now())).toISOString().slice(11, 19);
    const level = LEVEL_NAMES[Number(o['level'])] ?? String(o['level']);
    const comp = o['component'] ? `[${String(o['component'])}] ` : '';
    const extra = Object.entries(o)
      .filter(([k]) => !SKIP_KEYS.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    process.stdout.write(`${time} ${level.padEnd(5)} ${comp}${String(o['msg'] ?? '')}${extra ? ` ${extra}` : ''}\n`);
  }
}

export interface LoggerOptions {
  level?: string;
  format?: LogFormat;
  /** Also append JSON lines to this file (the run's log.jsonl). */
  file?: string;
  /** Extra destinations that get every line at debug level and above (the in-memory LogRing). */
  sinks?: Array<{ write(s: string): void }>;
  base?: Record<string, unknown>;
  /** Applied to every serialized line before any destination sees it (secret values). */
  redact?: (line: string) => string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const format = opts.format === 'auto' || opts.format === undefined ? (process.stdout.isTTY ? 'pretty' : 'json') : opts.format;
  const streams: { stream: { write(s: string): void }; level: pino.Level }[] = [];
  // "silent" quiets the terminal only; the run's file and in-memory sinks still get everything.
  if (level !== 'silent') streams.push({ stream: format === 'pretty' ? new PrettyStream() : process.stdout, level: level as pino.Level });
  if (opts.file) {
    streams.push({ stream: fs.createWriteStream(opts.file, { flags: 'a' }), level: 'debug' });
  }
  for (const sink of opts.sinks ?? []) streams.push({ stream: sink, level: 'debug' });
  if (streams.length === 0) return pino({ level: 'silent' });
  const redact = opts.redact;
  return pino(
    {
      level: 'debug',
      base: opts.base ?? {},
      timestamp: pino.stdTimeFunctions.epochTime,
      ...(redact
        ? {
            hooks: {
              streamWrite: (line: string) => {
                try {
                  return redact(line);
                } catch {
                  return line;
                }
              },
            },
          }
        : {}),
    },
    pino.multistream(streams),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
