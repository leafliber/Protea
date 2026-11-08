import { useEffect, useRef, useState } from 'react';
import type { WhoAmIResponse } from '@protea/protocol';
import { IconConsole, IconChat, IconLogout, IconUser } from './icons';
import { consoleHref } from '../session';

/** The signed-in account: who it is, where to go, sign out. */
export function UserMenu({ me, onLogout, place }: { me: WhoAmIResponse; onLogout: () => void; place: 'chat' | 'console' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const name = me.username ?? (me.role === 'admin' ? '管理员令牌' : '只读令牌');
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="avatar-btn" aria-haspopup="menu" aria-expanded={open} title={name} onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{(me.username ?? '•').slice(0, 1).toUpperCase()}</span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            <div className="menu-name">{name}</div>
            <div className="muted small">{me.role === 'admin' ? '管理员' : '只读'}{me.username ? '' : ' · 用 API 令牌登录'}</div>
          </div>
          {place === 'chat' ? (
            <a role="menuitem" className="menu-item" href={consoleHref('overview')} onClick={() => setOpen(false)}>
              <IconConsole /> 控制台
            </a>
          ) : (
            <a role="menuitem" className="menu-item" href="#/" onClick={() => setOpen(false)}>
              <IconChat /> 对话
            </a>
          )}
          {me.username && (
            <a role="menuitem" className="menu-item" href={consoleHref('config', { tab: 'password' })} onClick={() => setOpen(false)}>
              <IconUser /> 修改密码
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <IconLogout /> 退出登录
          </button>
        </div>
      )}
    </div>
  );
}
