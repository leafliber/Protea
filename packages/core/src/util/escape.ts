/** Neutralise only the sequences that would break the structure of a request; the text is otherwise untouched. */
export function escapeStructural(text: string): string {
  return text.replace(/<(\/?)(events?|status|board|handoff_notes|memory_file|memory_index)\b/gi, '&lt;$1$2');
}
