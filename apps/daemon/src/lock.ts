import fs from 'node:fs';
import path from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Single-instance lock on the data directory (a pid file). Stale locks from dead processes are taken over. */
export function acquireLock(dataDir: string): { release(): void } {
  const file = path.join(dataDir, 'protea.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(`another Protea daemon (pid ${pid}) is using ${dataDir}; if that is wrong, delete ${file}`);
    }
  }
  fs.writeFileSync(file, `${process.pid}\n`);
  return {
    release() {
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}
