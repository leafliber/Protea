---
name: protea-self-ops
description: How to inspect and manage your own runtime in Protea — status, the event log, schedules, forks, approvals and budget limits. Use when the owner asks what you are doing or have pending, why something did not happen, to change a schedule, when you need to check on background work, or when a budget or rate-limit notice arrives.
metadata:
  version: 2
  requires-tools: self_status events_query
---

# Running yourself

## Look before you act
- `self_status` shows the phase, pending events per level, plugins, forks and the day's spend. Start here when the owner asks "what are you doing" or "is X working".
- `events_query` searches the event log, newest first. Events stored without being delivered have state `archived`; filter by `source` (plugin id) or exact `type`. Use it to answer "did the webhook fire?" or "what came in overnight?".
- `events_promote` moves an archived or pending event into the next turn when it turns out to matter.

## Schedules
- `schedule_list` before `schedule_create`, so you do not add a duplicate. Recurring schedules use five-field cron (minute first); one-time ones use `at`.
- Put everything you will need into the schedule's `note`: it is all you get back when it fires.
- `sleep_until` is for "remind me / check again at T" inside the current work; it ends the turn.
- You can delete only schedules you created. Ones from config.yaml belong to the owner: tell them which key to change.

## Background work
- Hand long, self-contained work (research, a long summary) to `fork_spawn` with a goal that says what "done" looks like. Keep answering the owner meanwhile.
- `fork_status` shows progress; `fork_cancel` stops one. A fork reports back with a `fork.completed` event — pass on what matters, briefly.

## Restricted tools
- A tool that needs approval returns "pending approval aN" and did not run. Tell the owner what you want to do and why, in one line. When the `approval.decided` event says it was approved, call the tool again with exactly the same input.
- Use `approval_request` to ask ahead when you already know you will need a restricted tool.
- Denied or "not allowed" tools: do not look for a way around it. Say what you could not do.

## When something is broken
- A plugin or MCP server that crashed restarts on its own; one marked `failed` needs the owner. Say which one and what its error says, and carry on with what still works.

## Budget and limits
- When a level's budget runs out, new L2 events only ride along with other batches, and new L3/L4 events are stored without reaching you; past the global cap only the owner's events (L0/L1) arrive. A `budget.exhausted` or `budget.hard_cap` event tells you when this starts. `self_status` shows how many events are held.
- Tell the owner once, briefly, if it matters to them; only they can release the budget (console or `protea budget release`). Do not try to work around it, for example by promoting held events one by one.
- When a `budget.recovered` event lists stored events, promote only the ones that still matter.
- Sending is rate-limited per channel (by default 20 calls a minute). If a send fails with "outbound calls in the last minute", wait and combine what you have to say into one message.
