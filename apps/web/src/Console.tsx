import { useEffect, useState, type ReactNode } from 'react';
import type { ApprovalInfo, StatusResponse, WhoAmIResponse } from '@protea/protocol';
import { useApi } from './api';
import { UserMenu } from './components/UserMenu';
import {
  IconActivity,
  IconBook,
  IconChat,
  IconCheckShield,
  IconClock,
  IconCpu,
  IconGauge,
  IconLayers,
  IconLock,
  IconLog,
  IconMenu,
  IconPanel,
  IconPlug,
  IconPuzzle,
  IconSettings,
  IconSparkles,
} from './components/icons';
import { EmptyState, PageActionsContext, cx } from './components/ui';
import { useLiveState, useReloadOn } from './live';
import { consoleHref, go, useSession } from './session';
import { movedTo } from './view-logic';
import { Approvals } from './pages/Approvals';
import { usePendingChanges } from './pages/Changes';
import { Config } from './pages/Config';
import { Events } from './pages/Events';
import { Logs } from './pages/Logs';
import { Mcp } from './pages/Mcp';
import { Memory } from './pages/Memory';
import { Overview } from './pages/Overview';
import { Permissions } from './pages/Permissions';
import { Plugins } from './pages/Plugins';
import { Providers } from './pages/Providers';
import { Schedules } from './pages/Schedules';
import { Sessions } from './pages/Sessions';
import { Skills } from './pages/Skills';

interface PageDef {
  id: string;
  label: string;
  desc: string;
  icon: ReactNode;
}

export const CONSOLE_GROUPS: Array<{ label: string; pages: PageDef[] }> = [
  {
    label: '',
    pages: [{ id: 'overview', label: '总览', desc: '需要你处理的事、助理正在做什么、接下来会做什么', icon: <IconGauge /> }],
  },
  {
    label: '待办',
    pages: [
      { id: 'approvals', label: '审批', desc: '等你点头的操作，和你处理过的记录', icon: <IconCheckShield /> },
      { id: 'schedules', label: '定时任务', desc: '到点让助理去做的事：每天的简报、每周的提醒、一次性的安排', icon: <IconClock /> },
    ],
  },
  {
    label: '观察',
    pages: [
      { id: 'events', label: '运行流', desc: '所有事件、用户输入、模型的思考与输出、工具调用和发出的消息', icon: <IconActivity /> },
      { id: 'sessions', label: '会话', desc: '主会话的转录与上下文、每一批的处理过程与后台 Fork', icon: <IconLayers /> },
      { id: 'logs', label: '日志', desc: '实时日志、检索、运行记录与诊断包', icon: <IconLog /> },
    ],
  },
  {
    label: '能力',
    pages: [
      { id: 'plugins', label: '插件', desc: '事件来源与工具插件：状态、配置与日志', icon: <IconPuzzle /> },
      { id: 'mcp', label: 'MCP', desc: '外部 MCP 服务器与它们提供的工具', icon: <IconPlug /> },
      { id: 'skills', label: 'Skills', desc: '助理按需加载的技能包', icon: <IconSparkles /> },
      { id: 'providers', label: '模型', desc: '模型供应商、协议、接口地址与按角色使用的模型', icon: <IconCpu /> },
      { id: 'memory', label: '记忆与人格', desc: '助理的记忆文件、全文检索与人格设定', icon: <IconBook /> },
    ],
  },
  {
    label: '系统',
    pages: [
      { id: 'permissions', label: '权限', desc: '哪些事助理可以直接做、哪些要先问你，以及留下的记录', icon: <IconLock /> },
      { id: 'config', label: '配置', desc: '生效配置、账号、秘密、预算、事件调度与备份', icon: <IconSettings /> },
    ],
  },
];

const ALL_PAGES = CONSOLE_GROUPS.flatMap((g) => g.pages);

const PHASE_LABEL: Record<string, string> = { idle: '空闲', delivering: '送达中', model: '思考中', tools: '运行工具', backoff: '模型不可用，重试中', handoff: '交接中', draining: '收尾中' };

function usePendingApprovals(): number {
  const { canWrite } = useSession();
  const r = useApi<{ approvals: ApprovalInfo[] }>(canWrite ? '/api/approvals?state=pending' : null);
  useReloadOn('approval', r.reload, 300);
  // Change requests the assistant filed wait in the same place.
  const changes = usePendingChanges().length;
  return (r.data?.approvals?.filter((a) => a.state === 'pending').length ?? 0) + changes;
}

const COLLAPSED_KEY = 'protea.side.collapsed';

