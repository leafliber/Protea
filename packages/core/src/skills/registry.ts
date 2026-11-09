import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo } from '@protea/protocol';
import type { KvNamespace } from '../db/repos.js';
import type { Logger } from '../observability/logger.js';
import type { ToolOutcome } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import { globToRegExp } from '../util/glob.js';
import type { Clock } from '../util/time.js';
import { estimateTokens } from '../util/tokens.js';
import { BODY_TOKEN_WARN, parseSkillFile, type SkillMeta } from './parse.js';

export type SkillOrigin = SkillInfo['origin'];

export interface SkillRoot {
  dir: string;
  origin: 'builtin' | 'user' | 'plugin';
  /** The plugin that ships the skills (origin plugin). */
  owner?: string;
}

/** An MCP prompt, offered as a read-only skill `mcp:<server>/<prompt>`. */
export interface PromptSkill {
  server: string;
  prompt: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface PromptSource {
  prompts(): PromptSkill[];
  render(server: string, prompt: string, args: Record<string, string>, signal: AbortSignal): Promise<string>;
}

export interface SkillRegistryOptions {
  /** Scanned in order; a later root overrides a skill of the same name from an earlier one. */
  roots: () => SkillRoot[];
  /** Where installed skills go (the user root). */
  userDir: string;
  disabled: () => ReadonlySet<string>;
  mcpPrompts: () => boolean;
  /** Names of the tools that exist now (for `metadata.requires-tools`). */
  toolNames: () => string[];
  prompts?: PromptSource;
  kv: KvNamespace;
  log: Logger;
  clock: Clock;
  /** The catalog text changed (rebuild the system prefix at the next turn boundary). */
  onChanged?: (names: string[]) => void;
}

interface Entry {
  key: string;
  info: SkillInfo;
  meta?: SkillMeta;
  dir?: string;
  hash: string;
  prompt?: PromptSkill;
}

interface LoadRecord {
  callId: string;
  hash: string;
}

const MAX_FILES_LISTED = 100;
const MAX_READ_BYTES = 256 * 1024;

function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Skills: scanning, validation, the catalog segment, and `skill_load` / `skill_read`
 * (docs/10-architecture/10-skills.md). Progressive disclosure: the catalog lists names and
 * descriptions, the body enters the history only when the model loads the skill.
 */
export class SkillRegistry {
  private entries = new Map<string, Entry>();
  /** Directories that hold no valid skill, with the reason (shown to the operator). */
  private rejected: SkillInfo[] = [];
  private catalogText: string | null = null;
  private lastCatalogKey = '';
  /** Per session: skills already loaded, so a repeat load does not paste the body again. */
  private readonly loaded = new Map<string, Map<string, LoadRecord>>();

  constructor(private readonly o: SkillRegistryOptions) {
    const saved = o.kv.get<Record<string, LoadRecord>>('loaded:main');
    if (saved) this.loaded.set('main', new Map(Object.entries(saved)));
  }

