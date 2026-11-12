import fs from 'node:fs';
import path from 'node:path';
import type { ChangeAction, PluginStatus, SkillInfo } from '@protea/protocol';
import { normalizeMcpServer, referencedSecrets, type McpServerSettings } from '../mcp/settings.js';
import { stableStringify } from '../permissions/policy.js';
import { MANIFEST_FILE, loadManifest } from '../plugins/manifest.js';
import { SKILL_NAME, parseSkillFile } from '../skills/parse.js';
import { fetchSource, type SourceSpec } from '../util/fetch-source.js';
import type { ChangeAdapter, PreparedChange } from './service.js';

const SECRET_REF = /^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/;
const MAX_INLINE_FILE_CHARS = 256 * 1024;
const MAX_INLINE_FILES = 40;
const SKILL_FILE = 'SKILL.md';

function pretty(v: unknown): string {
  return `${JSON.stringify(JSON.parse(stableStringify(v)), null, 2)}\n`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refuse(action: ChangeAction, allowed: readonly ChangeAction[], what: string): void {
  if (!allowed.includes(action)) throw new Error(`${action} is not something that can be proposed for ${what}; use one of: ${allowed.join(', ')}`);
}

/** A directory inside the workspace, by a path relative to it. Nothing outside it can be proposed. */
export function workspaceDir(workspace: string, rel: string): string {
  const root = fs.realpathSync(workspace);
  const asked = path.resolve(root, rel.replace(/^\/+/, ''));
  if (!fs.existsSync(asked) || !fs.statSync(asked).isDirectory()) throw new Error(`${rel} is not a directory in the workspace`);
  const real = fs.realpathSync(asked);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`${rel} is outside the workspace`);
  if (real === root) throw new Error('name a directory inside the workspace, not the workspace itself');
  return real;
}

/** Copy a tree into the stage; version-control directories stay behind. */
function stageTree(src: string, stageDir: string): void {
  fs.cpSync(src, stageDir, { recursive: true, filter: (p) => !['.git', 'node_modules/.cache'].includes(path.basename(p)) });
}

// —— MCP servers ——

export interface McpChangeDeps {
  /** The configured servers (`mcp.servers`), as normalized settings. */
  servers: () => Record<string, McpServerSettings>;
  put: (id: string, entry: Record<string, unknown> | null) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** One line on the server's state after a change (running with N tools, failed: …). */
  describe: (id: string) => string;
}

function checkMcpSecrets(entry: Record<string, unknown>): void {
  const auth = entry['auth'];
  if (isObject(auth)) {
    for (const key of ['token', 'clientSecret']) {
      const v = auth[key];
      if (v !== undefined && !(typeof v === 'string' && SECRET_REF.test(v))) {
        throw new Error(`auth.${key} must refer to a stored secret as \${secret:NAME}, not carry the value: ask the owner to store it (console → 配置 → 秘密) and name it here`);
      }
    }
  }
}

export function mcpChangeAdapter(d: McpChangeDeps): ChangeAdapter {
  const current = (id: string): McpServerSettings | undefined => d.servers()[id];
  return {
    prepare({ action, target, input }): PreparedChange {
      refuse(action, ['add', 'update', 'remove', 'enable', 'disable'], 'an MCP server');
      const cur = current(target);
      if (action === 'add' && cur) throw new Error(`the MCP server ${target} already exists; propose an update instead`);
      if (action !== 'add' && !cur) throw new Error(`there is no MCP server ${target}; configured: ${Object.keys(d.servers()).join(', ') || 'none'}`);
      const before = cur ? pretty(cur) : null;
      if (action === 'add' || action === 'update') {
        const entry = input['server'];
        if (!isObject(entry)) throw new Error('server is required: the whole entry as it would stand in mcp.servers (command and args, or url; env, auth, trust, tools, …)');
        checkMcpSecrets(entry);
        const settings = normalizeMcpServer(target, entry);
        const how = settings.transport === 'stdio' ? `${settings.command ?? ''} ${settings.args.join(' ')}`.trim() : (settings.url ?? '');
        return {
          target,
          summary: `${action} MCP server ${target} (${settings.transport}: ${how})`,
          before,
          after: pretty(settings),
          payload: { server: entry },
          secrets: referencedSecrets(settings).sort(),
          warnings: [
            ...(settings.transport === 'stdio' ? ['它是一条本地命令，会以守护进程的身份在容器里运行。'] : []),
            ...(settings.trust === 'high' ? ['trust: high —— 它的工具不经询问就能运行。'] : []),
          ],
        };
      }
      if (action === 'remove') return { target, summary: `remove MCP server ${target}`, before, after: null, payload: {} };
      const enabled = action === 'enable';
      if (cur?.enabled === enabled) throw new Error(`the MCP server ${target} is already ${enabled ? 'enabled' : 'disabled'}`);
      return { target, summary: `${action} MCP server ${target}`, before, after: pretty({ ...cur, enabled }), payload: {} };
    },
    snapshot: (target) => {
      const cur = current(target);
      return cur ? pretty(cur) : null;
    },
    async apply({ action, target, payload }): Promise<string> {
      if (action === 'add' || action === 'update') await d.put(target, payload['server'] as Record<string, unknown>);
      else if (action === 'remove') await d.put(target, null);
      else await d.setEnabled(target, action === 'enable');
      return action === 'remove' ? `the MCP server ${target} is removed.` : `the MCP server ${target} is ${d.describe(target)}.`;
    },
  };
}

