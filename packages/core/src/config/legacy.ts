import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** The key secret of the layout before provider profiles. */
export const LEGACY_ANTHROPIC_SECRET = 'ANTHROPIC_API_KEY';

const LEGACY_PROFILE_KEYS = ['baseUrl', 'models', 'effort', 'maxOutputTokens', 'timeoutMs', 'maxRetries', 'pricing'];
const LEGACY_ANTHROPIC_OPTIONS = ['fallbacks', 'thinkingDisplay', 'cacheTtl', 'thinkingMismatch'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

/**
 * Read the old layout (providers.default: anthropic | echo, providers.anthropic {…},
 * providers.echo {delayMs}) as provider profiles. Returns the providers section unchanged when
 * there is nothing old in it.
 */
export function upgradeLegacyProviders(providers: unknown): { providers: unknown; upgraded: boolean } {
  if (!isPlainObject(providers)) return { providers, upgraded: false };
  const hasOld = isPlainObject(providers['anthropic']) || isPlainObject(providers['echo']);
  const profiles: Record<string, unknown> = isPlainObject(providers['profiles']) ? { ...providers['profiles'] } : {};
  const oldDefault = providers['default'] === 'anthropic' && !('anthropic' in profiles);
  if (!hasOld && !oldDefault) return { providers, upgraded: false };
  const out: Record<string, unknown> = { ...providers };
  const a = isPlainObject(providers['anthropic']) ? providers['anthropic'] : null;
  if ((a || oldDefault) && !('anthropic' in profiles)) {
    const src = a ?? {};
    const options = pick(src, LEGACY_ANTHROPIC_OPTIONS);
    profiles['anthropic'] = {
      protocol: 'anthropic',
      ...pick(src, LEGACY_PROFILE_KEYS),
      apiKeySecret: typeof src['apiKeySecret'] === 'string' ? src['apiKeySecret'] : LEGACY_ANTHROPIC_SECRET,
      ...(Object.keys(options).length > 0 ? { anthropic: options } : {}),
    };
    if (out['default'] === undefined) out['default'] = 'anthropic'; // the old built-in default
  }
  const e = isPlainObject(providers['echo']) ? providers['echo'] : null;
  if (e && !('echo' in profiles)) profiles['echo'] = { protocol: 'echo', echo: pick(e, ['delayMs']) };
  delete out['anthropic'];
  delete out['echo'];
  out['profiles'] = profiles;
  return { providers: out, upgraded: true };
}

/**
 * At daemon start: rewrite an old providers section of config.yaml in the profile layout
 * (comments elsewhere in the file are kept), and give a key stored under the old secret name
 * (secrets/ANTHROPIC_API_KEY) its new name, PROVIDER_ANTHROPIC_API_KEY. A data volume that only
 * has that old key file and no providers gets an "anthropic" profile for it. Returns what was done.
 */
export function migrateLegacyProviders(dataDir: string, secretsDir: string): string[] {
  const done: string[] = [];
  const file = path.join(dataDir, 'config.yaml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) return done; // loadConfig reports the error
  const js = (doc.toJS() as Record<string, unknown> | null) ?? {};
  const before = js['providers'];
  const oldKeyFile = path.join(secretsDir, LEGACY_ANTHROPIC_SECRET);
  const newKeyName = 'PROVIDER_ANTHROPIC_API_KEY';
  const newKeyFile = path.join(secretsDir, newKeyName);
  let providers: Record<string, unknown> | null = null;
  const up = upgradeLegacyProviders(before);
  if (up.upgraded) {
    providers = up.providers as Record<string, unknown>;
    done.push('providers moved to the profile layout (providers.profiles)');
  } else if (fs.existsSync(oldKeyFile) && !isPlainObject(before)) {
    // Nothing configured, but the old key file is there: that was the default Claude setup.
    providers = { default: 'anthropic', profiles: { anthropic: { protocol: 'anthropic', apiKeySecret: LEGACY_ANTHROPIC_SECRET } } };
    done.push('added provider profile "anthropic" for the existing key');
  }
  if (!providers) return done;
  const profiles = providers['profiles'] as Record<string, Record<string, unknown>>;
  const anthropic = profiles['anthropic'];
  if (anthropic && anthropic['apiKeySecret'] === LEGACY_ANTHROPIC_SECRET && fs.existsSync(oldKeyFile) && !fs.existsSync(newKeyFile)) {
    fs.renameSync(oldKeyFile, newKeyFile);
    delete anthropic['apiKeySecret']; // the default name of profile "anthropic"
    done.push(`secret ${LEGACY_ANTHROPIC_SECRET} renamed to ${newKeyName}`);
  }
  doc.setIn(['providers'], providers);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, file);
  return done;
}
