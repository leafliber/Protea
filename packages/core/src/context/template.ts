/**
 * The three-rule template language for environment prompts:
 * {{var}} · {{#if var}}…{{/if}} · {{#each list}}…{{this}}…{{/each}}. Dotted paths are allowed.
 */
export type TemplateVars = Record<string, unknown>;

function lookup(vars: TemplateVars, path: string): unknown {
  let cur: unknown = vars;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  let out = tpl.replace(/\{\{#each ([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, name: string, body: string) => {
    const list = lookup(vars, name);
    if (!Array.isArray(list)) return '';
    return list.map((item) => renderTemplate(body, { ...vars, this: item })).join('');
  });
  out = out.replace(/\{\{#if ([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, name: string, body: string) =>
    truthy(lookup(vars, name)) ? body : '',
  );
  return out.replace(/\{\{([\w.]+)\}\}/g, (_, name: string) => {
    const v = lookup(vars, name);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