// —— Skills ——

export interface SkillChangeDeps {
  get: (name: string) => SkillInfo | undefined;
  /** The directory a skill is read from, when it has one (not an MCP prompt). */
  dirOf: (name: string) => string | undefined;
  install: (srcDir: string) => SkillInfo;
  uninstall: (name: string) => void;
  setEnabled: (name: string, enabled: boolean) => void;
  workspace: string;
}

function safeRelative(rel: string): string[] {
  const parts = rel.split('/').filter((p) => p.length > 0);
  if (parts.length === 0 || path.isAbsolute(rel) || parts.some((p) => p === '..' || p === '.' || p.startsWith('.git'))) throw new Error(`invalid file path: ${rel}`);
  return parts;
}

export function skillChangeAdapter(d: SkillChangeDeps): ChangeAdapter {
  const source = (name: string): string | null => {
    const dir = d.dirOf(name);
    if (!dir) return null;
    try {
      return fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8');
    } catch {
      return null;
    }
  };
  const state = (name: string): string | null => {
    const info = d.get(name);
    if (!info) return null;
    return `${info.origin} ${info.enabled ? 'enabled' : 'disabled'}\n${source(name) ?? ''}`;
  };
  return {
    prepare({ action, target, input, stageDir }): PreparedChange {
      refuse(action, ['add', 'update', 'remove', 'enable', 'disable'], 'a skill');
      if (!SKILL_NAME.test(target)) throw new Error(`a skill name is lowercase letters, digits and hyphens (got ${target})`);
      const cur = d.get(target);
      if (cur?.origin === 'mcp') throw new Error(`${target} is a prompt of an MCP server, not a skill file; change the server instead`);
      if (action === 'add' && cur) throw new Error(`the skill ${target} already exists (${cur.origin}); propose an update instead`);
      if (action !== 'add' && !cur) throw new Error(`there is no skill ${target}`);
      const before = source(target);
      if (action === 'add' || action === 'update') {
        let from: string | undefined;
        if (typeof input['from'] === 'string' && input['from'].trim()) {
          from = workspaceDir(d.workspace, input['from'].trim());
          stageTree(from, stageDir);
        } else {
          if (typeof input['content'] !== 'string' || !input['content'].trim()) throw new Error('give the whole SKILL.md as content, or a workspace directory as from');
          const files = [{ path: SKILL_FILE, content: input['content'] }, ...((input['files'] as Array<{ path: string; content: string }> | undefined) ?? [])];
          if (files.length > MAX_INLINE_FILES) throw new Error(`too many files (${files.length}; at most ${MAX_INLINE_FILES}); put them in a workspace directory and use from`);
          const seen = new Set<string>();
          for (const f of files) {
            if (typeof f?.path !== 'string' || typeof f?.content !== 'string') throw new Error('each file needs a path and its content');
            if (f.content.length > MAX_INLINE_FILE_CHARS) throw new Error(`${f.path} is too long (${f.content.length} characters)`);
            const parts = safeRelative(f.path);
            const rel = parts.join('/');
            if (seen.has(rel)) throw new Error(`${rel} is given twice`);
            seen.add(rel);
            const dest = path.join(stageDir, ...parts);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, f.content);
          }
        }
        let text: string;
        try {
          text = fs.readFileSync(path.join(stageDir, SKILL_FILE), 'utf8');
        } catch {
          throw new Error(`there is no ${SKILL_FILE} in ${String(input['from'] ?? 'the files given')}`);
        }
        const parsed = parseSkillFile(text, target);
        if (!parsed.meta) throw new Error(`invalid skill: ${parsed.errors.join('; ')}`);
        const overrides = action === 'update' && cur && cur.origin !== 'user';
        return {
          target,
          summary: `${action} skill ${target}: ${parsed.meta.description.slice(0, 160)}`,
          before,
          after: text,
          payload: {},
          ...(from ? { source: `workspace:${path.relative(fs.realpathSync(d.workspace), from)}` } : {}),
          warnings: [...parsed.warnings, ...(overrides ? [`${target} 是${cur.origin === 'builtin' ? '内置' : '插件自带的'} skill：通过后会在数据卷里放一份覆盖它。`] : [])],
        };
      }
      if (action === 'remove') {
        if (cur?.origin !== 'user') throw new Error(`${target} is a ${cur?.origin} skill and cannot be removed; propose to disable it instead`);
        return { target, summary: `remove skill ${target}`, before, after: null, payload: {} };
      }
      const enabled = action === 'enable';
      if (cur?.enabled === enabled) throw new Error(`the skill ${target} is already ${enabled ? 'enabled' : 'disabled'}`);
      return { target, summary: `${action} skill ${target}`, before: null, after: null, payload: {} };
    },
    snapshot: (target) => state(target),
    apply({ action, target, stageDir }): string {
      if (action === 'add' || action === 'update') {
        const info = d.install(stageDir);
        if (info.errors.length > 0) throw new Error(`the skill was copied but is rejected: ${info.errors.join('; ')}`);
        return `the skill ${info.name} is installed${info.listed ? ' and listed' : info.enabled ? ', but not listed: it needs tools that are not available' : ', but disabled'}.`;
      }
      if (action === 'remove') {
        d.uninstall(target);
        return `the skill ${target} is removed.`;
      }
      d.setEnabled(target, action === 'enable');
      return `the skill ${target} is ${action === 'enable' ? 'enabled' : 'disabled'}.`;
    },
  };
}

