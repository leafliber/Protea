import { useState, type FormEvent } from 'react';
import { api, qs, useApi } from '../api';
import { Button, Card, Editor, Empty, ErrorText, Tabs, timeAgo } from '../components/ui';
import { go, useSession } from '../session';

interface FileRow {
  path: string;
  size: number;
  mtime: string;
}

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

function MemoryTab({ selected }: { selected: string | null }) {
  const { canWrite } = useSession();
  const tree = useApi<{ files: FileRow[] }>('/api/memory/tree');
  const file = useApi<{ path: string; text: string }>(selected ? `/api/memory/file${qs({ path: selected })}` : null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ path: string; snippet: string }> | null>(null);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setHits((await api<{ hits: Array<{ path: string; snippet: string }> }>('GET', `/api/memory/search${qs({ q, limit: 20 })}`)).hits);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const select = (p: string) => go('memory', { tab: 'memory', file: p.replace(/^\/memories\//, '') });
  return (
    <div className="split">
      <Card title="记忆目录" className="split-side">
        <form className="row" onSubmit={(e) => void search(e)}>
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="全文检索（中文可直接搜）" />
          <Button type="submit" disabled={!q.trim()}>
            搜索
          </Button>
        </form>
        <ErrorText error={error ?? tree.error} />
        {hits && (
          <div className="hits">
            {hits.length === 0 && <div className="muted">没有匹配</div>}
            {hits.map((h) => (
              <button key={h.path} className="hit link" onClick={() => select(h.path)}>
                <strong>{h.path.replace(/^\/memories\//, '')}</strong>
                <span className="muted small">{h.snippet}</span>
              </button>
            ))}
            <Button small kind="ghost" onClick={() => setHits(null)}>
              收起结果
            </Button>
          </div>
        )}
        <FileTree files={tree.data?.files ?? []} selected={selected} onSelect={select} />
        {canWrite && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const p = newPath.trim().replace(/^\/memories\//, '').replace(/^\/+/, '');
              if (p) {
                void api('PUT', `/api/memory/file${qs({ path: p })}`, '', { text: true }).then(() => {
                  tree.reload();
                  setNewPath('');
                  select(p);
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
            readOnly={!canWrite}
            onSave={async (text) => {
              await api('PUT', `/api/memory/file${qs({ path: selected })}`, text, { text: true });
              file.reload();
              tree.reload();
            }}
          />
        )}
        {selected === 'INDEX.md' && <div className="muted small">INDEX.md 在系统提示里：每次修改都会让提示缓存失效一次，请保持简短。</div>}
      </Card>
    </div>
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
          SOUL.md：身份与说话方式；OPERATING.md：行为准则；USER.md：主人画像；plugins/&lt;id&gt;/ENV_PROMPT.md：插件环境提示覆盖。保存后从下一次模型请求生效（缓存失效一次）。钩子文件（hooks.*）是代码，不在这里编辑。
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

export function Memory({ params }: { params: URLSearchParams }) {
  const tab = (params.get('tab') ?? 'memory') as 'memory' | 'persona';
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['memory', '记忆'],
          ['persona', '人格'],
        ]}
        value={tab}
        onChange={(t) => go('memory', { tab: t })}
      />
      {tab === 'memory' ? <MemoryTab selected={params.get('file')} /> : <PersonaTab selected={params.get('file')} />}
    </div>
  );
}
