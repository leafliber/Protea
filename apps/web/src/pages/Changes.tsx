import { useState } from 'react';
import type { ChangeKind, ChangeRequestDetail, ChangeRequestInfo } from '@protea/protocol';
import { enc, post, qs, useAction, useApi } from '../api';
import { Diff } from '../components/Diff';
import { Badge, Button, Card, Empty, ErrorText, Modal, StateBadge, cx, dateTime, timeAgo } from '../components/ui';
import { useReloadOn } from '../live';
import { consoleHref, go, useSession } from '../session';

const KIND_LABEL: Record<ChangeKind, string> = { mcp: 'MCP 服务器', skill: 'Skill', plugin: '插件' };
const ACTION_LABEL: Record<string, string> = { add: '新增', update: '修改', remove: '移除', enable: '启用', disable: '禁用', configure: '改配置' };
const STATE_LABEL: Record<string, string> = { pending: '待审核', applied: '已应用', rejected: '已拒绝', failed: '应用失败', stale: '已过时', expired: '已过期', withdrawn: '已撤回' };

/** "新增 MCP 服务器 fetch": what a request is about, in the reviewer's words. */
export function changeTitle(c: Pick<ChangeRequestInfo, 'kind' | 'action' | 'target'>): string {
  const action = c.kind === 'plugin' && c.action === 'add' ? '安装' : (ACTION_LABEL[c.action] ?? c.action);
  return `${action} ${KIND_LABEL[c.kind]} ${c.target}`;
}

function bytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** Change requests waiting for a decision (admins only: nobody else can decide one). */
export function usePendingChanges(): ChangeRequestInfo[] {
  const { canWrite } = useSession();
  const r = useApi<{ changes: ChangeRequestInfo[] }>(canWrite ? '/api/changes?state=pending' : null);
  useReloadOn('change', r.reload, 300);
  return r.data?.changes.filter((c) => c.state === 'pending') ?? [];
}

/** On the MCP, Skills and plugins pages: what the assistant asked to change there. */
export function PendingChangesBanner({ kind }: { kind: ChangeKind }) {
  const pending = usePendingChanges().filter((c) => c.kind === kind);
  if (pending.length === 0) return null;
  return (
    <div className="banner banner-warn">
      <span className="grow">
        助理提交了 {pending.length} 个待审核的变更：{pending.map(changeTitle).join('、')}
      </span>
      <a href={consoleHref('approvals', { tab: 'changes', ...(pending.length === 1 ? { id: (pending[0] as ChangeRequestInfo).id } : {}) })}>去审核</a>
    </div>
  );
}

