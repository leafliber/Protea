/** Example Protea plugin in TypeScript; the same behaviour as examples/plugins/py-notes. */
import { definePlugin, runPlugin } from '@protea/plugin-sdk';

runPlugin(
  definePlugin({
    displayName: 'Notes (TypeScript example)',
    tools: [
      {
        name: 'tsn_add',
        description: 'Add a note.',
        inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
        handler: async (i: { text: string }, _ctx, host) => {
          const notes = [...((await host.kv.get<string[]>('notes')) ?? []), i.text];
          await host.kv.set('notes', notes);
          const r = await host.events.push({
            type: 'ts-notes.added',
            ts: new Date().toISOString(),
            level: 4,
            trigger: 'piggyback',
            text: `Note added: ${i.text}`,
            dedupeKey: `note-${notes.length}`,
          });
          return `added note ${notes.length} (event #${r.cursor})`;
        },
      },
      {
        name: 'tsn_list',
        description: 'List the notes.',
        inputSchema: { type: 'object' },
        flags: { readOnly: true },
        handler: async (_i, _ctx, host) => ((await host.kv.get<string[]>('notes')) ?? []).map((t, n) => `${n + 1}. ${t}`).join('\n') || 'no notes',
      },
      {
        name: 'tsn_wait',
        description: 'Wait up to `seconds`; stops early with a partial result when cancelled.',
        inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } },
        flags: { interruptible: true },
        handler: (i: { seconds?: number }, ctx) =>
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('waited'), (i.seconds ?? 5) * 1000);
            ctx.signal.addEventListener('abort', () => (clearTimeout(t), resolve({ text: 'partial: cancelled', partial: true })), { once: true });
          }),
      },
    ],
    envPromptVars: async (host) => ({ count: ((await host.kv.get<string[]>('notes')) ?? []).length }),
  }),
);
