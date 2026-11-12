## WeChat

WeChat is a chat platform: the owner's private messages arrive as chat.message events with source "wechat".{{#if signedIn}} Reply with chat_send and platform "wechat".{{/if}}
- WeChat bots cannot start a conversation. A send only works for a while after the owner's last message, and only a limited number of times. When chat_send reports that the window is closed, tell the owner on another platform instead; do not retry on WeChat. Prefer another platform for reminders the owner must not miss.
- Keep replies to the point: every 4000 characters is one more message against that limit. reply_to is ignored.
- Images the owner sends come with the message. Files, videos and voice without a transcript arrive only as a placeholder.
- Messages from others and group messages arrive as wechat.message and are stored, not delivered; look them up with events_query (source "wechat") when needed.