  /** Re-read every root. Returns true when the catalog changed. */
  rescan(): boolean {
    const next = new Map<string, Entry>();
    const rejected: SkillInfo[] = [];
    const stats = this.o.kv.get<Record<string, { loads: number; lastAt: string }>>('stats') ?? {};
    for (const root of this.o.roots()) {
      let names: string[];
      try {
        names = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
      } catch {
        continue; // a missing root is fine
      }
      for (const dirName of names.sort()) {
        const dir = path.join(root.dir, dirName);
        const base = { origin: root.origin, ...(root.owner ? { owner: root.owner } : {}) } as const;
        const file = path.join(dir, 'SKILL.md');
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          // Plugin skill roots may hold other directories; elsewhere a skill directory needs SKILL.md.
          if (root.origin !== 'plugin') rejected.push(this.rejectedInfo(dirName, base, ['SKILL.md is missing']));
          continue;
        }
        const parsed = parseSkillFile(text, dirName);
        if (!parsed.meta) {
          rejected.push(this.rejectedInfo(dirName, base, parsed.errors, parsed.warnings));
          continue;
        }
        const meta = parsed.meta;
        const warnings = [...parsed.warnings];
        const prev = next.get(meta.name);
        if (prev) warnings.push(`overrides the ${prev.info.origin} skill of the same name`);
        const s = stats[meta.name];
        next.set(meta.name, {
          key: meta.name,
          meta,
          dir,
          hash: hashOf(text),
          info: {
            name: meta.name,
            description: meta.description,
            ...base,
            ...(meta.version ? { version: meta.version } : {}),
            enabled: true,
            listed: true,
            errors: [],
            warnings,
            allowedTools: meta.allowedTools,
            requiresTools: meta.requiresTools,
            ...(meta.level ? { level: meta.level } : {}),
            loads: s?.loads ?? 0,
            ...(s?.lastAt ? { lastLoadedAt: s.lastAt } : {}),
          },
        });
      }
    }
    if (this.o.prompts && this.o.mcpPrompts()) {
      for (const p of this.o.prompts.prompts()) {
        const name = `mcp:${p.server}/${p.prompt}`;
        const s = stats[name];
        next.set(name, {
          key: name,
          prompt: p,
          hash: hashOf(JSON.stringify(p)),
          info: {
            name,
            description: p.description || `Prompt ${p.prompt} of the MCP server ${p.server}.`,
            origin: 'mcp',
            owner: p.server,
            enabled: true,
            listed: true,
            errors: [],
            warnings: [],
            allowedTools: [],
            requiresTools: [],
            loads: s?.loads ?? 0,
            ...(s?.lastAt ? { lastLoadedAt: s.lastAt } : {}),
          },
        });
      }
    }
    for (const r of rejected) this.o.log.warn({ skill: r.name, origin: r.origin, errors: r.errors }, 'skill rejected');
    this.entries = next;
    this.rejected = rejected;
    return this.refreshCatalog();
  }

  /** Recompute which skills are listed (disabled names, required tools). Returns true when the catalog changed. */
  refreshCatalog(): boolean {
    const disabled = this.o.disabled();
    const tools = this.o.toolNames();
    const lines: string[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      e.info.enabled = !disabled.has(e.key);
      const missing = e.info.requiresTools.filter((g) => !tools.some((t) => globToRegExp(g).test(t)));
      e.info.listed = e.info.enabled && missing.length === 0;
      if (e.info.listed) lines.push(`- ${e.key}: ${flat(e.info.description)} (source: ${e.info.origin})`);
    }
    const key = lines.join('\n');
    if (key === this.lastCatalogKey && this.catalogText !== null) return false;
    const changed = key !== this.lastCatalogKey;
    this.lastCatalogKey = key;
    this.catalogText =
      lines.length === 0
        ? ''
        : [
            '# Skills',
            '',
            "Skills are instructions for particular kinds of work. When a task matches a skill's description, call skill_load with its name before you start and follow what it says. Files a skill refers to can be read with skill_read.",
            '',
            ...lines,
          ].join('\n');
    if (changed) this.o.onChanged?.(this.listedNames());
    return changed;
  }

  /** The `skills-catalog` segment, or null when no skill is listed. */
  catalog(): string | null {
    if (this.catalogText === null) this.rescan();
    return this.catalogText || null;
  }

  listedNames(): string[] {
    return [...this.entries.values()].filter((e) => e.info.listed).map((e) => e.key).sort();
  }

  /** Every skill, then the rejected directories (with their errors). */
  list(): SkillInfo[] {
    const ok = [...this.entries.values()].map((e) => e.info).sort((a, b) => (a.name < b.name ? -1 : 1));
    return [...ok, ...this.rejected];
  }

  get(name: string): (SkillInfo & { body?: string; files?: Array<{ path: string; bytes: number }> }) | undefined {
    const e = this.entries.get(name);
    if (!e) return this.rejected.find((r) => r.name === name);
    if (!e.dir) return e.info;
    const parsed = this.readBody(e);
    return { ...e.info, ...(parsed !== null ? { body: parsed } : {}), files: this.files(e.dir) };
  }

