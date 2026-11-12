import type { ChecklistItem, Task } from './api.js';
import { PRIORITIES, type PriorityName } from './format.js';
import { fromApiTime, isTimeZone, parseWhen, toApiTime } from './time.js';

export interface ItemInput {
  id?: string;
  title: string;
  done?: boolean;
  start?: string | null;
  time_zone?: string;
  sort_order?: number;
}

/** The task fields a tool input may set; the same for creating, updating and batches. */
export interface TaskInput {
  title?: string;
  content?: string;
  desc?: string;
  start?: string | null;
  due?: string | null;
  all_day?: boolean;
  time_zone?: string;
  priority?: PriorityName;
  tags?: string[];
  reminders?: string[];
  repeat?: string | null;
  repeat_from?: keyof typeof REPEAT_FROM;
  kind?: 'TEXT' | 'NOTE' | 'CHECKLIST';
  parent_id?: string;
  sort_order?: number;
  items?: ItemInput[];
}

const REPEAT_FROM = { due_date: '0', completed_date: '1', default: '2' } as const;

const WHEN = 'A day (2026-11-13) or a time (2026-11-13T15:00, read in time_zone; or an instant with an offset).';

/** JSON Schema of `TaskInput`, spread into the tools that take task fields. */
export const TASK_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: 2000 },
  content: { type: 'string', description: 'The notes under the title.' },
  desc: { type: 'string', description: 'Description of a CHECKLIST task (shown above its items).' },
  start: { type: ['string', 'null'], description: `When the task is scheduled. ${WHEN} null removes it.` },
  due: { type: ['string', 'null'], description: 'End of the task when it spans a period; leave it out for a task with one date. null removes it.' },
  all_day: { type: 'boolean', description: 'Default: true when start is a plain day.' },
  time_zone: { type: 'string', description: "IANA zone of the task's times (default: the configured zone)." },
  priority: { enum: Object.keys(PRIORITIES) },
  tags: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'All tags of the task (replaces the current ones).' },
  reminders: {
    type: 'array',
    items: { type: 'string', pattern: '^TRIGGER:' },
    description: 'iCalendar triggers relative to start: "TRIGGER:PT0S" at the time, "TRIGGER:-PT30M" 30 minutes before, "TRIGGER:P0DT9H0M0S" at 09:00 on the day of an all-day task.',
  },
  repeat: { type: ['string', 'null'], description: 'Recurrence rule such as "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"; null stops the repetition.' },
  repeat_from: { enum: Object.keys(REPEAT_FROM), description: 'due_date: follow the original schedule; completed_date: count from when it was completed; default: the next occurrence from today.' },
  kind: { enum: ['TEXT', 'NOTE', 'CHECKLIST'] },
  parent_id: { type: 'string', description: 'task_id of the parent, making this a subtask; "" detaches it.' },
  sort_order: { type: 'integer' },
  items: {
    type: 'array',
    description: 'Checklist items; the list replaces the current one, so repeat an item (with its id) to keep it.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        id: { type: 'string', description: 'Item id of an existing item.' },
        title: { type: 'string', minLength: 1 },
        done: { type: 'boolean' },
        start: { type: ['string', 'null'], description: 'Day or time of the item.' },
        time_zone: { type: 'string' },
        sort_order: { type: 'integer' },
      },
    },
  },
} as const;

function zoneOf(input: string | undefined, fallback: string): string {
  if (input === undefined) return fallback;
  if (!isTimeZone(input)) throw new Error(`"${input}" is not an IANA time zone (write it like Asia/Shanghai)`);
  return input;
}

function itemBody(i: ItemInput, zone: string, existing: ChecklistItem | undefined): ChecklistItem {
  const out: Record<string, unknown> = { ...existing, title: i.title };
  if (i.id !== undefined) out['id'] = i.id;
  if (i.done !== undefined) out['status'] = i.done ? 1 : 0;
  if (i.sort_order !== undefined) out['sortOrder'] = i.sort_order;
  if (i.start === null) {
    delete out['startDate'];
    delete out['isAllDay'];
  } else if (i.start !== undefined) {
    const itemZone = zoneOf(i.time_zone, zone);
    const w = parseWhen(i.start, itemZone);
    out['startDate'] = toApiTime(w.ms);
    out['isAllDay'] = w.dayOnly;
    out['timeZone'] = itemZone;
  }
  return out as ChecklistItem;
}

