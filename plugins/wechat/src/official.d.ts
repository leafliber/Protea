/**
 * Types for the parts of @tencent-weixin/openclaw-weixin the connector uses. The package ships
 * JavaScript without declarations, and its sources need the OpenClaw framework's types.
 */

declare module '@tencent-weixin/openclaw-weixin/dist/src/api/types.js' {
  export const MessageType: { readonly NONE: 0; readonly USER: 1; readonly BOT: 2 };
  export const MessageItemType: { readonly NONE: 0; readonly TEXT: 1; readonly IMAGE: 2; readonly VOICE: 3; readonly FILE: 4; readonly VIDEO: 5 };

  export interface CdnMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
  }
  export interface MessageItem {
    type?: number;
    msg_id?: string;
    text_item?: { text?: string };
    image_item?: { media?: CdnMedia; aeskey?: string };
    voice_item?: { media?: CdnMedia; text?: string };
    file_item?: { media?: CdnMedia; file_name?: string };
    video_item?: { media?: CdnMedia };
    ref_msg?: { message_item?: MessageItem; title?: string; svr_id?: string };
  }
  export interface WeixinMessage {
    seq?: number;
    message_id?: string;
    from_user_id?: string;
    to_user_id?: string;
    create_time_ms?: number;
    group_id?: string;
    message_type?: number;
    message_state?: number;
    item_list?: MessageItem[];
    context_token?: string;
  }
  export interface GetUpdatesResp {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: WeixinMessage[];
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
  }
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/api/api.js' {
  import type { GetUpdatesResp } from '@tencent-weixin/openclaw-weixin/dist/src/api/types.js';

  export function apiGetFetch(p: { baseUrl: string; endpoint: string; timeoutMs?: number; label: string }): Promise<string>;
  export function apiPostFetch(p: { baseUrl: string; endpoint: string; body: string; token?: string; timeoutMs?: number; label: string; abortSignal?: AbortSignal }): Promise<string>;
  export function getUpdates(p: { baseUrl: string; token?: string; get_updates_buf?: string; timeoutMs?: number; abortSignal?: AbortSignal }): Promise<GetUpdatesResp>;
  export function notifyStart(p: { baseUrl: string; token?: string; timeoutMs?: number }): Promise<unknown>;
  export function notifyStop(p: { baseUrl: string; token?: string; timeoutMs?: number }): Promise<unknown>;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/api/session-guard.js' {
  export const STALE_TOKEN_ERRCODE: number;
  export function pauseSession(accountId: string): void;
  export function isSessionPaused(accountId: string): boolean;
  export function getRemainingPauseMs(accountId: string): number;
  export function _resetForTest(): void;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js' {
  export const DEFAULT_BASE_URL: string;
  export const CDN_BASE_URL: string;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/util/logger.js' {
  export function setLogLevel(level: string): void;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js' {
  export class StreamingMarkdownFilter {
    feed(delta: string): string;
    flush(): string;
  }
  export function sendMessageWeixin(p: { to: string; text: string; opts: { baseUrl: string; token?: string; contextToken?: string; timeoutMs?: number } }): Promise<{ messageId: string; serverMessageId?: string }>;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js' {
  import type { WeixinMessage } from '@tencent-weixin/openclaw-weixin/dist/src/api/types.js';

  export function getWeixinMessageId(msg: WeixinMessage): string | undefined;
  export function weixinMessageToMsgContext(msg: WeixinMessage, accountId: string): { Body: string; ReplyToBody?: string };
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/media/media-download.js' {
  import type { MessageItem } from '@tencent-weixin/openclaw-weixin/dist/src/api/types.js';

  export function downloadMediaFromItem(
    item: MessageItem,
    deps: {
      cdnBaseUrl: string;
      saveMedia: (buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string) => Promise<{ path: string }>;
      log: (msg: string) => void;
      errLog: (msg: string) => void;
      label: string;
    },
  ): Promise<{ decryptedPicPath?: string }>;
}
