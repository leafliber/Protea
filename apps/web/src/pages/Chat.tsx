import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApprovalInfo, BatchEndReason, BlobImageRef, ChatAnswer, ChatBatch, ChatHistoryResponse, ChatItem, ChatMessageRequest, ChatPending, PushEventResponse, RunPhase, StatusResponse, WhoAmIResponse } from '@protea/protocol';
import { get, post, qs, useApi } from '../api';
import { BlobImages, blobUrl, uploadImage } from '../images';
import { Choices, type ChoiceState } from '../components/rich/Choices';
import { Rich } from '../components/rich/Markdown';
import { Widget } from '../components/rich/Widget';
import { UserMenu } from '../components/UserMenu';
import { IconAlert, IconArrowDown, IconCheck, IconConsole, IconCopy, IconRetry, IconSend } from '../components/icons';
import { cx } from '../components/ui';
import { applyDraft, removeBatchDrafts, removeDraft, type ChatDraft } from '../chat-drafts';
import { live, useChatDrafts, useLive, useLiveState, useReloadOn } from '../live';
import { consoleHref, useSession } from '../session';
import { chatActivity } from '../view-logic';
import { ChangeCards } from './Changes';

const PAGE = 50;
/** Messages from the same side closer than this read as one group (one avatar, one time stamp). */
const GROUP_MS = 3 * 60_000;

const PHASE_TEXT: Partial<Record<RunPhase, string>> = {
  delivering: '正在读你的消息…',
  model: '正在思考…',
  tools: '正在使用工具…',
  backoff: '模型暂时不可用，正在重试…',
  handoff: '正在整理较早的对话…',
};

/** This window is the web chat; the other platforms are their own conversations. */
const PLATFORM = 'webchat';

const PENDING_TEXT: Record<ChatPending, string> = { images: '正在准备图片…', choices: '正在准备选项…', widget: '正在生成小组件…' };

const SOURCE_LABEL: Record<string, string> = { cron: '定时提醒', core: '后台任务', telegram: 'Telegram', wechat: '微信', qq: 'QQ', rss: '订阅更新', imap: '新邮件', webhook: 'Webhook', filewatch: '文件变化', shell: '命令' };

function order(a: ChatItem, b: ChatItem): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  const ka = a.key[0] === 'e' ? 0 : 1;
  const kb = b.key[0] === 'e' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  return Number(a.key.slice(1)) - Number(b.key.slice(1)) || (a.key < b.key ? -1 : 1);
}

