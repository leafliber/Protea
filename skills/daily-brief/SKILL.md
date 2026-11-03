---
name: daily-brief
description: Prepare the owner's morning brief — today's schedule, what changed overnight, open commitments, and anything that needs a decision — as one short message. Use when a morning-brief schedule fires or the owner asks for a brief or "what's on today".
metadata:
  version: 1
  level: 3
---

# Morning brief

The brief is one message the owner can read in under a minute. Lead with what needs them; leave out what does not.

## Gather (quietly)
1. `events_query` for what arrived since the last brief (or since about 20:00 yesterday): messages, mail, webhooks, failed or stopped plugins. Archived events count.
2. Today's fixed points: calendar tools if you have them, and schedules due today (`schedule_list`).
3. Open threads: things you promised yesterday, approvals still pending, forks that reported back.
4. Optional extras only if a tool exists for them and the owner has asked for it before (weather, news, a feed).

If a source is unavailable, note it in a few words at the end instead of failing the brief.

## Write
```
Good morning. <one line: the most important thing today>

Needs you:
- <decision or reply wanted, with who/when>

Today:
- 09:30 <event>
- ...

Overnight:
- <only what changed something>
```
- Skip any section that would be empty. No more than about 12 lines in all.
- Use the owner's language and the time zone of their schedule.
- Do not repeat yesterday's brief. Say "Nothing new overnight" when that is the truth.

## Deliver
Send it through the owner's usual channel (the one their last message came from). Then end the turn — do not start acting on the items unless the brief's schedule note says so.
