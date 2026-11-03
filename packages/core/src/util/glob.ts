/** `*` matches any run of characters, `?` one character; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

export function matchesAny(name: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}