function merge(old: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const map = new Map(old.map((i) => [i.key, i]));
  for (const i of incoming) map.set(i.key, { ...map.get(i.key), ...i });
  return [...map.values()].sort(order);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今天';
  if (same(d, new Date(today.getTime() - 86_400_000))) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

type Outcome = { text: string; detail?: string; tone: 'muted' | 'warn' | 'bad'; retry?: boolean; settings?: boolean };

const END: Partial<Record<BatchEndReason, Outcome>> = {
  model_error: { text: '没有回复：模型调用失败', tone: 'bad', retry: true, settings: true },
  interrupted: { text: '被新消息打断', tone: 'muted' },
  max_tokens: { text: '回复太长，被截断了', tone: 'warn' },
  refusal: { text: '模型拒绝回答', tone: 'warn', retry: true },
  round_limit: { text: '步骤太多，已停止', tone: 'warn', retry: true },
  aborted: { text: '已中止', tone: 'muted', retry: true },
  context_overflow: { text: '对话太长，放不进上下文', tone: 'bad' },
};

/** What happened to an operator message, when it is worth saying. */
function outcomeOf(item: ChatItem, batch: ChatBatch | undefined, lastOfBatch: boolean, active: boolean): Outcome | null {
  switch (item.state) {
    case 'pending':
      return { text: '等待处理', tone: 'muted' };
    case 'archived':
      return { text: '已保存，稍后处理', tone: 'muted' };
    case 'withdrawn':
      return { text: '已撤回', tone: 'muted' };
    case 'expired':
      return { text: '已过期，没有送达', tone: 'warn', retry: true };
    case 'discarded':
      return { text: '已丢弃，没有送达', tone: 'warn', retry: true };
    case 'delivering':
      return active ? null : { text: '处理中', tone: 'muted' };
  }
  if (!lastOfBatch || !batch) return null;
  if (batch.endReason === null) return active ? null : { text: '处理中', tone: 'muted' };
  const end = END[batch.endReason];
  if (end) return { ...end, ...(batch.error ? { detail: batch.error } : {}) };
  return batch.replied ? null : { text: '已读，没有回复', tone: 'muted' };
}

/** Approval notices are written for the CLI: show the request itself. */
function noticeText(i: ChatItem): string {
  const m = /^Approval (\S+) requested: ([\s\S]*?)\. Decide with:/.exec(i.text);
  return m ? `助理请求批准：${m[2]}` : i.text;
}

/** `meta.answer` of a live event, when it is well formed. */
function answerOf(meta: Record<string, unknown> | undefined): { answer?: ChatAnswer } {
  const a = meta?.['answer'] as { to?: unknown; labels?: unknown } | undefined;
  if (!a || typeof a.to !== 'string' || !Array.isArray(a.labels)) return {};
  return { answer: { to: a.to, labels: a.labels.filter((l): l is string => typeof l === 'string') } };
}

function choiceState(i: ChatItem, answers: Map<string, string[]>, open: string | null): ChoiceState {
  if (i.callId !== undefined && answers.has(i.callId)) return 'answered';
  return i.key === open ? 'open' : 'closed';
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="cm-action"
      aria-label="复制"
      title="复制"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

/** Pending approvals, decided right here (admin). */
function ApprovalCards() {
  const { canWrite } = useSession();
  const r = useApi<{ approvals: ApprovalInfo[] }>(canWrite ? '/api/approvals?state=pending' : null);
  useReloadOn('approval', r.reload, 200);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = r.data?.approvals?.filter((a) => a.state === 'pending') ?? [];
  if (!canWrite || pending.length === 0) return null;
  const decide = async (id: string, decision: 'approve' | 'deny', grantMs?: number) => {
    setBusy(id + decision);
    setError(null);
    try {
      await post(`/api/approvals/${encodeURIComponent(id)}/decide`, { decision, ...(grantMs !== undefined ? { grantMs } : {}) });
      r.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="approvals-stack">
      {pending.map((a) => (
        <div key={a.id} className="approval-card" role="alert">
          <div className="approval-body">
            <div className="approval-title">需要你批准</div>
            <div className="approval-summary">{a.summary}</div>
            {a.reason && <div className="muted small">{a.reason}</div>}
          </div>
          <div className="approval-actions">
            <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void decide(a.id, 'deny')}>
              拒绝
            </button>
            <button type="button" className="btn btn-small" disabled={busy !== null} title="批准这次，并在 1 小时内放行同一组工具" onClick={() => void decide(a.id, 'approve', 3_600_000)}>
              批准 1 小时
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => void decide(a.id, 'approve')}>
              批准
            </button>
          </div>
        </div>
      ))}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

const SUGGESTIONS = ['你好，介绍一下你自己', '明天早上 8 点提醒我带伞', '记住我喜欢喝乌龙茶'];

/** The conversation window: the web entry point (docs/10-architecture/13-control-plane.md §5). */
export function ChatApp({ me, status, onLogout }: { me: WhoAmIResponse; status: StatusResponse | undefined; onLogout: () => void }) {
  const { canWrite, username } = useSession();
  const ws = useLiveState();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [batches, setBatches] = useState<Record<string, ChatBatch>>({});
  const [before, setBefore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [phase, setPhase] = useState<{ phase: RunPhase; batchId?: string; round?: number }>({ phase: 'idle' });
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [draft, setDraft] = useState('');
  const [drafts, setDrafts] = useState<ChatDraft[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prepend = useRef<number | null>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    document.title = 'Protea';
  }, []);

  const addBatches = (list: ChatBatch[]) => {
    if (list.length) setBatches((old) => ({ ...old, ...Object.fromEntries(list.map((b) => [b.id, b])) }));
  };

  const loadLatest = (first: boolean) =>
    get<ChatHistoryResponse>(`/api/chat${qs({ limit: PAGE, platform: PLATFORM })}`).then(
      (r) => {
        setItems((old) => merge(old, r.items));
        addBatches(r.batches);
        if (first) setBefore(r.before);
        setLoaded(true);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );

  useEffect(() => {
    void loadLatest(true);
    // A dropped WebSocket misses replies: fetch the newest page again when it is back.
    let was = live.state;
    return live.onState((s) => {
      if (s !== 'open') setDrafts([]);
      if (s === 'open' && was !== 'open') void loadLatest(false);
      was = s;
    });
  }, []);

  // The status poll corrects a missed phase message (it has no round number: keep ours for the same batch).
  useEffect(() => {
    if (!status) return;
    setPhase((p) =>
      p.phase === status.phase && (p.batchId ?? null) === status.batchId ? p : { phase: status.phase, ...(status.batchId ? { batchId: status.batchId } : {}), ...(p.batchId === status.batchId && p.round !== undefined ? { round: p.round } : {}) },
    );
  }, [status?.phase, status?.batchId]);

  const refreshBatch = (id: string) => {
    get<{ batches: ChatBatch[] }>(`/api/chat/batches${qs({ ids: id })}`).then((r) => addBatches(r.batches), () => undefined);
  };

  useChatDrafts();
  useLive(['event', 'settled', 'batch.started', 'batch.extended', 'batch.ended', 'output', 'phase', 'chat.draft'], (m) => {
    switch (m.topic) {
      case 'event': {
        const e = m.data;
        if (e.source !== PLATFORM || e.type !== 'chat.message') return;
        setItems((old) =>
          merge(old, [{ key: `e${e.cursor}`, kind: 'owner', platform: PLATFORM, at: e.receivedAt, text: e.text, cursor: e.cursor, state: e.state, ...(e.senderKey ? { sender: e.senderKey } : {}), ...(e.batchId ? { batchId: e.batchId } : {}), ...(e.blobs?.length ? { images: e.blobs.map((b) => ({ handle: b.handle, mime: b.mime })) } : {}), ...answerOf(e.meta) }]),
        );
        break;
      }
      case 'settled':
        setItems((old) => old.map((i) => (i.cursor !== undefined && m.data.cursors.includes(i.cursor) ? { ...i, state: m.data.outcome, ...(m.data.batchId ? { batchId: m.data.batchId } : {}) } : i)));
        break;
      case 'batch.started':
      case 'batch.extended': {
        const { batchId, cursors } = m.data;
        setItems((old) => old.map((i) => (i.cursor !== undefined && cursors.includes(i.cursor) ? { ...i, state: 'delivering', batchId } : i)));
        break;
      }
      case 'output': {
        const o = m.data;
        if (o.plugin !== PLATFORM) return;
        if (o.callId !== undefined) {
          const sent = o.callId;
          setDrafts((old) => removeDraft(old, sent));
        }
        const key = o.id !== undefined ? `o${o.id}` : `o${Date.parse(o.at)}.${Math.random().toString(36).slice(2, 6)}`;
        setItems((old) =>
          merge(old, [
            {
              key,
              kind: o.channel === 'chat' ? 'reply' : 'notice',
              platform: PLATFORM,
              at: o.at,
              text: o.text,
              ...(o.channel ? { channel: o.channel } : {}),
              ...(o.batchId ? { batchId: o.batchId } : {}),
              ...(o.callId ? { callId: o.callId } : {}),
              ...(o.images ? { images: o.images } : {}),
              ...(o.choices ? { choices: o.choices } : {}),
              ...(o.widget ? { widget: o.widget } : {}),
            },
          ]),
        );
        if (o.batchId && o.channel === 'chat') {
          const id = o.batchId;
          setBatches((old) => ({ ...old, [id]: { ...(old[id] ?? { id, endReason: null, endedAt: null, sources: [] }), replied: true } }));
          // A reply from a batch we have not seen (a reminder): learn what triggered it.
          refreshBatch(id);
        }
        break;
      }
      case 'phase':
        setPhase({ phase: m.data.phase, ...(m.data.batchId ? { batchId: m.data.batchId } : {}), ...(m.data.round !== undefined ? { round: m.data.round } : {}) });
        break;
      case 'batch.ended':
        setDrafts((old) => removeBatchDrafts(old, m.data.batchId));
        refreshBatch(m.data.batchId);
        break;
      case 'chat.draft':
        if (m.data.platform === PLATFORM) setDrafts((old) => applyDraft(old, m.data));
        break;
    }
  });

  const loadOlder = async () => {
    if (!before || olderBusy) return;
    setOlderBusy(true);
    try {
      const r = await get<ChatHistoryResponse>(`/api/chat${qs({ limit: PAGE, before, platform: PLATFORM })}`);
      prepend.current = scrollRef.current?.scrollHeight ?? null;
      setItems((old) => merge(old, r.items));
      addBatches(r.batches);
      setBefore(r.before);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOlderBusy(false);
    }
  };

  const running = phase.phase !== 'idle';
  const active = running && phase.batchId !== undefined && items.some((i) => i.kind === 'owner' && i.batchId === phase.batchId);
  // After a reply of this batch is on screen, the model round that only checks whether anything is left is not shown.
  const replied = phase.batchId !== undefined && items.some((i) => i.kind === 'reply' && i.batchId === phase.batchId);
  const activity = chatActivity({ active, phase: phase.phase, drafts: drafts.length, replied });

  // Stay at the newest message while the reader is there; keep the place when older ones load; otherwise flag new ones.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newest = items[items.length - 1]?.key ?? null;
    if (prepend.current !== null) {
      el.scrollTop += el.scrollHeight - prepend.current;
      prepend.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (newest !== lastKey.current) {
      setUnseen(true);
    }
    lastKey.current = newest;
  }, [items, drafts, active, phase.phase, loaded]);

  // A diagram, a picture or a widget grows after it arrives: stay at the newest message while the reader is there.
  useEffect(() => {
    const col = colRef.current;
    if (!col || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stick.current = true;
    setUnseen(false);
  };

  const lastOfBatch = useMemo(() => {
    const last = new Map<string, string>();
    for (const i of items) if (i.kind === 'owner' && i.batchId) last.set(i.batchId, i.key);
    return new Set(last.values());
  }, [items]);

  const send = async (text: string, trigger?: ChatMessageRequest['trigger'], images: BlobImageRef[] = [], answer?: ChatAnswer): Promise<void> => {
    const r = await post<PushEventResponse>('/api/chat/messages', { text, ...(trigger ? { trigger } : {}), ...(images.length > 0 ? { images } : {}), ...(answer ? { answer } : {}) });
    stick.current = true;
    // The live stream often wins the race (a fast reply arrives before this response): never overwrite it.
    const key = `e${r.cursor}`;
    setItems((old) =>
      old.some((i) => i.key === key)
        ? old
        : merge(old, [{ key, kind: 'owner', platform: PLATFORM, at: new Date().toISOString(), text, cursor: r.cursor, state: r.effectiveTrigger === 'store' ? 'archived' : 'pending', ...(username ? { sender: `console:${username}` } : {}), ...(images.length > 0 ? { images } : {}), ...(answer ? { answer } : {}) }]),
    );
  };

  // Choices: the newest ones are open until the owner writes; an answer names the reply it answers.
  const { answers, openChoices } = useMemo(() => {
    const answers = new Map<string, string[]>();
    let open: string | null = null;
    for (const i of items) {
      if (i.kind === 'owner') {
        open = null;
        if (i.answer) answers.set(i.answer.to, i.answer.labels);
      } else if (i.kind === 'reply' && i.choices) open = i.key;
    }
    return { answers, openChoices: open };
  }, [items]);
  const widgetsOn = status?.chat?.platforms.find((p) => p.id === PLATFORM)?.widgets !== false;

  const rows: ReactNode[] = [];
  let day = '';
  items.forEach((i, idx) => {
    const d = dayLabel(i.at);
    if (d !== day) {
      day = d;
      rows.push(
        <div key={`d${i.key}`} className="cm-day" role="separator">
          <span>{d}</span>
        </div>,
      );
    }
    const prev = items[idx - 1];
    const next = items[idx + 1];
    const side = (x: ChatItem | undefined) => (x ? (x.kind === 'owner' ? 'out' : x.kind === 'reply' ? 'in' : 'sys') : null);
    const near = (a: ChatItem | undefined, b: ChatItem | undefined) => !!a && !!b && side(a) === side(b) && Math.abs(Date.parse(b.at) - Date.parse(a.at)) < GROUP_MS && dayLabel(a.at) === dayLabel(b.at);
    const first = !near(prev, i);
    const last = !near(i, next);
    const batch = i.batchId ? batches[i.batchId] : undefined;

    if (i.kind === 'notice') {
      rows.push(
        <div key={i.key} className="cm-system">
          {noticeText(i)}
        </div>,
      );
      return;
    }
    if (i.kind === 'reply') {
      const cause = batch && batch.sources.length > 0 && !batch.sources.includes(PLATFORM) && !batch.sources.includes('console') ? batch.sources.map((s) => SOURCE_LABEL[s] ?? s).join('、') : null;
      rows.push(
        <div key={i.key} className={cx('cm', 'cm-in', first && 'cm-first', last && 'cm-last')}>
          <div className="cm-avatar">{first && <img src="./favicon.svg" alt="" width="26" height="26" />}</div>
          <div className="cm-main">
            {cause && <div className="cm-cause">{cause}</div>}
            <div className="cm-body">
              <Rich text={i.text} />
            </div>
            <BlobImages images={i.images} />
            {i.widget && <Widget id={i.widget.id} title={i.widget.title} enabled={widgetsOn} onPrompt={setDraft} />}
            {i.choices && (
              <Choices
                choices={i.choices}
                state={choiceState(i, answers, openChoices)}
                chosen={(i.callId !== undefined ? answers.get(i.callId) : undefined) ?? []}
                canAnswer={canWrite}
                onChoose={(labels) => send(labels.join('、'), undefined, [], i.callId !== undefined ? { to: i.callId, labels } : undefined).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
              />
            )}
            <div className="cm-meta">
              <span title={new Date(i.at).toLocaleString('zh-CN', { hour12: false })}>{hm(i.at)}</span>
              <CopyButton text={i.text} />
            </div>
          </div>
        </div>,
      );
      return;
    }
    const oc = outcomeOf(i, batch, lastOfBatch.has(i.key), active && phase.batchId === i.batchId);
    const other = i.sender && i.sender !== `console:${username ?? ''}` ? (i.sender.startsWith('console:') ? i.sender.slice(8) : 'API') : null;
    rows.push(
      <div key={i.key} className={cx('cm', 'cm-out', first && 'cm-first', last && 'cm-last')}>
        <div className="cm-main">
          <div className="cm-bubble">
            <BlobImages images={i.images} />
            {i.text}
          </div>
          {(last || oc) && (
            <div className="cm-meta">
              {other && <span>{other} 发送 ·</span>}
              <span title={new Date(i.at).toLocaleString('zh-CN', { hour12: false })}>{hm(i.at)}</span>
            </div>
          )}
          {oc && (
            <div className={cx('cm-outcome', `cm-outcome-${oc.tone}`)}>
              {oc.tone !== 'muted' && <IconAlert size={14} />}
              <span>
                {oc.text}
                {oc.detail && <span className="cm-outcome-detail">{oc.detail}</span>}
              </span>
              {oc.retry && canWrite && (
                <button type="button" className="cm-link" onClick={() => void send(i.text, undefined, i.images).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
                  <IconRetry size={13} /> 重新发送
                </button>
              )}
              {oc.settings && canWrite && (
                <a className="cm-link" href={consoleHref('providers')}>
                  检查模型设置
                </a>
              )}
              {canWrite && i.batchId && batch?.endReason && !batch.replied && (
                <a className="cm-link" href={consoleHref('events', { batch: i.batchId })}>
                  在控制台查看这一批
                </a>
              )}
            </div>
          )}
        </div>
      </div>,
    );
  });

  const providerMissing = status && !status.provider.ready;
  const statusLine =
    ws === 'closed' ? { text: '连接中断，正在重连…', tone: 'bad' } : providerMissing ? { text: '还没有配置模型', tone: 'warn' } : active ? { text: activity === 'wrapping' ? '收尾中…' : (PHASE_TEXT[phase.phase] ?? '正在处理…'), tone: 'busy' } : running ? { text: '正在处理其他事情', tone: 'busy' } : { text: '在线', tone: 'good' };

  return (
    <div className="chat-app">
      <header className="chat-head">
        <div className="chat-id">
          <img src="./favicon.svg" alt="" width="30" height="30" />
          <div>
            <div className="chat-title">Protea</div>
            <div className={cx('chat-state', `chat-state-${statusLine.tone}`)} aria-live="polite">
              <span className="chat-dot" />
              {statusLine.text}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <a className="btn btn-ghost chat-console" href={consoleHref('overview')} title="控制台：运行状态、模型、插件、记忆与配置">
          <IconConsole /> <span>控制台</span>
        </a>
        <UserMenu me={me} onLogout={onLogout} place="chat" />
      </header>

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = bottom;
          setAtBottom(bottom);
          if (bottom) setUnseen(false);
          if (el.scrollTop < 160 && before && !olderBusy) void loadOlder();
        }}
      >
        <div className="chat-col" ref={colRef} role="log" aria-live="polite" aria-label="对话">
          {before && (
            <div className="chat-older">
              <button type="button" className="cm-link" disabled={olderBusy} onClick={() => void loadOlder()}>
                {olderBusy ? '正在加载…' : '加载更早的消息'}
              </button>
            </div>
          )}
          {loaded && items.length === 0 && (
            <div className="chat-welcome">
              <img src="./favicon.svg" alt="" width="48" height="48" />
              <h1>你好，我是 Protea</h1>
              <p>可以直接和我说话，也可以让我记住事情、按时提醒你。我会一直在，不在线时收到的消息会在你回来后看到。</p>
              {canWrite && (
                <div className="chat-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => setDraft(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {rows}
          {drafts.map((d) => (
            <div key={d.callId} className="cm cm-in cm-first cm-last" aria-hidden="true">
              <div className="cm-avatar">
                <img src="./favicon.svg" alt="" width="26" height="26" />
              </div>
              <div className="cm-main">
                <div className="cm-body">
                  <Rich text={d.text} streaming />
                </div>
                <div className="typing">
                  <span />
                  <span />
                  <span />
                  {d.pending && d.pending.length > 0 && <em>{PENDING_TEXT[d.pending[d.pending.length - 1] as ChatPending]}</em>}
                </div>
              </div>
            </div>
          ))}
          {activity === 'typing' && (
            <div className="cm cm-in cm-first cm-last cm-typing">
              <div className="cm-avatar">
                <img src="./favicon.svg" alt="" width="26" height="26" />
              </div>
              <div className="cm-main">
                <div className="typing">
                  <span />
                  <span />
                  <span />
                  <em>{PHASE_TEXT[phase.phase] ?? '正在处理…'}</em>
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="chat-error">
              {error}
              <button type="button" className="cm-link" onClick={() => void loadLatest(false)}>
                重试
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="chat-foot">
        <div className="chat-col">
          {!atBottom && (
            <button type="button" className={cx('to-bottom', unseen && 'to-bottom-new')} onClick={toBottom} aria-label="回到最新消息">
              <IconArrowDown size={15} />
              {unseen && <span>新消息</span>}
            </button>
          )}
          {providerMissing && (
            <div className="chat-notice">
              <IconAlert size={15} />
              <span>还没有配置模型，消息会先存下来，配置好之后助理才能回答。</span>
              {canWrite && <a href={consoleHref('providers')}>去配置</a>}
            </div>
          )}
          <ApprovalCards />
          <ChangeCards />
          {canWrite ? <Composer busy={running} draft={draft} onDraftUsed={() => setDraft('')} onSend={send} /> : <div className="chat-readonly">只读账号可以查看对话，但不能发消息。</div>}
        </div>
      </footer>
    </div>
  );
}

/** vision.maxImagesPerMessage's default; the server drops any beyond its own limit. */
const MAX_IMAGES = 4;

const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

function Composer({ busy, draft, onDraftUsed, onSend }: { busy: boolean; draft: string; onDraftUsed: () => void; onSend: (text: string, trigger?: ChatMessageRequest['trigger'], images?: BlobImageRef[]) => Promise<void> }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<BlobImageRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!draft) return;
    // What the owner already wrote stays: a suggestion is added after it.
    setText((old) => (old.trim() ? `${old.replace(/\n+$/, '')}\n${draft}` : draft));
    onDraftUsed();
    ref.current?.focus();
  }, [draft]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const attach = async (files: Blob[]) => {
    const room = MAX_IMAGES - images.length;
    if (files.length === 0) return;
    if (files.length > room) setError(`一条消息最多 ${MAX_IMAGES} 张图片`);
    else setError(null);
    setUploading(true);
    try {
      for (const f of files.slice(0, room)) {
        const ref = await uploadImage(f);
        setImages((old) => (old.some((i) => i.handle === ref.handle) ? old : [...old, ref]));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const canSend = (text.trim() !== '' || images.length > 0) && !sending && !uploading;

  const submit = async (trigger?: ChatMessageRequest['trigger']) => {
    const body = text.trim();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body, trigger, images);
      setText('');
      setImages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <form
      className="chat-composer"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((i) => (
            <span key={i.handle} className="composer-image">
              <img src={blobUrl(i.handle)} alt="待发送的图片" />
              <button type="button" aria-label="移除图片" onClick={() => setImages((old) => old.filter((x) => x.handle !== i.handle))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) return;
          e.preventDefault();
          void attach(files);
        }}
        autoFocus={!coarse}
        aria-label="消息"
        placeholder="给 Protea 发消息"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // On phones Enter is a new line; the button sends.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void attach([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <div className="composer-bar">
        <button type="button" className="composer-attach" disabled={uploading || images.length >= MAX_IMAGES} title="添加图片" aria-label="添加图片" onClick={() => picker.current?.click()}>
          {uploading ? '上传中…' : '图片'}
        </button>
        <span className="composer-hint">{error ? <span className="error-text">{error}</span> : coarse ? '' : 'Enter 发送，Shift + Enter 换行'}</span>
        {busy && (
          <button type="button" className="composer-interrupt" disabled={!canSend} title="停下正在进行的回答，先处理这条" onClick={() => void submit('interrupt')}>
            打断并发送
          </button>
        )}
        <button type="submit" className="send-btn" disabled={!canSend} aria-label="发送" title="发送">
          <IconSend size={18} />
        </button>
      </div>
    </form>
  );
}