// —— Plugins ——

export interface PluginChangeDeps {
  get: (id: string) => PluginStatus | undefined;
  /** Where an installed plugin lives (its manifest directory). */
  dirOf: (id: string) => string | undefined;
  install: (srcDir: string, opts: { enable: boolean }) => Promise<PluginStatus>;
  uninstall: (id: string, opts: { keepData: boolean }) => Promise<void>;
  enable: (id: string) => Promise<PluginStatus>;
  disable: (id: string) => Promise<PluginStatus>;
  config: (id: string) => Record<string, unknown>;
  setConfig: (id: string, config: Record<string, unknown>) => Promise<void>;
  workspace: string;
}

function pluginSource(d: PluginChangeDeps, raw: unknown): { spec: SourceSpec; label: string } {
  if (!isObject(raw)) throw new Error('source is required: { path } (a workspace directory), { git, ref? } or { tarball }, with an optional subdir');
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
  const subdir = str('subdir');
  const given = ['path', 'git', 'tarball'].filter((k) => str(k) !== undefined);
  if (given.length !== 1) throw new Error('source needs exactly one of path, git or tarball');
  if (str('path') !== undefined) {
    const dir = workspaceDir(d.workspace, str('path') as string);
    return { spec: { source: 'path', path: dir, ...(subdir ? { subdir } : {}) }, label: `workspace:${path.relative(fs.realpathSync(d.workspace), dir)}${subdir ? `/${subdir}` : ''}` };
  }
  const url = (str('git') ?? str('tarball')) as string;
  // What the assistant proposes is fetched before anyone has looked at it: only plain https.
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(url)) throw new Error('a git or tarball source must be an https:// URL');
  if (str('git') !== undefined) {
    const ref = str('ref');
    return { spec: { source: 'git', url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) }, label: `git ${url}${ref ? `@${ref}` : ''}${subdir ? ` /${subdir}` : ''}` };
  }
  return { spec: { source: 'tarball', url, ...(subdir ? { subdir } : {}) }, label: `tarball ${url}${subdir ? ` /${subdir}` : ''}` };
}

