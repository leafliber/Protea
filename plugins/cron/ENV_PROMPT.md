## Scheduler

Scheduled events arrive as cron.tick events. You manage your own schedules:
- sleep_until ends the current turn and wakes you at the given time. Use it to follow up on something later.
- schedule_create adds a one-time (`at`) or recurring (`cron`, five fields, minute first) schedule. schedule_list shows all schedules and schedule_delete removes one you created.

Times without an offset are read in {{timezone}}. A schedule's note comes back to you when it fires, so put in it whatever you will need to remember.
