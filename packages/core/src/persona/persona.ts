import fs from 'node:fs';
import path from 'node:path';

export const PERSONA_FILES = ['SOUL.md', 'OPERATING.md', 'USER.md'] as const;

export interface PersonaFiles {
  dir: string;
  soul?: string;
  operating?: string;
  user?: string;
}

/** Copy the default persona into the data volume on first start; never overwrite afterwards. */
export function ensurePersona(personaDir: string, defaultDir: string): { created: boolean } {
  if (fs.existsSync(personaDir)) return { created: false };
  fs.mkdirSync(personaDir, { recursive: true });
  for (const f of PERSONA_FILES) {
    const src = path.join(defaultDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(personaDir, f));
  }
  return { created: true };
}

export function loadPersona(personaDir: string): PersonaFiles {
  const read = (f: string): string | undefined => {
    const p = path.join(personaDir, f);
    if (!fs.existsSync(p)) return undefined;
    const text = fs.readFileSync(p, 'utf8').trim();
    return text.length > 0 ? text : undefined;
  };
  const out: PersonaFiles = { dir: personaDir };
  const soul = read('SOUL.md');
  const operating = read('OPERATING.md');
  const user = read('USER.md');
  if (soul !== undefined) out.soul = soul;
  if (operating !== undefined) out.operating = operating;
  if (user !== undefined) out.user = user;
  return out;
}