  /** `skill_load`: the body (or the rendered MCP prompt) as a tool result. */
  async load(name: string, opts: { sessionId: string; callId: string; arguments?: Record<string, string>; signal: AbortSignal }): Promise<ToolOutcome> {
    const e = this.entries.get(name);
    if (!e) {
      const bad = this.rejected.find((r) => r.name === name);
      if (bad) return { text: `Skill ${name} is invalid: ${bad.errors.join('; ')}`, failed: true };
      const listed = this.listedNames();
      return { text: `Unknown skill ${name}.${listed.length ? ` Available: ${listed.join(', ')}.` : ' No skills are installed.'}`, failed: true };
    }
    if (!e.info.enabled) return { text: `Skill ${name} is disabled.`, failed: true };
    let text: string;
    let hash = e.hash;
    if (e.prompt) {
      const p = e.prompt;
      const args = opts.arguments ?? {};
      const missing = p.arguments.filter((a) => a.required && args[a.name] === undefined).map((a) => a.name);
      if (missing.length > 0) {
        const params = p.arguments.map((a) => `${a.name}${a.required ? ' (required)' : ''}${a.description ? `: ${a.description}` : ''}`);
        return { text: `Skill ${name} needs arguments: ${missing.join(', ')}. Parameters:\n${params.join('\n')}`, failed: true };
      }
      if (!this.o.prompts) return { text: `MCP prompts are not available`, failed: true };
      try {
        const rendered = await this.o.prompts.render(p.server, p.prompt, args, opts.signal);
        text = `# Skill: ${name} (mcp prompt)\n${rendered}`;
      } catch (err) {
        return { text: `Skill ${name}: the MCP server could not render the prompt: ${errorMessage(err)}`, failed: true };
      }
      hash = hashOf(text);
    } else {
      const body = this.readBody(e);
      if (body === null) return { text: `Skill ${name}: SKILL.md could not be read`, failed: true };
      hash = hashOf(body);
      const seen = this.loaded.get(opts.sessionId)?.get(name);
      if (seen && seen.hash === hash) {
        this.recordLoad(name);
        return { text: `Skill ${name} is already loaded in this session (tool call ${seen.callId}); follow the instructions there.` };
      }
      const version = e.info.version ? `, v${e.info.version}` : '';
      const parts = [`# Skill: ${name} (${e.info.origin}${version})${seen ? ' — updated since it was last loaded' : ''}`, body.trimEnd()];
      const files = this.files(e.dir as string);
      if (files.length > 0) {
        parts.push('', '## Files', ...files.map((f) => `${f.path} (${formatSize(f.bytes)})`), '', `Read these with skill_read {"name": "${name}", "path": "<file>"}.`);
      }
      if (e.info.allowedTools.length > 0) parts.push('', `Suggested tools: ${e.info.allowedTools.join(', ')}`);
      const tokens = estimateTokens(body);
      if (tokens > BODY_TOKEN_WARN) parts.push('', `[warning: this skill is about ${tokens} tokens; its author should move details into references/]`);
      text = parts.join('\n');
    }
    const session = this.loaded.get(opts.sessionId) ?? new Map<string, LoadRecord>();
    session.set(name, { callId: opts.callId, hash });
    this.loaded.set(opts.sessionId, session);
    if (opts.sessionId === 'main') this.o.kv.set('loaded:main', Object.fromEntries(session));
    this.recordLoad(name);
    return { text };
  }

