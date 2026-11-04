import { useState } from 'react';
import type { SkillInfo } from '@protea/protocol';
import { api, enc, post, useAction, useApi } from '../api';
import { Badge, Button, Card, Empty, ErrorText, KV, StateBadge, oneLine, timeAgo } from '../components/ui';
import { useReloadOn } from '../live';
import { useSession } from '../session';
import { InstallForm } from './Plugins';

function SkillBody({ name }: { name: string }) {
  const r = useApi<SkillInfo & { body?: string; files?: Array<{ path: string; bytes: number }> }>(`/api/skills/${enc(name)}`);
  if (r.error) return <ErrorText error={r.error} />;
  const k = r.data;
  if (!k) return null;
  return (
    <>
      <KV
        rows={[
          ['来源', `${k.origin}${k.owner ? `：${k.owner}` : ''}${k.version ? ` · v${k.version}` : ''}`],
          ['允许的工具', k.allowedTools.length ? k.allowedTools.join(', ') : '—'],
          ['依赖的工具', k.requiresTools.length ? k.requiresTools.join(', ') : '—'],
          ['加载', `${k.loads} 次${k.lastLoadedAt ? `，最近 ${timeAgo(k.lastLoadedAt)}` : ''}`],
          ['文件', k.files?.length ? k.files.map((f) => f.path).join(', ') : '—'],
        ]}
      />
      {k.errors.length > 0 && <div className="banner banner-bad">{k.errors.join('；')}</div>}
      {k.warnings.length > 0 && <div className="banner banner-warn">{k.warnings.join('；')}</div>}
      {k.body && <pre className="text-block">{k.body}</pre>}
    </>
  );
}

export function Skills() {
  const { canWrite } = useSession();
  const r = useApi<{ skills: SkillInfo[] }>('/api/skills');
  useReloadOn('skills', r.reload);
  const [open, setOpen] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const act = useAction();
  return (
    <div className="page">
      <div className="row">
        <h1 className="grow">Skills</h1>
        {canWrite && <Button onClick={() => setInstalling((x) => !x)}>{installing ? '收起' : '安装 Skill'}</Button>}
      </div>
      {installing && (
        <Card title="安装 Skill">
          <InstallForm
            kind="skill"
            onDone={() => {
              setInstalling(false);
              r.reload();
            }}
          />
        </Card>
      )}
      <ErrorText error={r.error ?? act.error} />
      {r.data?.skills.length === 0 && <Empty>没有 Skill</Empty>}
      <ul className="list">
        {r.data?.skills.map((k) => {
          const state = k.errors.length ? 'invalid' : !k.enabled ? 'disabled' : k.listed ? 'listed' : 'pending';
          return (
            <li key={k.name}>
              <div className="row">
                <button className="link grow" onClick={() => setOpen(open === k.name ? null : k.name)}>
                  <strong>{k.name}</strong> <StateBadge state={state} title={!k.listed && k.enabled && !k.errors.length ? `缺少工具：${k.requiresTools.join(', ')}` : ''} /> <Badge tone="muted">{k.origin}</Badge>{' '}
                  <span className="muted small">{oneLine(k.description, 120)}</span>
                </button>
                {canWrite && k.origin !== 'mcp' && (
                  <>
                    {k.enabled ? (
                      <Button small onClick={() => void act.run(() => post(`/api/skills/${enc(k.name)}/disable`)).then(r.reload)}>
                        禁用
                      </Button>
                    ) : (
                      <Button small onClick={() => void act.run(() => post(`/api/skills/${enc(k.name)}/enable`)).then(r.reload)}>
                        启用
                      </Button>
                    )}
                    {k.origin === 'user' && (
                      <Button small kind="danger" onClick={() => confirm(`删除 Skill ${k.name}？`) && void act.run(() => api('DELETE', `/api/skills/${enc(k.name)}`)).then(r.reload)}>
                        删除
                      </Button>
                    )}
                  </>
                )}
              </div>
              {open === k.name && <SkillBody name={k.name} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
