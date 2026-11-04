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

/** Rotated names: log.jsonl → log.1.jsonl, log.2.jsonl, … (newest first). */
export function rotatedLogName(file: string, i: number): string {
  return file.endsWith('.jsonl') ? `${file.slice(0, -'.jsonl'.length)}.${i}.jsonl` : `${file}.${i}`;
}

/**
 * Appends lines to `file`. Past `maxBytes` the file becomes file.1 (older ones shift up and only
 * `keep` are kept) and a new file starts, so one long run cannot fill the volume.
 */
export class RotatingFile {
  private stream: fs.WriteStream;
  private bytes: number;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 0,
    private readonly keep = 4,
  ) {
    this.stream = RotatingFile.open(file);
    this.bytes = fs.statSync(file).size;
  }

  /** Opened synchronously, so the file exists (and can be renamed) from the first write on. */
  private static open(file: string): fs.WriteStream {
    return fs.createWriteStream(file, { fd: fs.openSync(file, 'a') });
  }

  write(line: string): void {
    this.stream.write(line);
    this.bytes += Buffer.byteLength(line);
    if (this.maxBytes > 0 && this.bytes >= this.maxBytes) this.rotate();
  }

  private rotate(): void {
    // Writes still queued on the old stream land in the renamed file (same descriptor).
    this.stream.end();
    try {
      fs.rmSync(rotatedLogName(this.file, this.keep), { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = rotatedLogName(this.file, i);
        if (fs.existsSync(from)) fs.renameSync(from, rotatedLogName(this.file, i + 1));
      }
      if (this.keep > 0) fs.renameSync(this.file, rotatedLogName(this.file, 1));
      else fs.rmSync(this.file, { force: true });
    } catch {
      // Logging goes on in a fresh file whatever happened to the old one.
    }
    this.stream = RotatingFile.open(this.file);
    this.bytes = 0;
  }
}

export interface LoggerOptions {
  level?: string;
  format?: LogFormat;
  /** Also append JSON lines to this file (the run's log.jsonl). */
  file?: string;
  /** Rotate the file past this size (0 = never) and keep this many rotated files. */
  fileMaxBytes?: number;
  fileKeep?: number;
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
    streams.push({ stream: new RotatingFile(opts.file, opts.fileMaxBytes ?? 0, opts.fileKeep ?? 4), level: 'debug' });
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
