import { useState, type FormEvent } from 'react';
import {
  BOARD_SECTIONS,
  type BoardCommand,
  type BoardItem,
  type BoardResponse,
  type BoardSection,
  type DreamStatus,
  type MemoryCheck,
  type MemoryHistoryResponse,
  type MemoryOverview,
  type MemorySearchHit,
} from '@protea/protocol';
import { api, qs, useApi } from '../api';
import { Bar, Button, Card, Editor, Empty, ErrorText, Tabs, dateTime, timeAgo, useFeedback } from '../components/ui';
import { go, useSession } from '../session';

interface FileRow {
  path: string;
  size: number;
  mtime: string;
}

const CORE_LABELS: Record<string, string> = { 'core/owner.md': '主人画像', 'core/rules.md': '长期约定' };
const CHECK_LABELS: Record<MemoryCheck['problem'], string> = { over_limit: '超过上限', no_summary: '缺少 summary', too_long: '过长' };

function FileTree({ files, selected, onSelect }: { files: FileRow[]; selected: string | null; onSelect: (p: string) => void }) {
  if (files.length === 0) return <Empty>没有文件</Empty>;
  return (
    <ul className="tree">
      {files.map((f) => {
        const depth = f.path.split('/').length - 1;
        return (
          <li key={f.path} style={{ paddingLeft: `${depth * 14}px` }}>
            <button className={`link ${selected === f.path ? 'selected' : ''}`} onClick={() => onSelect(f.path)} title={`${f.size} B · ${f.mtime}`}>
              {f.path.split('/').pop()}
              <span className="muted small"> {depth > 0 ? f.path.split('/').slice(0, -1).join('/') + '/' : ''}</span>
            </button>
            {f.mtime && <span className="muted small"> {timeAgo(f.mtime)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const openFile = (p: string) => go('memory', { tab: 'files', file: p.replace(/^\/memories\//, '') });

function SearchHits({ hits, onClose }: { hits: MemorySearchHit[]; onClose: () => void }) {
  return (
    <div className="hits">
      {hits.length === 0 && <div className="muted">没有匹配</div>}
      {hits.map((h) => (
        <button key={h.path} className="hit link" onClick={() => openFile(h.path)}>
          <strong>{h.path.replace(/^\/memories\//, '')}</strong>
          {h.summary && <span className="small"> — {h.summary}</span>}
          {h.matched.length < h.terms && (
            <span className="muted small">
              {' '}
              （命中 {h.matched.length}/{h.terms}：{h.matched.join('、')}）
            </span>
          )}
          {h.chunks.map((c) => (
            <span key={`${c.start}-${c.end}`} className="muted small" style={{ display: 'block' }}>
              第 {c.start}–{c.end} 行：{c.snippet}
            </span>
          ))}
        </button>
      ))}
      <Button small kind="ghost" onClick={onClose}>
        收起结果
      </Button>
    </div>
  );
}

function FilesTab({ selected }: { selected: string | null }) {
  const { canWrite } = useSession();
  const tree = useApi<{ files: FileRow[] }>('/api/memory/tree');
  const file = useApi<{ path: string; text: string }>(selected ? `/api/memory/file${qs({ path: selected })}` : null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'notes' | 'all'>('all');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setHits((await api<{ hits: MemorySearchHit[] }>('GET', `/api/memory/search${qs({ q, limit: 20, scope })}`)).hits);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const limit = selected ? { 'core/owner.md': 2000, 'core/rules.md': 4000 }[selected] : undefined;
  return (
    <div className="split">
      <Card title="记忆目录" className="split-side">
        <form className="row" onSubmit={(e) => void search(e)}>
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="全文检索；引号或 + 表示必须出现" />
          <select value={scope} onChange={(e) => setScope(e.target.value as 'notes' | 'all')} aria-label="范围">
            <option value="all">全部</option>
            <option value="notes">只查笔记</option>
          </select>
          <Button type="submit" disabled={!q.trim()}>
            搜索
          </Button>
        </form>
        <ErrorText error={error ?? tree.error} />
        {hits && <SearchHits hits={hits} onClose={() => setHits(null)} />}
        <FileTree files={tree.data?.files ?? []} selected={selected} onSelect={openFile} />
        {canWrite && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const p = newPath.trim().replace(/^\/memories\//, '').replace(/^\/+/, '');
              if (p) {
                const body = p.startsWith('notes/') ? '---\nsummary: \nkeywords: []\n---\n' : '';
                void api('PUT', `/api/memory/file${qs({ path: p })}`, body, { text: true }).then(() => {
                  tree.reload();
                  setNewPath('');
                  openFile(p);
                }, (err: Error) => setError(err.message));
              }
            }}
          >
            <input className="grow" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="新文件，如 notes/coffee.md" />
            <Button type="submit" disabled={!newPath.trim()}>
              新建
            </Button>
          </form>
        )}
      </Card>
      <Card title={selected ? `/memories/${selected}` : '选择一个文件'} className="split-main">
        {selected && file.error && <ErrorText error={file.error} />}
        {selected && file.data && (
          <Editor
            value={file.data.text}
            readOnly={!canWrite || selected.startsWith('raw/') || selected.startsWith('handoff/')}
            onSave={async (text) => {
              await api('PUT', `/api/memory/file${qs({ path: selected })}`, text, { text: true });
              file.reload();
              tree.reload();
            }}
          />
        )}
        {limit !== undefined && (
          <div className="muted small">
            常驻文件：每次模型请求都带上，上限 {limit} 字符。保存后在主会话空闲时进入系统提示（提示缓存失效一次）。
          </div>
        )}
        {selected?.startsWith('notes/') && <div className="muted small">笔记开头的 summary 会出现在系统提示的笔记索引里；keywords 用来补充同义词和中英文写法。</div>}
      </Card>
    </div>
  );
}

function CoreFile({ path, chars, limit, canWrite }: { path: string; chars: number; limit: number; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const history = useApi<MemoryHistoryResponse>(open ? `/api/memory/history${qs({ path })}` : null);
  const { toast } = useFeedback();
  const restore = async (text: string, at: string) => {
    try {
      await api('PUT', `/api/memory/file${qs({ path })}`, text, { text: true });
      toast(`已恢复到 ${dateTime(at)} 的版本`);
      history.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  };
  return (
    <section>
      <div className="row">
        <strong className="grow">
          {CORE_LABELS[path] ?? path} <span className="muted small">/memories/{path}</span>
        </strong>
        <span className="muted small">
          {chars}/{limit} 字符
        </span>
        <Button small kind="ghost" onClick={() => openFile(path)}>
          {canWrite ? '编辑' : '查看'}
        </Button>
        <Button small kind="ghost" onClick={() => setOpen(!open)}>
          {open ? '收起历史' : '历史版本'}
        </Button>
      </div>
      <Bar ratio={limit > 0 ? chars / limit : null} />
      {open && (
        <div>
          <ErrorText error={history.error} />
          {history.data && history.data.versions.length === 0 && <div className="muted small">还没有历史版本</div>}
          <ul className="plain">
            {history.data?.versions.map((v) => (
              <li key={v.name}>
                <details>
                  <summary>
                    {dateTime(v.at)} <span className="muted small">· {v.text.length} 字符</span>
                  </summary>
                  <pre className="small">{v.text}</pre>
                  {canWrite && (
                    <Button small onClick={() => void restore(v.text, v.at)}>
                      恢复这个版本
                    </Button>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const DREAM_RESULTS: Record<NonNullable<DreamStatus['result']>, string> = { completed: '完成', failed: '失败', cancelled: '已取消' };

function DreamCard({ canWrite }: { canWrite: boolean }) {
  const dream = useApi<DreamStatus>('/api/memory/dream', { refreshMs: 10_000 });
  const [error, setError] = useState<string | null>(null);
  const s = dream.data;
  const run = async () => {
    try {
      setError(null);
      await api('POST', '/api/memory/dream');
      dream.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Card
      title="记忆整理"
      actions={
        canWrite && s ? (
          <Button small disabled={s.running} onClick={() => void run()}>
            {s.running ? '整理中…' : '立即整理'}
          </Button>
        ) : undefined
      }
    >
      <ErrorText error={error ?? dream.error} />
      {s && (
        <>
          <p className="muted">
            {!s.enabled ? '每日整理已关闭' : s.disabled ? `连续失败 ${s.failures} 次，每日整理已暂停；手动运行一次可恢复` : `每天 ${s.at} 之后，主会话空闲时运行`}
          </p>
          {s.date && (
            <p>
              最近一次：{s.date}
              {s.result ? ` · ${DREAM_RESULTS[s.result]}` : s.running ? ' · 进行中' : ''}
              {s.rejected && <span className="muted"> · 未通过验收：{s.rejected}</span>}
            </p>
          )}
          {s.acceptedAt && <p className="muted small">上次通过验收：{dateTime(s.acceptedAt)}；之后改动的文件是下次整理的输入</p>}
          {s.summary && <p className="muted">{s.summary}</p>}
        </>
      )}
    </Card>
  );
}

function OverviewTab() {
  const { canWrite } = useSession();
  const o = useApi<MemoryOverview>('/api/memory/overview', { refreshMs: 30_000 });
  const d = o.data;
  return (
    <>
      <Card title="常驻记忆">
        <ErrorText error={o.error} />
        <p className="muted small">这两个文件和下面的笔记索引在每次模型请求的系统提示里。助理和你都可以修改，超过上限的写入会被拒绝；每次修改前的版本会保留 20 份。</p>
        {d?.stale && <p className="small">助理改过的内容还没进入系统提示，下次压缩或整理后生效。</p>}
        {d?.core.map((c) => (
          <CoreFile key={c.path} {...c} canWrite={canWrite} />
        ))}
      </Card>
      <Card title="笔记索引（自动生成）">
        {d && !d.index && <Empty>还没有笔记</Empty>}
        {d?.index && <pre className="small">{d.index}</pre>}
      </Card>
      {d && d.checks.length > 0 && (
        <Card title="待整理">
          <ul className="plain">
            {d.checks.map((c) => (
              <li key={`${c.path}-${c.problem}`}>
                <button className="link" onClick={() => openFile(c.path)}>
                  {c.path}
                </button>
                <span className="muted">
                  {' '}
                  · {CHECK_LABELS[c.problem]}
                  {c.detail ? `（${c.detail}）` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d && (
        <Card title={`使用情况（${d.recall.days} 天，主会话）`}>
          <p>检索 {d.recall.searches} 次</p>
          {d.recall.misses.length > 0 && (
            <>
              <h3>没有结果的检索</h3>
              <ul className="plain">
                {d.recall.misses.map((m) => (
                  <li key={m.query}>
                    <code>{m.query}</code>
                    <span className="muted small">
                      {' '}
                      · {m.times} 次 · {timeAgo(m.last)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.recall.used.length > 0 && (
            <>
              <h3>读过或检索到的文件</h3>
              <ul className="plain">
                {d.recall.used.slice(0, 15).map((u) => (
                  <li key={u.path}>
                    <button className="link" onClick={() => openFile(u.path)}>
                      {u.path}
                    </button>
                    <span className="muted small">
                      {' '}
                      · 读 {u.reads} · 命中 {u.hits} · {timeAgo(u.last)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.recall.unused.length > 0 && (
            <>
              <h3>没被用到的笔记</h3>
              <p className="muted small">{d.recall.unused.join('，')}</p>
            </>
          )}
        </Card>
      )}
      <DreamCard canWrite={canWrite} />
    </>
  );
}

function PersonaTab({ selected }: { selected: string | null }) {
  const { canWrite } = useSession();
  const files = useApi<{ files: FileRow[] }>('/api/persona/files');
  const sel = selected ?? 'SOUL.md';
  const file = useApi<{ path: string; text: string }>(`/api/persona/file${qs({ path: sel })}`);
  return (
    <div className="split">
      <Card title="人格文件" className="split-side">
        <ErrorText error={files.error} />
        <FileTree files={files.data?.files ?? []} selected={sel} onSelect={(p) => go('memory', { tab: 'persona', file: p })} />
        <div className="muted small">
          SOUL.md：身份与说话方式；OPERATING.md：行为准则；plugins/&lt;id&gt;/ENV_PROMPT.md：插件环境提示覆盖。主人画像在记忆的 core/owner.md。保存后从下一次模型请求生效（缓存失效一次）。钩子文件（hooks.*）是代码，不在这里编辑。
        </div>
      </Card>
      <Card title={sel} className="split-main">
        {file.error && !file.error.includes('no such') && <ErrorText error={file.error} />}
        <Editor
          value={file.data?.text ?? ''}
          readOnly={!canWrite}
          onSave={async (text) => {
            await api('PUT', `/api/persona/file${qs({ path: sel })}`, text, { text: true });
            file.reload();
            files.reload();
          }}
        />
      </Card>
    </div>
  );
}

const SECTION_LABELS: Record<BoardSection, string> = { goals: '目标', todo: '待办', notes: '注意事项' };

function BoardRow({ item, canWrite, send }: { item: BoardItem; canWrite: boolean; send: (c: BoardCommand) => Promise<boolean> }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <li>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ command: 'update', id: item.id, text: editing }).then((ok) => {
              if (ok) setEditing(null);
            });
          }}
        >
          <input className="grow" value={editing} onChange={(e) => setEditing(e.target.value)} />
          <Button type="submit" small disabled={!editing.trim()}>
            保存
          </Button>
          <Button small kind="ghost" onClick={() => setEditing(null)}>
            取消
          </Button>
        </form>
      </li>
    );
  }
  return (
    <li className="row">
      <span className="grow">
        {item.text}
        {item.due && <span className="muted"> · 截止 {item.due}</span>}
      </span>
      {canWrite && (
        <>
          <Button small kind="ghost" onClick={() => setEditing(item.text)}>
            编辑
          </Button>
          <Button small onClick={() => void send({ command: 'done', id: item.id })}>
            完成
          </Button>
          <Button small kind="ghost" onClick={() => void send({ command: 'drop', id: item.id })}>
            丢弃
          </Button>
        </>
      )}
    </li>
  );
}

function BoardTab() {
  const { canWrite } = useSession();
  const board = useApi<BoardResponse>('/api/memory/board?closed=1', { refreshMs: 10_000 });
  const [form, setForm] = useState<{ section: BoardSection; text: string; due: string }>({ section: 'todo', text: '', due: '' });
  const [error, setError] = useState<string | null>(null);
  const send = async (cmd: BoardCommand): Promise<boolean> => {
    try {
      setError(null);
      await api('POST', '/api/memory/board', cmd);
      board.reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void send({ command: 'add', section: form.section, text: form.text, ...(form.due ? { due: form.due } : {}) }).then((ok) => {
      if (ok) setForm({ ...form, text: '', due: '' });
    });
  };
  const items = board.data?.items ?? [];
  return (
    <>
      <Card title="白板">
        <ErrorText error={error ?? board.error} />
        {canWrite && (
          <form className="row" onSubmit={add}>
            <select value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value as BoardSection })}>
              {BOARD_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {SECTION_LABELS[s]}
                </option>
              ))}
            </select>
            <input className="grow" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="新条目" />
            <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
            <Button type="submit" disabled={!form.text.trim()}>
              添加
            </Button>
          </form>
        )}
        {board.data && items.length === 0 && <Empty>白板是空的</Empty>}
        {BOARD_SECTIONS.map((section) => {
          const inSection = items.filter((i) => i.section === section);
          if (inSection.length === 0) return null;
          return (
            <section key={section}>
              <h3>{SECTION_LABELS[section]}</h3>
              <ul className="plain">
                {inSection.map((item) => (
                  <BoardRow key={item.id} item={item} canWrite={canWrite} send={send} />
                ))}
              </ul>
            </section>
          );
        })}
      </Card>
      {(board.data?.closed?.length ?? 0) > 0 && (
        <Card title="最近关闭">
          <ul className="plain">
            {board.data?.closed?.map((i) => (
              <li key={i.id}>
                <span className={i.state === 'dropped' ? 'muted' : undefined}>{i.text}</span>
                <span className="muted">
                  {' '}
                  · {i.state === 'done' ? '完成' : '丢弃'}
                  {i.closedAt ? ` · ${timeAgo(i.closedAt)}` : ''}
                  {i.outcome ? ` · ${i.outcome}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

type MemoryTabId = 'overview' | 'files' | 'board' | 'persona';

export function Memory({ params }: { params: URLSearchParams }) {
  const tab = (params.get('tab') ?? 'overview') as MemoryTabId;
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['overview', '概况'],
          ['files', '文件'],
          ['board', '白板'],
          ['persona', '人格'],
        ]}
        value={tab}
        onChange={(t) => go('memory', { tab: t })}
      />
      {tab === 'files' ? <FilesTab selected={params.get('file')} /> : tab === 'board' ? <BoardTab /> : tab === 'persona' ? <PersonaTab selected={params.get('file')} /> : <OverviewTab />}
    </div>
  );
}
