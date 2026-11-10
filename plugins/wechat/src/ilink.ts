import fs from 'node:fs';
import path from 'node:path';
import { setLogLevel } from '@tencent-weixin/openclaw-weixin/dist/src/util/logger.js';

/**
 * The one place that names the official package's files, so that an upgrade has one thing to
 * check. Not used on purpose: `auth/login-qr.js` (reads stdin and writes to stdout, which are the
 * plugin protocol here) and `monitor/monitor.js` (runs inside the OpenClaw gateway).
 */
export { apiGetFetch, apiPostFetch, getUpdates, notifyStart, notifyStop } from '@tencent-weixin/openclaw-weixin/dist/src/api/api.js';
export { MessageItemType, MessageType } from '@tencent-weixin/openclaw-weixin/dist/src/api/types.js';
export type { GetUpdatesResp, WeixinMessage } from '@tencent-weixin/openclaw-weixin/dist/src/api/types.js';
export { STALE_TOKEN_ERRCODE, getRemainingPauseMs, isSessionPaused, pauseSession } from '@tencent-weixin/openclaw-weixin/dist/src/api/session-guard.js';
export { CDN_BASE_URL, DEFAULT_BASE_URL } from '@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js';
export { StreamingMarkdownFilter, sendMessageWeixin } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js';
export { getWeixinMessageId, weixinMessageToMsgContext } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js';
export { downloadMediaFromItem } from '@tencent-weixin/openclaw-weixin/dist/src/media/media-download.js';

const BOT_AGENT = 'Protea/0.1.0';

/**
 * Before the first request. The package's own log file would hold QR links and CDN addresses
 * outside the data directory, so it is off (Protea logs through the host). Its settings come from
 * an OpenClaw config file: point it at ours, so it says who is calling and never reads a real
 * OpenClaw install on the same machine.
 */
export function prepareOfficialClient(dataDir: string): void {
  setLogLevel('FATAL');
  const file = path.join(dataDir, 'openclaw.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ channels: { 'openclaw-weixin': { botAgent: BOT_AGENT } } }));
  process.env['OPENCLAW_CONFIG'] = file;
}
