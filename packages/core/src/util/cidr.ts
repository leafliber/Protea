import net from 'node:net';

/** An address range from `control.allowCidrs`: "10.0.0.0/8", "fd00::/8", or a single address. */
export interface Cidr {
  family: 4 | 6;
  /** The network address as a 32- or 128-bit integer. */
  base: bigint;
  bits: number;
  text: string;
}

function v4ToBig(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function v6ToBig(ip: string): bigint {
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToBig(v4[1] as string);
    s = `${s.slice(0, -(v4[1] as string).length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

/** Parse a CIDR; throws with a readable message. */
export function parseCidr(text: string): Cidr {
  const [addr, len] = text.trim().split('/') as [string, string | undefined];
  const family = net.isIP(addr);
  if (family === 0) throw new Error(`"${text}" is not an IP address or CIDR`);
  const max = family === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`"${text}": the prefix length must be 0-${max}`);
  const value = family === 4 ? v4ToBig(addr) : v6ToBig(addr);
  const width = BigInt(max);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << (width - BigInt(bits));
  return { family: family as 4 | 6, base: value & mask, bits, text: text.trim() };
}

/** Normalise an address as seen on a socket: IPv4-mapped IPv6 becomes IPv4. */
function normalise(ip: string): { family: 4 | 6; value: bigint } | null {
  let a = ip.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1] as string;
  const family = net.isIP(a);
  if (family === 0) return null;
  return { family: family as 4 | 6, value: family === 4 ? v4ToBig(a) : v6ToBig(a) };
}

export function isLoopback(ip: string): boolean {
  const n = normalise(ip);
  if (!n) return false;
  return n.family === 4 ? n.value >> 24n === 127n : n.value === 1n;
}

/** Does any range contain the address? */
export function cidrsContain(cidrs: readonly Cidr[], ip: string): boolean {
  const n = normalise(ip);
  if (!n) return false;
  for (const c of cidrs) {
    if (c.family !== n.family) continue;
    const width = BigInt(c.family === 4 ? 32 : 128);
    const mask = c.bits === 0 ? 0n : ((1n << BigInt(c.bits)) - 1n) << (width - BigInt(c.bits));
    if ((n.value & mask) === c.base) return true;
  }
  return false;
}