/** The operator console: everything except the conversation. */
export function ConsoleShell({ me, page, params, status, reload, onLogout }: { me: WhoAmIResponse; page: string; params: URLSearchParams; status: StatusResponse | undefined; reload: () => void; onLogout: () => void }) {
  const ws = useLiveState();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const def = ALL_PAGES.find((p) => p.id === page);
  const approvals = usePendingApprovals();
  const phase = status?.phase ?? 'idle';
  const moved = movedTo(page, params);

  useEffect(() => {
    document.title = `${def?.label ?? '控制台'} · Protea 控制台`;
    setNavOpen(false);
  }, [page]);
  useEffect(() => {
    if (moved) go(moved.page, moved.params);
  }, [moved?.page, moved?.params['tab']]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // The choice lasts for this page only.
    }
  };

  // Only what waits for a decision gets a number: a count that is always there stops meaning anything.
  const counts: Record<string, number> = { approvals };
  return (
    <div className={cx('console', collapsed && 'console-narrow')}>
      <aside className={cx('side', navOpen && 'side-open')} aria-label="控制台导航">
        <a className="side-brand" href={consoleHref('overview')}>
          <img src="./favicon.svg" alt="" width="26" height="26" />
          <span className="side-brand-text">
            <b>Protea</b>
            <small>控制台</small>
          </span>
        </a>
        <a className="side-chat" href="#/" title="返回对话">
          <IconChat /> <span className="side-text">返回对话</span>
        </a>
        <nav className="side-nav">
          {CONSOLE_GROUPS.map((g) => (
            <div key={g.label || 'top'} className="side-group">
              {g.label && <div className="side-label">{g.label}</div>}
              {g.pages.map((p) => (
                <a key={p.id} href={consoleHref(p.id)} title={collapsed ? p.label : undefined} className={cx('side-item', page === p.id && 'side-on')} aria-current={page === p.id ? 'page' : undefined}>
                  {p.icon}
                  <span className="side-text">{p.label}</span>
                  {(counts[p.id] ?? 0) > 0 && (
                    <span className="side-count side-count-hot" aria-label={`${counts[p.id]} 项待处理`}>
                      {counts[p.id]}
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <span className="side-text">{status ? `${status.version} · run ${status.runId.slice(-6)}` : ' '}</span>
          <button type="button" className="icon-btn side-collapse" aria-label={collapsed ? '展开导航' : '收起导航'} title={collapsed ? '展开导航' : '收起导航'} aria-pressed={collapsed} onClick={toggle}>
            <IconPanel size={16} />
          </button>
        </div>
      </aside>
      {navOpen && <div className="side-backdrop" onClick={() => setNavOpen(false)} />}

      <div className="con-main">
        <header className="con-top">
          <button type="button" className="icon-btn con-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}>
            <IconMenu size={18} />
          </button>
          <div className="spacer" />
          {status?.scheduler.paused && (
            <a className="badge badge-bad" href={consoleHref('overview')}>
              投递已暂停
            </a>
          )}
          <span className={cx('pill', `phase-${phase}`)} title={status?.batchId ? `批 ${status.batchId}` : '主会话'}>
            <span className="lamp" />
            {PHASE_LABEL[phase] ?? phase}
          </span>
          <span className={cx('live-dot', `live-${ws}`)} role="img" aria-label={ws === 'open' ? '实时连接正常' : ws === 'connecting' ? '正在连接' : '实时连接已断开'} title={ws === 'open' ? '实时连接正常' : ws === 'connecting' ? '正在连接' : '实时连接已断开'} />
          <UserMenu me={me} onLogout={onLogout} place="console" />
        </header>
        <main className="con-body">
          <div className="page-head">
            <div className="page-title">
              <h1>{def?.label ?? '没有这个页面'}</h1>
              {def && <p>{def.desc}</p>}
            </div>
            <div className="page-actions" ref={setActionsEl} />
          </div>
          <PageActionsContext.Provider value={actionsEl}>
            {moved ? null : (
              <>
                {page === 'overview' && <Overview status={status} reload={reload} />}
                {page === 'events' && <Events params={params} />}
                {page === 'sessions' && <Sessions status={status} params={params} />}
                {page === 'schedules' && <Schedules params={params} />}
                {page === 'plugins' && <Plugins params={params} />}
                {page === 'providers' && <Providers />}
                {page === 'mcp' && <Mcp />}
                {page === 'skills' && <Skills />}
                {page === 'approvals' && <Approvals params={params} />}
                {page === 'permissions' && <Permissions params={params} />}
                {page === 'memory' && <Memory params={params} />}
                {page === 'config' && <Config />}
                {page === 'logs' && <Logs params={params} />}
                {!def && (
                  <EmptyState title="没有这个页面" action={<a href={consoleHref('overview')}>回到总览</a>}>
                    这个地址不对，或者页面已经改了名字。
                  </EmptyState>
                )}
              </>
            )}
          </PageActionsContext.Provider>
        </main>
      </div>
    </div>
  );
}
