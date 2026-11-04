import fs from 'node:fs';
import path from 'node:path';
import type { Bus, BusTopic } from '../bus.js';

const CLIP = 2_000;

/** The last bus records, kept for crash reports (docs/10-architecture/15-observability.md §4). */
export class BusTrail {
  private readonly records: Array<{ at: string; topic: BusTopic; data: string }> = [];
  private readonly off: () => void;

  constructor(bus: Bus, readonly size = 200) {
    this.off = bus.tap((topic, data) => {
      let text: string;
      try {
        text = JSON.stringify(data) ?? 'undefined';
      } catch {
        text = '[unserializable]';
      }
      this.records.push({ at: new Date().toISOString(), topic, data: text.length > CLIP ? `${text.slice(0, CLIP)}…` : text });
      if (this.records.length > this.size) this.records.shift();
    });
  }

  recent(): Array<{ at: string; topic: BusTopic; data: string }> {
    return [...this.records];
  }

  close(): void {
    this.off();
  }
}

/**
 * Write <runDir>/crash/<time>.json: the error and the recent bus records. Synchronous, so it
 * works from an uncaughtException handler. Returns the file, or null if it could not be written.
 */
export function writeCrashReport(runDir: string, err: unknown, trail: BusTrail | null, extra: Record<string, unknown> = {}): string | null {
  try {
    const dir = path.join(runDir, 'crash');
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date();
    const file = path.join(dir, `${at.toISOString().replace(/[:.]/g, '-')}.json`);
    const e = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { message: String(err) };
    fs.writeFileSync(file, `${JSON.stringify({ at: at.toISOString(), error: e, ...extra, recentBus: trail?.recent() ?? [] }, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

/** Write <runDir>/shutdown.json atomically. */
export function writeShutdownReport(runDir: string, report: Record<string, unknown>): void {
  const file = path.join(runDir, 'shutdown.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}
