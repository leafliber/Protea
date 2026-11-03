---
name: memory-hygiene
description: Tidy the memory directory — merge duplicate notes, archive stale ones, fold the week's journal into stable notes, and keep INDEX.md a short map. Use on a weekly maintenance schedule, when INDEX.md grows past about 60 lines, or when the owner says your notes are out of date.
metadata:
  version: 1
  level: 4
  requires-tools: memory memory_search
---

# Memory hygiene

Memory works only if you can find things again. The goal is fewer, better files, not more text.

## Rules of the layout
- `journal/` holds dated facts as they happened. Never rewrite past entries; only move conclusions out of them.
- `notes/` holds stable conclusions, one topic per file (people, projects, preferences). Each starts with a one-line summary.
- `INDEX.md` is a map: one line per note file, saying what is in it. No facts in INDEX.md beyond that line.
- `tasks.md` tracks open commitments; close items rather than deleting history silently.

## Procedure
1. `memory view` INDEX.md and the `notes/` listing. Note files that are missing from the index and index lines that point nowhere.
2. Read the journal since the last hygiene pass. For each fact that will still matter in a month, update the matching note (or create one). Keep the journal as it is.
3. Find overlaps with `memory_search` on each note's main subject. Merge duplicates into the older file, keep the facts, drop repetition.
4. Archive notes nobody has touched in months and that describe finished things: move them under `notes/archive/` and remove their index line.
5. Rewrite INDEX.md so every line is `- notes/<file>.md — <what it holds>`, grouped under a few headings, under about 60 lines.
6. Close finished items in tasks.md.

## Care
- Never delete information the owner gave you unless they asked; archive it.
- Do not record secrets, passwords or one-time codes anywhere in memory.
- When you are unsure whether two notes are the same thing, leave both and add a cross-reference.
- Finish with a two-line summary of what changed, kept in the journal; do not message the owner unless something needs them.
