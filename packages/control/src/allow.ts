import { cidrsContain, isLoopback, type Cidr, type Logger } from '@protea/core';

/**
 * `control.allowCidrs` (docs/10-architecture/14-security-and-permissions.md §8): which client
 * addresses may use the control plane. An empty list allows any; loopback is always allowed
 * (the container healthcheck, `docker exec … protea`). `/hooks/*` is not gated here: webhook
 * senders are verified by the serving plugin. Behind a reverse proxy the address is the proxy's.
 */
export function addressGate(cidrs: () => readonly Cidr[], log: Logger): (ip: string, path: string) => boolean {
  const warned = new Map<string, number>();
  return (ip, path) => {
    const list = cidrs();
    if (list.length === 0 || path.startsWith('/hooks/')) return true;
    if (isLoopback(ip) || cidrsContain(list, ip)) return true;
    const now = Date.now();
    if ((warned.get(ip) ?? 0) < now - 60_000) {
      warned.set(ip, now);
      if (warned.size > 1000) warned.clear();
      log.warn({ ip, path }, 'refused a control plane request from an address outside control.allowCidrs');
    }
    return false;
  };
}
