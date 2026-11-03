import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate, type TemplateVars } from './template.js';

/**
 * Resolve a plugin's ENV_PROMPT.md through three layers, later replacing earlier:
 * the plugin's own file → <persona>/plugins/<id>/ENV_PROMPT.md → <data>/overrides/plugins/<id>/ENV_PROMPT.md.
 */
export function loadEnvPromptTemplate(
  pluginId: string,
  builtin: string | undefined,
  dirs: { personaDir: string; overridesDir: string },
): string | undefined {
  const layers = [
    path.join(dirs.overridesDir, 'plugins', pluginId, 'ENV_PROMPT.md'),
    path.join(dirs.personaDir, 'plugins', pluginId, 'ENV_PROMPT.md'),
  ];
  for (const file of layers) if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (builtin && fs.existsSync(builtin)) return fs.readFileSync(builtin, 'utf8');
  return undefined;
}

export function renderEnvPrompt(template: string | undefined, vars: TemplateVars | null): string | undefined {
  if (template === undefined || vars === null) return undefined;
  const text = renderTemplate(template, vars).trim();
  return text.length > 0 ? text : undefined;
}