export function pluginChangeAdapter(d: PluginChangeDeps): ChangeAdapter {
  const manifestText = (id: string): string | null => {
    const dir = d.dirOf(id);
    if (!dir) return null;
    try {
      return fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    } catch {
      return null;
    }
  };
  const state = (id: string, action: ChangeAction): string | null => {
    const p = d.get(id);
    if (!p) return null;
    const head = `${p.origin} ${p.enabled ? 'enabled' : 'disabled'} ${p.version ?? ''}`;
    return action === 'configure' ? `${head}\n${pretty(d.config(id))}` : `${head}\n${manifestText(id) ?? ''}`;
  };
  return {
    async prepare({ action, target, input, stageDir, signal }): Promise<PreparedChange> {
      refuse(action, ['add', 'update', 'remove', 'enable', 'disable', 'configure'], 'a plugin');
      if (action === 'add' || action === 'update') {
        const { spec, label } = pluginSource(d, input['source']);
        const fetched = await fetchSource(spec, signal ? { signal } : {});
        try {
          stageTree(fetched.dir, stageDir);
        } finally {
          fetched.cleanup();
        }
        const loaded = loadManifest(stageDir, 'data');
        if (loaded.errors.length > 0 || !loaded.manifest) throw new Error(`invalid plugin: ${loaded.errors.join('; ')}`);
        const m = loaded.manifest;
        if (target && target !== m.id) throw new Error(`the manifest says the plugin is ${m.id}, not ${target}`);
        const cur = d.get(m.id);
        if (cur?.origin === 'inproc') throw new Error(`${m.id} is part of Protea itself and cannot be replaced`);
        if (action === 'add' && cur?.origin === 'data') throw new Error(`the plugin ${m.id} is already installed; propose an update instead`);
        if (action === 'update' && cur?.origin !== 'data') throw new Error(`the plugin ${m.id} is not installed in the data volume; propose to install it instead`);
        const raw = m as unknown as Record<string, unknown>;
        const tools = Array.isArray(raw['tools']) ? raw['tools'] : [];
        return {
          target: m.id,
          summary: `${action === 'add' ? 'install' : 'update'} plugin ${m.id}${m.version ? ` ${m.version}` : ''} (${m.kind}${tools.length > 0 ? `, ${tools.length} tools` : ''})`,
          before: manifestText(m.id),
          after: fs.readFileSync(path.join(stageDir, MANIFEST_FILE), 'utf8'),
          payload: {},
          source: label,
          warnings: ['安装插件等于让它的代码在守护进程旁边运行：请看过文件再同意。', ...loaded.warnings, ...(action === 'add' && cur?.origin === 'builtin' ? [`${m.id} 是内置插件：通过后数据卷里的这一份会取代它。`] : [])],
        };
      }
      const cur = d.get(target);
      if (!cur) throw new Error(`there is no plugin ${target}`);
      if (action === 'remove') {
        if (cur.origin !== 'data') throw new Error(`${target} is a ${cur.origin} plugin and cannot be removed; propose to disable it instead`);
        return { target, summary: `remove plugin ${target}${cur.enabled ? ' (it is disabled first)' : ''}`, before: manifestText(target), after: null, payload: {} };
      }
      if (action === 'configure') {
        const config = input['config'];
        if (!isObject(config)) throw new Error('config is required: the whole configuration object of the plugin');
        return { target, summary: `configure plugin ${target}`, before: pretty(d.config(target)), after: pretty(config), payload: { config } };
      }
      const enabled = action === 'enable';
      if (cur.enabled === enabled) throw new Error(`the plugin ${target} is already ${enabled ? 'enabled' : 'disabled'}`);
      return { target, summary: `${action} plugin ${target}`, before: null, after: null, payload: {} };
    },
    snapshot: (target, action) => state(target, action),
    async apply({ action, target, payload, stageDir }): Promise<string> {
      const after = (): string => {
        const p = d.get(target);
        return p ? `${p.enabled ? p.state : 'disabled'}${p.error ? ` (${p.error})` : ''}` : 'gone';
      };
      if (action === 'add') {
        await d.install(stageDir, { enable: true });
        return `the plugin ${target} is installed and ${after()}.`;
      }
      if (action === 'update') {
        const was = d.get(target);
        const config = d.config(target);
        if (was?.enabled) await d.disable(target);
        await d.uninstall(target, { keepData: true });
        await d.install(stageDir, { enable: false });
        if (Object.keys(config).length > 0) await d.setConfig(target, config);
        if (was?.enabled) await d.enable(target);
        return `the plugin ${target} is updated and ${after()}.`;
      }
      if (action === 'remove') {
        if (d.get(target)?.enabled) await d.disable(target);
        await d.uninstall(target, { keepData: false });
        return `the plugin ${target} is removed.`;
      }
      if (action === 'configure') {
        await d.setConfig(target, payload['config'] as Record<string, unknown>);
        return `the plugin ${target} has its new configuration and is ${after()}.`;
      }
      if (action === 'enable') await d.enable(target);
      else await d.disable(target);
      return `the plugin ${target} is ${after()}.`;
    },
  };
}