  /** `skill_read`: a file inside a skill directory. */
  read(name: string, rel: string): ToolOutcome {
    const e = this.entries.get(name);
    if (!e || !e.dir) return { text: e ? `Skill ${name} has no files (it is an MCP prompt)` : `Unknown skill ${name}`, failed: true };
    const root = fs.realpathSync(e.dir);
    const target = path.resolve(root, rel);
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      return { text: `${rel}: no such file in skill ${name}`, failed: true };
    }
    if (real !== root && !real.startsWith(root + path.sep)) return { text: `${rel} is outside the skill directory`, failed: true };
    const st = fs.statSync(real);
    if (st.isDirectory()) {
      const files = this.files(real).map((f) => `${f.path} (${formatSize(f.bytes)})`);
      return { text: files.length ? files.join('\n') : '(empty directory)' };
    }
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.includes(0)) return { text: `${rel} is a binary file (${formatSize(st.size)}); it cannot be shown as text`, failed: true };
      const more = st.size > MAX_READ_BYTES ? `\n[truncated: ${formatSize(st.size - MAX_READ_BYTES)} more]` : '';
      return { text: buf.toString('utf8') + more };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** The model's view of loaded skills starts over (a new transcript, e.g. after a handoff). */
  resetSession(sessionId: string): void {
    this.loaded.delete(sessionId);
    if (sessionId === 'main') this.o.kv.delete('loaded:main');
  }

  /** Copy a skill directory into the user root (staging + rename, so the watcher never sees half a copy). */
  install(srcDir: string): SkillInfo {
    const src = path.resolve(srcDir);
    let text: string;
    try {
      text = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8');
    } catch {
      throw new Error(`${src} has no SKILL.md`);
    }
    // The installed directory is named after the skill, whatever the source directory is called.
    const parsed = parseSkillFile(text, null);
    if (!parsed.meta) throw new Error(`invalid skill: ${parsed.errors.join('; ')}`);
    const name = parsed.meta.name;
    fs.mkdirSync(this.o.userDir, { recursive: true });
    const dest = path.join(this.o.userDir, name);
    const staging = path.join(this.o.userDir, `.install-${crypto.randomBytes(4).toString('hex')}`);
    fs.cpSync(src, staging, { recursive: true, filter: (p) => !path.basename(p).startsWith('.git') });
    if (fs.existsSync(dest)) {
      const trash = path.join(this.o.userDir, `.trash-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(dest, trash);
      fs.renameSync(staging, dest);
      fs.rmSync(trash, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, dest);
    }
    this.rescan();
    return this.entries.get(name)?.info ?? this.rejectedInfo(name, { origin: 'user' }, ['not found after install']);
  }

  /** Remove a skill from the user root. */
  uninstall(name: string): void {
    const e = this.entries.get(name);
    if (!e || e.info.origin !== 'user' || !e.dir) throw new Error(`${name} is not an installed user skill`);
    fs.rmSync(e.dir, { recursive: true, force: true });
    this.rescan();
  }

  private readBody(e: Entry): string | null {
    if (!e.dir) return null;
    try {
      return parseSkillFile(fs.readFileSync(path.join(e.dir, 'SKILL.md'), 'utf8'), path.basename(e.dir)).body;
    } catch {
      return null;
    }
  }

  private files(dir: string): Array<{ path: string; bytes: number }> {
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = (d: string, prefix: string): void => {
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (out.length >= MAX_FILES_LISTED || it.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(d, it.name), rel);
        else if (it.isFile() && rel !== 'SKILL.md') out.push({ path: rel, bytes: fs.statSync(path.join(d, it.name)).size });
      }
    };
    walk(dir, '');
    return out;
  }

  private recordLoad(name: string): void {
    const stats = this.o.kv.get<Record<string, { loads: number; lastAt: string }>>('stats') ?? {};
    const at = new Date(this.o.clock.now()).toISOString();
    stats[name] = { loads: (stats[name]?.loads ?? 0) + 1, lastAt: at };
    this.o.kv.set('stats', stats);
    const e = this.entries.get(name);
    if (e) {
      e.info.loads = stats[name].loads;
      e.info.lastLoadedAt = at;
    }
  }

  private rejectedInfo(name: string, base: { origin: SkillInfo['origin']; owner?: string }, errors: string[], warnings: string[] = []): SkillInfo {
    return { name, description: '', ...base, enabled: false, listed: false, errors, warnings, allowedTools: [], requiresTools: [], loads: 0 };
  }
}
