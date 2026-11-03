import { RpcPeer, lineSplitter } from '@protea/protocol';
import { servePlugin, type PluginDefinition } from './plugin.js';

export * from './plugin.js';

/**
 * Run a plugin over stdio (the out-of-process protocol). stdout carries only protocol
 * messages, so console output is redirected to stderr, which the host captures as logs.
 */
export function runPlugin<C>(def: PluginDefinition<C>): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const peer = new RpcPeer({
    write: (line) => {
      process.stdout.write(line);
    },
    onProtocolError: (msg, detail) => process.stderr.write(`protocol: ${msg}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`),
  });
  servePlugin(peer, def, {
    env: process.env,
    onStopped: () => {
      // Exit once the reply to `stop` has been flushed.
      process.stdout.write('', () => process.exit(0));
    },
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', lineSplitter((line) => peer.receive(line)));
  process.stdin.on('end', () => {
    peer.close(new Error('host closed stdin'));
    process.exit(0);
  });
}