function StagedFiles({ id, files }: { id: string; files: Array<{ path: string; size: number }> }) {
  const [open, setOpen] = useState<string | null>(null);
  const body = useApi<{ text: string }>(open !== null ? `/api/changes/${enc(id)}/file${qs({ path: open })}` : null);
  return (
    <div className="change-files">
      <ul>
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={cx(open === f.path && 'on')} onClick={() => setOpen(f.path)}>
              <span className="mono">{f.path}</span>
              <span className="muted">{bytes(f.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        {open === null && <div className="muted small">点一个文件看它的内容。</div>}
        <ErrorText error={body.error} />
        {open !== null && body.data && <pre className="change-file-body">{body.data.text}</pre>}
      </div>
    </div>
  );
}

/** One request, in full, with the decision. Approving applies it at once. */
function ChangeModal({ id, onClose, onDecided }: { id: string; onClose: () => void; onDecided: () => void }) {
  const { canWrite } = useSession();
  const r = useApi<ChangeRequestDetail>(`/api/changes/${enc(id)}`);
  useReloadOn('change', r.reload, 300);
  const act = useAction();
  const [note, setNote] = useState('');
  const c = r.data;
  const decide = (decision: 'approve' | 'reject') =>
    void act.run(() => post(`/api/changes/${enc(id)}/decide`, { decision, ...(note.trim() ? { note: note.trim() } : {}) })).then((ok) => {
      r.reload();
      if (ok) onDecided();
    });
  const missing = c?.secrets?.filter((s) => !s.set) ?? [];
  const hasText = c !== undefined && (c.before !== null || c.after !== null);
  return (
    <Modal title={c ? changeTitle(c) : `变更 ${id}`} onClose={onClose}>
      <ErrorText error={r.error ?? act.error} />
      {c && (
        <>
          <dl className="change-meta">
            <dt>状态</dt>
            <dd>
              <StateBadge state={c.state} title={STATE_LABEL[c.state] ?? ''} /> {STATE_LABEL[c.state]}
              {c.state === 'pending' ? `，${dateTime(c.expiresAt)} 过期` : ''}
            </dd>
            <dt>助理的理由</dt>
            <dd>{c.reason}</dd>
            <dt>内容</dt>
            <dd>{c.summary}</dd>
            {c.source && (
              <>
                <dt>来源</dt>
                <dd className="mono">{c.source}</dd>
              </>
            )}
            <dt>提出</dt>
            <dd>
              {dateTime(c.createdAt)}
              {c.batchId && (
                <>
                  {' · '}
                  <a href={consoleHref('sessions', { tab: 'batches', batch: c.batchId })}>看这一批的过程</a>
                </>
              )}
            </dd>
            {c.decidedBy && (
              <>
                <dt>决定</dt>
                <dd>
                  {c.decidedBy} · {dateTime(c.decidedAt)}
                  {c.note ? ` · 备注：${c.note}` : ''}
                </dd>
              </>
            )}
            {c.result && (
              <>
                <dt>结果</dt>
                <dd>{c.result}</dd>
              </>
            )}
          </dl>
          {c.stale && <div className="banner banner-bad">提出之后，这个{KIND_LABEL[c.kind]}已经被改过了。现在同意不会应用任何东西，请让助理重新提议。</div>}
          {c.warnings.map((w) => (
            <div key={w} className="banner banner-warn">
              {w}
            </div>
          ))}
          {missing.length > 0 && (
            <div className="banner banner-warn">
              <span className="grow">它引用的秘密还没有值：{missing.map((s) => s.name).join('、')}。同意后服务器会因为缺少秘密而启动失败。</span>
              <a href={consoleHref('config', { tab: 'secrets' })}>去设置秘密</a>
            </div>
          )}
          {hasText && (
            <>
              <div className="change-section">{c.before === null ? '将要写入的内容' : c.after === null ? '将被移除的内容' : '改动'}</div>
              <Diff before={c.before} after={c.after} />
            </>
          )}
          {c.files && c.files.length > 0 && (
            <>
              <div className="change-section">
                将要安装的文件（{c.files.length} 个，{bytes(c.files.reduce((n, f) => n + f.size, 0))}）
              </div>
              {c.state === 'pending' ? (
                <StagedFiles id={c.id} files={c.files} />
              ) : (
                <div className="muted small">文件只在待审核期间保留：{c.files.map((f) => f.path).join('、')}</div>
              )}
            </>
          )}
          {c.state === 'pending' &&
            (canWrite ? (
              <div className="change-decide">
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="给助理的备注（可选）" maxLength={500} />
                <Button kind="danger" busy={act.busy} onClick={() => decide('reject')}>
                  拒绝
                </Button>
                <Button kind="primary" busy={act.busy} disabled={c.stale === true} title="同意后立即应用" onClick={() => decide('approve')}>
                  同意并应用
                </Button>
              </div>
            ) : (
              <div className="muted small change-decide">只有管理员可以决定。</div>
            ))}
        </>
      )}
    </Modal>
  );
}

/** The 能力变更 tab of the approvals page: what the assistant asked to change about itself. */
export function ChangeRequests({ selected }: { selected: string | null }) {
  const [all, setAll] = useState(false);
  const r = useApi<{ changes: ChangeRequestInfo[] }>(`/api/changes${all ? '' : '?state=pending'}`);
  useReloadOn('change', r.reload, 200);
  const open = (id?: string) => go('approvals', { tab: 'changes', ...(id !== undefined ? { id } : {}) });
  return (
    <Card
      title={all ? '全部能力变更' : '待审核的能力变更'}
      actions={
        <Button small kind="ghost" onClick={() => setAll(!all)}>
          {all ? '只看待审核' : '看全部记录'}
        </Button>
      }
    >
      <div className="muted small">助理不能自己改 MCP 服务器、Skills 和插件：它只能提议。这里的每一项都要你看过后手动同意，同意后由系统应用；自动审批、时限授权和聊天里的命令都不能代替。</div>
      <ErrorText error={r.error} />
      {r.data?.changes.length === 0 && <Empty>{all ? '没有记录' : '没有等待审核的变更'}</Empty>}
      <ul className="list">
        {r.data?.changes.map((c) => (
          <li key={c.id} className={cx('approval change-row clickable', selected === c.id && 'selected')} onClick={() => open(c.id)}>
            <div className="row">
              <strong>#{c.id}</strong> <StateBadge state={c.state} title={STATE_LABEL[c.state] ?? ''} /> <Badge tone="info">{KIND_LABEL[c.kind]}</Badge>
              <span className="grow">{changeTitle(c)}</span>
              <span className="muted small" title={dateTime(c.createdAt)}>
                {timeAgo(c.createdAt)}
              </span>
            </div>
            <div className="muted small">理由：{c.reason}</div>
            {(c.result || c.note) && <div className="muted small">{[c.result ? `结果：${c.result}` : '', c.note ? `备注：${c.note}` : ''].filter(Boolean).join(' · ')}</div>}
          </li>
        ))}
      </ul>
      {selected && <ChangeModal key={selected} id={selected} onClose={() => open()} onDecided={r.reload} />}
    </Card>
  );
}

/** In the conversation: a request is waiting. It can only be decided in the console, so this is a link. */
export function ChangeCards() {
  const pending = usePendingChanges();
  if (pending.length === 0) return null;
  return (
    <div className="approvals-stack">
      {pending.map((c) => (
        <div key={c.id} className="approval-card" role="alert">
          <div className="approval-body">
            <div className="approval-title">助理提议改动自己的能力，等你审核</div>
            <div className="approval-summary">{changeTitle(c)}</div>
            <div className="muted small">{c.reason}</div>
          </div>
          <div className="approval-actions">
            <a className="btn btn-small btn-primary" href={consoleHref('approvals', { tab: 'changes', id: c.id })}>
              去审核
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
