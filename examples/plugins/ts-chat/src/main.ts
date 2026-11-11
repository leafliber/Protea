/**
 * Example chat platform: the smallest connector that takes everything a reply can carry
 * (docs/10-architecture/17-chat-and-console.md §3).
 *
 *   <dataDir>/outbox.jsonl   what the assistant sent, one JSON object a line: `draft`, `discarded`, `message`
 *   <dataDir>/inbox.jsonl    what the owner writes: {"text": "…"} or {"choose": ["label", …]}
 *
 * Add `ts-chat:owner` to `owner.identities` so its lines count as the owner's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chatAnswer, definePlugin, runPlugin, type Host } from '@protea/plugin-sdk';

const SENDER = 'ts-chat:owner';

interface Config {
  pollMs?: number;
}

/** The choices the owner can still answer: the newest ones, until any newer message. */
let open: { callId: string; labels: string[] } | null = null;
let read = 0;
let n = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const out = (host: Host<Config>, line: Record<string, unknown>): void => {
  fs.appendFileSync(path.join(host.dataDir, 'outbox.jsonl'), `${JSON.stringify(line)}\n`);
};

/** New complete lines of the inbox, as events. */
async function poll(host: Host<Config>): Promise<void> {
  const file = path.join(host.dataDir, 'inbox.jsonl');
  if (!fs.existsSync(file)) return;
  const all = fs.readFileSync(file, 'utf8');
  const end = all.lastIndexOf('\n') + 1;
  const lines = all.slice(read, end).split('\n').filter((l) => l.trim() !== '');
  read = end;
  for (const raw of lines) {
    let line: { text?: unknown; choose?: unknown };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      host.log.warn('a line of inbox.jsonl is not JSON', { line: raw.slice(0, 200) });
      continue;
    }
    const chosen = Array.isArray(line.choose) ? line.choose.filter((l): l is string => typeof l === 'string') : null;
    const asked = open;
    // Whatever the owner writes closes the choices; an answer to older ones is dropped.
    open = null;
    if (chosen) {
      if (!asked || chosen.length === 0 || !chosen.every((l) => asked.labels.includes(l))) {
        host.log.info('dropped an answer to choices that are no longer open', { chosen });
        continue;
      }
      await host.events.push({ type: 'chat.message', ts: new Date().toISOString(), level: 1, trigger: 'flush', text: chosen.join(', '), senderKey: SENDER, meta: chatAnswer(asked.callId, chosen) });
    } else if (typeof line.text === 'string' && line.text !== '') {
      await host.events.push({ type: 'chat.message', ts: new Date().toISOString(), level: 1, trigger: 'flush', text: line.text, senderKey: SENDER });
    }
  }
}

runPlugin(
  definePlugin<Config>({
    displayName: 'File chat (TypeScript example)',
    start: (host) => {
      // Lines written before this start were for an earlier run.
      const file = path.join(host.dataDir, 'inbox.jsonl');
      read = fs.existsSync(file) ? fs.statSync(file).size : 0;
      timer = setInterval(() => void poll(host).catch((err: unknown) => host.log.warn('could not read inbox.jsonl', { err: String(err) })), host.config.pollMs ?? 500);
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
    chat: {
      send: async (host, req) => {
        const id = `m${++n}`;
        // An image arrives as a handle; its bytes come from the host.
        const images = await Promise.all((req.images ?? []).map(async (i) => ({ ...i, size: (await host.blobs.get(i.handle)).size })));
        out(host, {
          kind: 'message',
          id,
          ...(req.callId ? { callId: req.callId } : {}),
          text: req.text,
          ...(images.length > 0 ? { images } : {}),
          ...(req.choices ? { choices: req.choices } : {}),
          ...(req.widget ? { widget: req.widget } : {}),
        });
        // Newer choices replace older ones; a message without choices leaves them open (only the owner's next message closes them).
        if (req.choices && req.callId) open = { callId: req.callId, labels: req.choices.options.map((o) => o.label) };
        return { ok: true, messageIds: [id] };
      },
      // A real platform edits or deletes the preview message here; this one appends what happened.
      draft: (host, d) => out(host, d.state === 'writing' ? { kind: 'draft', callId: d.callId, text: d.text, ...(d.pending ? { pending: d.pending } : {}) } : { kind: 'discarded', callId: d.callId }),
    },
  }),
);