/**
 * The API fields a tool input sets, and nothing else. `existing` is the task being updated:
 * its zone is the default for wall-clock times, and its dates decide what a lone `due` means.
 */
export function taskBody(input: TaskInput, tz: string, existing?: Task): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body['title'] = input.title;
  if (input.content !== undefined) body['content'] = input.content;
  if (input.desc !== undefined) body['desc'] = input.desc;

  const zone = zoneOf(input.time_zone, existing?.timeZone && isTimeZone(existing.timeZone) ? existing.timeZone : tz);
  const start = input.start === undefined || input.start === null ? input.start : parseWhen(input.start, zone);
  const due = input.due === undefined || input.due === null ? input.due : parseWhen(input.due, zone);
  let startMs = start ? start.ms : start;
  const dueMs = due ? due.ms : due;
  // A task with only an end is shown on that day: Dida365 keys a task's date on its start.
  if (typeof dueMs === 'number' && startMs === undefined && !existing?.startDate) startMs = dueMs;
  const begins = typeof startMs === 'number' ? startMs : startMs === undefined ? fromApiTime(existing?.startDate) : undefined;
  const ends = typeof dueMs === 'number' ? dueMs : dueMs === undefined ? fromApiTime(existing?.dueDate) : undefined;
  if (begins !== undefined && ends !== undefined && ends < begins) throw new Error('due is before start');
  if (startMs !== undefined) body['startDate'] = startMs === null ? null : toApiTime(startMs);
  if (dueMs !== undefined) body['dueDate'] = dueMs === null ? null : toApiTime(dueMs);
  const dated = typeof startMs === 'number' || typeof dueMs === 'number';
  if (dated || input.time_zone !== undefined) body['timeZone'] = zone;
  if (input.all_day !== undefined) body['isAllDay'] = input.all_day;
  // Plain days make an all-day task; a new start decides it, a lone end only on a task that had no date.
  else if (start) body['isAllDay'] = start.dayOnly && (!due || due.dayOnly);
  else if (due && !existing?.startDate) body['isAllDay'] = due.dayOnly;

  if (input.priority !== undefined) body['priority'] = PRIORITIES[input.priority];
  if (input.tags !== undefined) body['tags'] = input.tags;
  if (input.reminders !== undefined) body['reminders'] = input.reminders;
  if (input.repeat !== undefined) body['repeatFlag'] = input.repeat;
  if (input.repeat_from !== undefined) body['repeatFrom'] = REPEAT_FROM[input.repeat_from];
  if (input.kind !== undefined) body['kind'] = input.kind;
  if (input.parent_id !== undefined) body['parentId'] = input.parent_id;
  if (input.sort_order !== undefined) body['sortOrder'] = input.sort_order;
  if (input.items !== undefined) {
    const known = new Map((existing?.items ?? []).filter((x) => x.id).map((x) => [x.id as string, x]));
    body['items'] = input.items.map((i) => itemBody(i, zone, i.id ? known.get(i.id) : undefined));
  }
  return body;
}

const WRITABLE = ['title', 'content', 'desc', 'isAllDay', 'startDate', 'dueDate', 'timeZone', 'reminders', 'tags', 'repeatFlag', 'repeatFrom', 'priority', 'sortOrder', 'items', 'kind', 'parentId'] as const;

/**
 * The whole editable task with `changes` laid over it. The documentation does not say whether
 * an update keeps the fields a request leaves out, so an update always sends them all.
 */
export function mergedTask(existing: Task, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: existing.id, projectId: existing.projectId };
  for (const k of WRITABLE) if (existing[k] !== undefined && existing[k] !== null) out[k] = existing[k];
  return { ...out, ...changes };
}
