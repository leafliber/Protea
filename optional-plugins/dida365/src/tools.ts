import type { Host, PluginTool, ToolContext } from '@protea/plugin-sdk';
import type { ApprovalPresentation } from '@protea/protocol';
import {
  apiPath,
  type BatchResult,
  type Column,
  type Comment,
  type Countdown,
  type DidaApi,
  type Focus,
  type Habit,
  type HabitCheckin,
  type HabitSection,
  type Member,
  type Preference,
  type Project,
  type ProjectData,
  type ProjectGroup,
  type Tag,
  type Task,
} from './api.js';
import { TOOLSETS, type Dida365Config, type Settings, type Toolset } from './config.js';
import {
  FOCUS_TYPES,
  PRIORITIES,
  TASK_STATUS,
  checkinEntry,
  columnEntry,
  commentEntry,
  countdownEntry,
  focusEntry,
  groupEntry,
  habitEntry,
  listing,
  memberEntry,
  projectEntry,
  sectionEntry,
  tagEntry,
  taskDetail,
  taskEntry,
  type FocusTypeName,
  type FormatContext,
  type PriorityName,
  type TaskStatusName,
} from './format.js';
import { TASK_PROPERTIES, mergedTask, taskBody, type TaskInput } from './task-input.js';
import { DAY_MS, dayOf, fromApiTime, minuteOf, parseRangeEnd, parseWhen, toApiTime, toStamp } from './time.js';

type DidaHost = Host<Dida365Config>;
type DidaTool = PluginTool<any, Dida365Config>;

/** What the tools need from the plugin. */
export interface Runtime {
  api: DidaApi;
  now(): number;
  settings(host: DidaHost): Settings;
  /** Project names by id, for labelling tasks; empty when they cannot be read. */
  projectNames(signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
  /** Projects were created, renamed or deleted. */
  forgetProjects(): void;
  /** One line about the due-task reminders. */
  reminderStatus(host: DidaHost): Promise<string>;
}

const MAX_BATCH = 50;
const UNDONE_MAX_DAYS = 14;
/** Reads that run side by side when a batch update has to look at each task first. */
const READ_AHEAD = 4;

const id = (description: string) => ({ type: 'string', minLength: 1, maxLength: 200, description });
const ids = (description: string) => ({ type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 200 }, description });
const when = (description: string) => ({ type: 'string', description: `${description} A day (2026-11-13) or a time (2026-11-13T15:00).` });
const LIMIT = { type: 'integer', minimum: 1, maximum: 200, description: 'Show at most this many (never more than the configured maximum).' };
const PROJECT = id('project_id of the list the task is in ("inbox" for the inbox).');
const TASK = id('task_id.');
const READ = { readOnly: true } as const;
const WRITE = { sideEffect: true } as const;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required } : {}), properties });

const fail = (text: string): { text: string; failed: true } => ({ text, failed: true });

async function mapLimit<T, R>(items: readonly T[], limit: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i] as T);
      }
    }),
  );
  return out;
}

function chunks<T>(all: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

const TASK_ID = { zh: '任务', en: 'Task' };
const PROJECT_ID = { zh: '清单', en: 'List' };

/**
 * How each tool that changes something reads when the owner is asked to approve it
 * (ADR-0021): what it does, the input that matters most, and the others worth showing.
 */
export const APPROVALS: Record<string, ApprovalPresentation> = {
  dida_task_create: {
    title: { zh: '在滴答清单新建任务', en: 'Add a Dida365 task' },
    target: 'title',
    fields: { project_id: PROJECT_ID, start: { zh: '开始', en: 'Starts' }, due: { zh: '截止', en: 'Due' }, priority: { zh: '优先级', en: 'Priority' }, tags: { zh: '标签', en: 'Tags' } },
  },
  dida_task_update: {
    title: { zh: '修改滴答清单任务', en: 'Change a Dida365 task' },
    target: 'title',
    fields: { task_id: TASK_ID, start: { zh: '开始', en: 'Starts' }, due: { zh: '截止', en: 'Due' }, priority: { zh: '优先级', en: 'Priority' }, repeat: { zh: '重复', en: 'Repeats' } },
  },
  dida_task_complete: { title: { zh: '完成滴答清单任务', en: 'Complete Dida365 tasks' }, target: 'task_ids', fields: { project_id: PROJECT_ID } },
  dida_task_move: { title: { zh: '把滴答清单任务移到其他清单', en: 'Move Dida365 tasks to another list' }, fields: { moves: { zh: '移动的任务数', en: 'Tasks moved' } } },
  dida_task_batch: { title: { zh: '批量新建或修改滴答清单任务', en: 'Add or change Dida365 tasks in bulk' }, fields: { add: { zh: '新建几项', en: 'To add' }, update: { zh: '修改几项', en: 'To change' } } },
  dida_task_assign: { title: { zh: '指派滴答清单任务', en: 'Assign a Dida365 task' }, target: 'assignee', fields: { task_id: TASK_ID, project_id: PROJECT_ID } },
  dida_comment_add: { title: { zh: '给滴答清单任务加评论', en: 'Comment on a Dida365 task' }, target: 'text', fields: { task_id: TASK_ID } },
  dida_project_save: { title: { zh: '新建或修改滴答清单的清单', en: 'Create or change a Dida365 list' }, target: 'name', fields: { project_id: PROJECT_ID, view_mode: { zh: '视图', en: 'View' }, kind: { zh: '类型', en: 'Kind' }, color: { zh: '颜色', en: 'Color' } } },
  dida_group_save: { title: { zh: '新建或重命名清单分组', en: 'Create or rename a Dida365 list group' }, target: 'name', fields: { group_id: { zh: '分组', en: 'Group' } } },
  dida_column_save: { title: { zh: '新建或重命名看板列', en: 'Add or rename a kanban column' }, target: 'name', fields: { project_id: PROJECT_ID, column_id: { zh: '列', en: 'Column' } } },
  dida_tag_create: { title: { zh: '新建滴答清单标签', en: 'Create a Dida365 tag' }, target: 'name' },
  dida_focus_create: { title: { zh: '补记一次专注', en: 'Record a focus session' }, target: 'note', fields: { type: { zh: '类型', en: 'Type' }, start: { zh: '开始', en: 'From' }, end: { zh: '结束', en: 'To' }, task_id: TASK_ID } },
  dida_habit_save: { title: { zh: '新建或修改习惯', en: 'Create or change a habit' }, target: 'name', fields: { habit_id: { zh: '习惯', en: 'Habit' }, repeat: { zh: '重复', en: 'Repeats' }, goal: { zh: '目标', en: 'Goal' }, unit: { zh: '单位', en: 'Unit' } } },
  dida_habit_checkin: { title: { zh: '习惯打卡', en: 'Check in a habit' }, target: 'habit_id', fields: { date: { zh: '日期', en: 'Day' }, value: { zh: '完成量', en: 'Amount' } } },
  dida_delete: {
    title: { zh: '从滴答清单永久删除', en: 'Delete from Dida365 for good' },
    target: 'type',
    fields: { task_id: TASK_ID, comment_id: { zh: '评论', en: 'Comment' }, project_id: PROJECT_ID, group_id: { zh: '分组', en: 'Group' }, focus_id: { zh: '专注记录', en: 'Focus record' } },
  },
};

/** What dida_delete removes, by its `type`. */
const DELETABLE: Record<string, string> = { task: 'task', comment: 'comment', project: 'project', project_group: 'project group', focus: 'focus record' };

/** The tools of one tool set; `core` ones are always offered. */
export interface ToolEntry {
  set: Toolset | 'core';
  tool: DidaTool;
}

export function buildTools(rt: Runtime, enabled: ReadonlySet<Toolset>): ToolEntry[] {
  const { api } = rt;

  const context = async (host: DidaHost, signal?: AbortSignal): Promise<FormatContext & { limit(asked?: number): number }> => {
    const s = rt.settings(host);
    const names = await rt.projectNames(signal);
    return {
      tz: s.tz,
      projectName: (pid) => (pid.startsWith('inbox') ? 'Inbox' : names.get(pid)),
      limit: (asked) => Math.min(asked ?? s.maxResults, s.maxResults),
    };
  };
  const taskList = async (title: string, tasks: Task[] | undefined, host: DidaHost, ctx: ToolContext, asked: number | undefined, empty: string): Promise<string> => {
    const c = await context(host, ctx.signal);
    return listing(`${title}; times in ${c.tz}`, tasks ?? [], (t) => taskEntry(t, c), c.limit(asked), empty);
  };
  const range = (from: string | undefined, to: string | undefined, tz: string): { from?: number; to?: number } => {
    const a = from !== undefined ? parseWhen(from, tz).ms : undefined;
    const b = to !== undefined ? parseRangeEnd(to, tz) : undefined;
    if (a !== undefined && b !== undefined && b < a) throw new Error('the range ends before it starts');
    return { ...(a !== undefined ? { from: a } : {}), ...(b !== undefined ? { to: b } : {}) };
  };
  const statusCodes = (names: TaskStatusName[] | undefined): number[] | undefined => (names?.length ? names.map((n) => TASK_STATUS[n]) : undefined);
  const groupNames = async (signal: AbortSignal): Promise<{ groups: ProjectGroup[]; error?: string }> => {
    try {
      return { groups: (await api.get<ProjectGroup[]>('/project/group', { signal })) ?? [] };
    } catch (err) {
      return { groups: [], error: (err as Error).message };
    }
  };

  const core: DidaTool[] = [
    {
      name: 'dida_status',
      description: 'Check the connection to Dida365: whether the API token works, the account time zone, which tool sets are on and what the due-task reminders last did.',
      inputSchema: object({}),
      flags: READ,
      handler: async (_i: Record<string, never>, ctx, host) => {
        const s = rt.settings(host);
        let pref: Preference | undefined;
        try {
          pref = await api.post<Preference>('/preference', undefined, { signal: ctx.signal });
        } catch (err) {
          return fail(`Not connected to ${api.base}: ${(err as Error).message}`);
        }
        return [
          `Connected to ${api.base}. Account time zone: ${pref?.timeZone ?? 'unknown'}.`,
          `Times are read and shown in ${s.tz}.`,
          `Tool sets: ${TOOLSETS.filter((t) => s.toolsets.has(t)).join(', ') || 'none'}.`,
          await rt.reminderStatus(host),
        ].join('\n');
      },
    },
  ];

  const tasks: DidaTool[] = [
    {
      name: 'dida_task_undone',
      description: `The open tasks dated within a period of at most ${UNDONE_MAX_DAYS} days, across all projects or some: the tool for "what is on today / this week". Overdue tasks from before the period are not included.`,
      inputSchema: object({ from: when('Start of the period.'), to: when('End of the period; a plain day includes that whole day.'), project_ids: ids('Only these projects ("inbox" for the inbox).'), task_ids: ids('Only these tasks.'), limit: LIMIT }, ['from', 'to']),
      flags: READ,
      handler: async (i: { from: string; to: string; project_ids?: string[]; task_ids?: string[]; limit?: number }, ctx, host) => {
        const { tz } = rt.settings(host);
        const r = range(i.from, i.to, tz) as { from: number; to: number };
        if (r.to - r.from > UNDONE_MAX_DAYS * DAY_MS) return fail(`the period may span at most ${UNDONE_MAX_DAYS} days; ask for several periods`);
        const found = await api.post<Task[]>('/task/undone', { startDate: toApiTime(r.from), endDate: toApiTime(r.to), ...(i.project_ids ? { projectIds: i.project_ids } : {}), ...(i.task_ids ? { taskIds: i.task_ids } : {}) }, { signal: ctx.signal });
        const sorted = [...(found ?? [])].sort((a, b) => (fromApiTime(a.startDate ?? a.dueDate) ?? 0) - (fromApiTime(b.startDate ?? b.dueDate) ?? 0));
        return taskList(`Open tasks from ${minuteOf(r.from, tz)} to ${minuteOf(r.to, tz)}`, sorted, host, ctx, i.limit, 'No open tasks in that period.');
      },
    },
    {
      name: 'dida_task_filter',
      description: 'List tasks by their properties: project, start date, priority, tags, kind and status (at most 200 from Dida365). All filters are optional; the date filter looks at when a task starts.',
      inputSchema: object({
        project_ids: ids('Only these projects.'),
        start_from: when('Tasks that start at or after this.'),
        start_to: when('Tasks that start at or before this.'),
        priority: { type: 'array', minItems: 1, items: { enum: Object.keys(PRIORITIES) } },
        tags: ids('Tasks carrying all of these tags.'),
        kind: { type: 'array', minItems: 1, items: { enum: ['TEXT', 'NOTE', 'CHECKLIST'] } },
        status: { type: 'array', minItems: 1, items: { enum: Object.keys(TASK_STATUS) }, description: 'Default: Dida365 decides (open tasks).' },
        limit: LIMIT,
      }),
      flags: READ,
      handler: async (i: { project_ids?: string[]; start_from?: string; start_to?: string; priority?: PriorityName[]; tags?: string[]; kind?: string[]; status?: TaskStatusName[]; limit?: number }, ctx, host) => {
        const r = range(i.start_from, i.start_to, rt.settings(host).tz);
        const status = statusCodes(i.status);
        const body = {
          ...(i.project_ids ? { projectIds: i.project_ids } : {}),
          ...(r.from !== undefined ? { startDate: toApiTime(r.from) } : {}),
          ...(r.to !== undefined ? { endDate: toApiTime(r.to) } : {}),
          ...(i.priority ? { priority: i.priority.map((p) => PRIORITIES[p]) } : {}),
          ...(i.tags ? { tag: i.tags } : {}),
          ...(i.kind ? { kind: i.kind } : {}),
          ...(status ? { status } : {}),
        };
        return taskList('Matching tasks', await api.post<Task[]>('/task/filter', body, { signal: ctx.signal }), host, ctx, i.limit, 'No task matches.');
      },
    },
    {
      name: 'dida_task_search',
      description: 'Find tasks by words in them, optionally narrowed by project, tags, status and due date.',
      inputSchema: object({
        keywords: { type: 'string', minLength: 1, maxLength: 200, description: 'Text to look for.' },
        project_ids: ids('Only these projects.'),
        tags: ids('Only tasks with these tags.'),
        status: { type: 'array', minItems: 1, items: { enum: Object.keys(TASK_STATUS) } },
        due_from: when('Tasks due at or after this.'),
        due_to: when('Tasks due at or before this.'),
        limit: LIMIT,
      }),
      flags: READ,
      handler: async (i: { keywords?: string; project_ids?: string[]; tags?: string[]; status?: TaskStatusName[]; due_from?: string; due_to?: string; limit?: number }, ctx, host) => {
        if (i.keywords !== undefined && !i.keywords.trim()) return fail('keywords must not be blank');
        const r = range(i.due_from, i.due_to, rt.settings(host).tz);
        const status = statusCodes(i.status);
        const body = {
          ...(i.keywords !== undefined ? { keywords: i.keywords.trim() } : {}),
          ...(i.project_ids ? { projectIds: i.project_ids } : {}),
          ...(i.tags ? { tags: i.tags } : {}),
          ...(status ? { status } : {}),
          ...(r.from !== undefined ? { dueFrom: toApiTime(r.from) } : {}),
          ...(r.to !== undefined ? { dueTo: toApiTime(r.to) } : {}),
        };
        if (Object.keys(body).length === 0) return fail('give keywords or at least one filter');
        return taskList('Found tasks', await api.post<Task[]>('/task/search', body, { signal: ctx.signal }), host, ctx, i.limit, 'Nothing found.');
      },
    },
    {
      name: 'dida_task_completed',
      description: 'List tasks that were completed, by project and by when they were completed (at most 200 from Dida365).',
      inputSchema: object({ project_ids: ids('Only these projects.'), from: when('Completed at or after this.'), to: when('Completed at or before this; a plain day includes that whole day.'), limit: LIMIT }),
      flags: READ,
      handler: async (i: { project_ids?: string[]; from?: string; to?: string; limit?: number }, ctx, host) => {
        const r = range(i.from, i.to, rt.settings(host).tz);
        const body = { ...(i.project_ids ? { projectIds: i.project_ids } : {}), ...(r.from !== undefined ? { startDate: toApiTime(r.from) } : {}), ...(r.to !== undefined ? { endDate: toApiTime(r.to) } : {}) };
        return taskList('Completed tasks', await api.post<Task[]>('/task/completed', body, { signal: ctx.signal }), host, ctx, i.limit, 'No completed tasks there.');
      },
    },
    {
      name: 'dida_task_get',
      description: 'Read one task in full: notes, dates, reminders, recurrence, checklist items, focus time and, when asked, its comments.',
      inputSchema: object({ project_id: PROJECT, task_id: TASK, comments: { type: 'boolean', description: 'Also read the comments (default false).' } }, ['project_id', 'task_id']),
      flags: READ,
      handler: async (i: { project_id: string; task_id: string; comments?: boolean }, ctx, host) => {
        const at = apiPath('project', i.project_id, 'task', i.task_id);
        const task = await api.get<Task>(at, { signal: ctx.signal });
        if (!task?.id) return fail(`Dida365 returned no task for task_id ${i.task_id}`);
        const comments = i.comments ? ((await api.get<Comment[]>(`${at}/comments`, { signal: ctx.signal })) ?? []) : undefined;
        return taskDetail(task, await context(host, ctx.signal), comments);
      },
    },
    {
      name: 'dida_task_create',
      description: 'Add one task. Without project_id it goes to the default project (the inbox unless configured otherwise). Returns the new task with its task_id.',
      inputSchema: object({ project_id: id('project_id of the list to add it to.'), ...TASK_PROPERTIES }, ['title']),
      flags: WRITE,
      handler: async (i: TaskInput & { project_id?: string }, ctx, host) => {
        const s = rt.settings(host);
        const projectId = i.project_id ?? s.defaultProjectId;
        const created = await api.post<Task>('/task', { ...taskBody(i, s.tz), ...(projectId ? { projectId } : {}) }, { signal: ctx.signal });
        if (!created?.id) return 'Created the task; Dida365 returned no details.';
        return `Created:\n${taskDetail(created, await context(host, ctx.signal))}`;
      },
    },
    {
      name: 'dida_task_update',
      description: 'Change fields of one task; fields left out keep their value. Completing, moving between projects, assigning and deleting have their own tools.',
      inputSchema: object({ project_id: PROJECT, task_id: TASK, ...TASK_PROPERTIES }, ['project_id', 'task_id']),
      flags: WRITE,
      handler: async (i: TaskInput & { project_id: string; task_id: string }, ctx, host) => {
        const { project_id, task_id, ...fields } = i;
        if (Object.keys(fields).length === 0) return fail('nothing to change: name at least one field');
        const existing = await api.get<Task>(apiPath('project', project_id, 'task', task_id), { signal: ctx.signal });
        if (!existing?.id) return fail(`Dida365 returned no task for task_id ${task_id}`);
        const body = mergedTask(existing, taskBody(fields, rt.settings(host).tz, existing));
        const updated = await api.post<Task>(apiPath('task', task_id), body, { signal: ctx.signal });
        if (!updated?.id) return `Updated task ${task_id}.`;
        return `Updated:\n${taskDetail(updated, await context(host, ctx.signal))}`;
      },
    },
    {
      name: 'dida_task_complete',
      description: 'Mark one or more tasks of the same project as done. A repeating task moves on to its next occurrence.',
      inputSchema: object({ project_id: id('project_id the tasks are in; leave out for the inbox.'), task_ids: ids('task_ids to complete.') }, ['task_ids']),
      flags: WRITE,
      handler: async (i: { project_id?: string; task_ids: string[] }, ctx) => {
        const wanted = [...new Set(i.task_ids)];
        const only = wanted[0];
        if (wanted.length === 1 && only !== undefined && i.project_id) {
          await api.post(`${apiPath('project', i.project_id, 'task', only)}/complete`, undefined, { signal: ctx.signal });
          return `Completed task ${only}.`;
        }
        const done = new Set<string>();
        for (const part of chunks(wanted, MAX_BATCH)) {
          for (const x of (await api.post<string[]>('/task/completeTasks', { ...(i.project_id ? { projectId: i.project_id } : {}), taskIds: part }, { signal: ctx.signal })) ?? []) done.add(x);
        }
        const missed = wanted.filter((x) => !done.has(x));
        const text = `Completed ${done.size} of ${wanted.length} tasks${done.size ? `: ${[...done].join(', ')}` : ''}.${missed.length ? ` Not completed (wrong project, already done, or no such task): ${missed.join(', ')}.` : ''}`;
        return done.size === 0 ? fail(text) : text;
      },
    },
    {
      name: 'dida_task_move',
      description: 'Move tasks to another project.',
      inputSchema: object(
        {
          moves: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH,
            items: object({ task_id: TASK, from_project_id: id('project_id it is in now.'), to_project_id: id('project_id it goes to.') }, ['task_id', 'from_project_id', 'to_project_id']),
          },
        },
        ['moves'],
      ),
      flags: WRITE,
      handler: async (i: { moves: Array<{ task_id: string; from_project_id: string; to_project_id: string }> }, ctx) => {
        const moved = (await api.post<Array<{ id?: string }>>('/task/move', i.moves.map((m) => ({ taskId: m.task_id, fromProjectId: m.from_project_id, toProjectId: m.to_project_id })), { signal: ctx.signal })) ?? [];
        const ok = new Set(moved.map((m) => m.id));
        const missed = i.moves.filter((m) => !ok.has(m.task_id)).map((m) => m.task_id);
        const text = `Moved ${ok.size} of ${i.moves.length} tasks.${missed.length ? ` Not moved: ${missed.join(', ')}.` : ''}`;
        return ok.size === 0 ? fail(text) : text;
      },
    },
    {
      name: 'dida_task_batch',
      description: `Create and change many tasks in one request (up to ${MAX_BATCH} of each). Use it instead of repeated single calls. Changed tasks keep the fields left out.`,
      inputSchema: object({
        add: { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: object({ project_id: id('project_id; default project when left out.'), ...TASK_PROPERTIES }, ['title']) },
        update: { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: object({ project_id: PROJECT, task_id: TASK, ...TASK_PROPERTIES }, ['project_id', 'task_id']) },
      }),
      flags: WRITE,
      handler: async (i: { add?: Array<TaskInput & { project_id?: string }>; update?: Array<TaskInput & { project_id: string; task_id: string }> }, ctx, host) => {
        const s = rt.settings(host);
        if (!i.add?.length && !i.update?.length) return fail('nothing to do: give add or update');
        const add = (i.add ?? []).map(({ project_id, ...fields }) => {
          const projectId = project_id ?? s.defaultProjectId;
          return { ...taskBody(fields, s.tz), ...(projectId ? { projectId } : {}) };
        });
        // Every changed task is read first, so that the fields the input leaves out are sent back unchanged.
        const update = await mapLimit(i.update ?? [], READ_AHEAD, async ({ project_id, task_id, ...fields }) => {
          const existing = await api.get<Task>(apiPath('project', project_id, 'task', task_id), { signal: ctx.signal });
          if (!existing?.id) throw new Error(`Dida365 returned no task for task_id ${task_id}; nothing was changed`);
          return mergedTask(existing, taskBody(fields, s.tz, existing));
        });
        const res = (await api.post<BatchResult>('/task/batch', { ...(add.length ? { add } : {}), ...(update.length ? { update } : {}) }, { signal: ctx.signal })) ?? {};
        const errors = Object.entries(res.id2error ?? {});
        const changed = new Set(update.map((u) => String(u['id'])));
        const okIds = Object.keys(res.id2etag ?? {});
        const created = okIds.filter((x) => !changed.has(x));
        const updated = okIds.filter((x) => changed.has(x));
        const lines = [`Batch sent: ${add.length} to add, ${update.length} to change.`];
        if (created.length) lines.push(`Created task_ids: ${created.join(', ')}`);
        if (updated.length) lines.push(`Changed task_ids: ${updated.join(', ')}`);
        if (errors.length) lines.push(`Refused: ${errors.map(([k, v]) => `${k} (${v})`).join(', ')}`);
        return errors.length > 0 && okIds.length === 0 ? fail(lines.join('\n')) : lines.join('\n');
      },
    },
    {
      name: 'dida_task_assign',
      description: 'Assign a task in a shared project to one of its members, or remove the assignee. dida_project_get with members lists the usernames.',
      inputSchema: object({ project_id: PROJECT, task_id: TASK, assignee: { type: ['string', 'null'], description: 'Username of a project member; null removes the assignee.' } }, ['project_id', 'task_id', 'assignee']),
      flags: WRITE,
      handler: async (i: { project_id: string; task_id: string; assignee: string | null }, ctx, host) => {
        const ref = { projectId: i.project_id, taskId: i.task_id };
        const task = i.assignee === null ? await api.post<Task>('/task/unassign', ref, { signal: ctx.signal }) : await api.post<Task>('/task/assign', { ...ref, assigneeUsername: i.assignee }, { signal: ctx.signal });
        const head = i.assignee === null ? `Removed the assignee of task ${i.task_id}.` : `Assigned task ${i.task_id} to ${i.assignee}.`;
        return task?.id ? `${head}\n${taskEntry(task, await context(host, ctx.signal))}` : head;
      },
    },
    {
      name: 'dida_comment_add',
      description: 'Add a comment to a task. In a shared project the other members see it.',
      inputSchema: object({ project_id: PROJECT, task_id: TASK, text: { type: 'string', minLength: 1, maxLength: 10_000 } }, ['project_id', 'task_id', 'text']),
      flags: WRITE,
      handler: async (i: { project_id: string; task_id: string; text: string }, ctx, host) => {
        const c = await api.post<Comment>(`${apiPath('project', i.project_id, 'task', i.task_id)}/comment`, { title: i.text }, { signal: ctx.signal });
        return c?.id ? `Comment added:\n${commentEntry(c, await context(host, ctx.signal))}` : 'Comment added.';
      },
    },
  ];

  const projects: DidaTool[] = [
    {
      name: 'dida_project_list',
      description: 'List the projects (lists) with their ids, and the project groups (folders) they sit in. The inbox is not in the list; its project_id is "inbox".',
      inputSchema: object({ offset: { type: 'integer', minimum: 0, description: 'Skip this many projects (for accounts with more than 200).' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
      flags: READ,
      handler: async (i: { offset?: number; limit?: number }, ctx) => {
        const paged = i.offset !== undefined || i.limit !== undefined;
        const [list, g] = await Promise.all([api.get<Project[]>('/project', { signal: ctx.signal, ...(paged ? { query: { offset: i.offset, limit: i.limit } } : {}) }), groupNames(ctx.signal)]);
        const names = new Map(g.groups.map((x) => [x.id, x.name ?? '']));
        const all = list ?? [];
        return [
          all.length ? `Projects (${all.length}):` : 'No projects besides the inbox.',
          ...all.map((p) => projectEntry(p, names)),
          ...(g.error ? [`Project groups could not be read: ${g.error}`] : g.groups.length ? [`Project groups (${g.groups.length}):`, ...g.groups.map(groupEntry)] : []),
          'The inbox is project_id "inbox".',
        ].join('\n');
      },
    },
    {
      name: 'dida_project_get',
      description: 'Read one project: its settings, its kanban columns and its open tasks; optionally the members of a shared project.',
      inputSchema: object(
        { project_id: id('project_id, or "inbox".'), tasks: { type: 'boolean', description: 'List the open tasks (default true).' }, members: { type: 'boolean', description: 'List the members (default false).' }, limit: LIMIT },
        ['project_id'],
      ),
      flags: READ,
      handler: async (i: { project_id: string; tasks?: boolean; members?: boolean; limit?: number }, ctx, host) => {
        const at = apiPath('project', i.project_id);
        const c = await context(host, ctx.signal);
        let data: ProjectData;
        if (i.tasks === false) {
          const [project, columns] = await Promise.all([api.get<Project>(at, { signal: ctx.signal }), api.get<Column[]>(`${at}/column`, { signal: ctx.signal })]);
          data = { ...(project ? { project } : {}), columns: columns ?? [] };
        } else data = (await api.get<ProjectData>(`${at}/data`, { signal: ctx.signal })) ?? {};
        const lines = [data.project ? projectEntry(data.project, new Map()) : `- project_id ${i.project_id}`];
        if (data.columns?.length) lines.push(`Columns (${data.columns.length}):`, ...data.columns.map(columnEntry));
        if (i.tasks !== false) lines.push(listing(`Open tasks; times in ${c.tz}`, data.tasks ?? [], (t) => taskEntry(t, c), c.limit(i.limit), 'No open tasks.'));
        if (i.members) {
          const members = (await api.get<Member[]>(`${at}/members`, { signal: ctx.signal })) ?? [];
          lines.push(members.length ? `Members (${members.length}):` : 'No members.', ...members.map(memberEntry));
        }
        return lines.join('\n');
      },
    },
    {
      name: 'dida_project_save',
      description: 'Create a project (no project_id, name required) or change one (with project_id; fields left out stay).',
      inputSchema: object({
        project_id: id('project_id of the project to change; leave out to create one.'),
        name: { type: 'string', minLength: 1, maxLength: 200 },
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'Like "#F18181".' },
        view_mode: { enum: ['list', 'kanban', 'timeline'] },
        kind: { enum: ['TASK', 'NOTE'], description: 'TASK: a to-do list; NOTE: a list of notes.' },
        sort_order: { type: 'integer' },
      }),
      flags: WRITE,
      handler: async (i: { project_id?: string; name?: string; color?: string; view_mode?: string; kind?: string; sort_order?: number }, ctx) => {
        const body = { ...(i.name !== undefined ? { name: i.name } : {}), ...(i.color !== undefined ? { color: i.color } : {}), ...(i.view_mode !== undefined ? { viewMode: i.view_mode } : {}), ...(i.kind !== undefined ? { kind: i.kind } : {}), ...(i.sort_order !== undefined ? { sortOrder: i.sort_order } : {}) };
        if (i.project_id === undefined && !i.name) return fail('a new project needs a name');
        if (Object.keys(body).length === 0) return fail('nothing to change: name at least one field');
        const saved = await api.post<Project>(i.project_id === undefined ? '/project' : apiPath('project', i.project_id), body, { signal: ctx.signal });
        rt.forgetProjects();
        const verb = i.project_id === undefined ? 'Created' : 'Changed';
        return saved?.id ? `${verb} the project:\n${projectEntry(saved, new Map())}` : `${verb} the project.`;
      },
    },
    {
      name: 'dida_group_save',
      description: 'Create a project group (a folder of projects), or rename one when group_id is given.',
      inputSchema: object({ group_id: id('group_id of the group to rename; leave out to create one.'), name: { type: 'string', minLength: 1, maxLength: 64 } }, ['name']),
      flags: WRITE,
      handler: async (i: { group_id?: string; name: string }, ctx) => {
        const saved = await api.post<ProjectGroup>(i.group_id === undefined ? '/project/group' : apiPath('project', 'group', i.group_id), { name: i.name }, { signal: ctx.signal });
        const verb = i.group_id === undefined ? 'Created' : 'Renamed';
        return saved?.id ? `${verb} the project group:\n${groupEntry(saved)}` : `${verb} the project group.`;
      },
    },
    {
      name: 'dida_column_save',
      description: 'Add a column to a kanban project, or rename one when column_id is given. dida_project_get lists the columns.',
      inputSchema: object({ project_id: id('project_id of the kanban project.'), column_id: id('column_id of the column to rename; leave out to add one.'), name: { type: 'string', minLength: 1, maxLength: 1000 } }, ['project_id', 'name']),
      flags: WRITE,
      handler: async (i: { project_id: string; column_id?: string; name: string }, ctx) => {
        const at = `${apiPath('project', i.project_id)}/column`;
        const saved = await api.post<Column>(i.column_id === undefined ? at : `${at}${apiPath(i.column_id)}`, { name: i.name }, { signal: ctx.signal });
        const verb = i.column_id === undefined ? 'Added' : 'Renamed';
        return saved?.id ? `${verb} the column:\n${columnEntry(saved)}` : `${verb} the column.`;
      },
    },
  ];

  const tags: DidaTool[] = [
    {
      name: 'dida_tag_list',
      description: 'List the tags of the account.',
      inputSchema: object({}),
      flags: READ,
      handler: async (_i: Record<string, never>, ctx) => listing('Tags', (await api.get<Tag[]>('/tag', { signal: ctx.signal })) ?? [], tagEntry, 200, 'No tags.'),
    },
    {
      name: 'dida_tag_create',
      description: 'Create a tag. A task gets tags through the tags field of dida_task_create and dida_task_update.',
      inputSchema: object({ name: { type: 'string', minLength: 1, maxLength: 64, description: 'The tag as it should be shown.' } }, ['name']),
      flags: WRITE,
      handler: async (i: { name: string }, ctx) => {
        const label = i.name.trim();
        if (!label) return fail('the tag name is blank');
        const saved = await api.post<Tag>('/tag', { name: label.toLowerCase(), label }, { signal: ctx.signal });
        return `Created the tag ${saved?.label ?? label}.`;
      },
    },
  ];

  const focus: DidaTool[] = [
    {
      name: 'dida_focus_list',
      description: 'Read focus records (pomodoros or stopwatch timings): those in a period of at most 30 days, or one by focus_id.',
      inputSchema: object({ type: { enum: Object.keys(FOCUS_TYPES) }, from: when('Start of the period.'), to: when('End of the period; a plain day includes that whole day.'), focus_id: id('Read this one record instead of a period.'), limit: LIMIT }, ['type']),
      flags: READ,
      handler: async (i: { type: FocusTypeName; from?: string; to?: string; focus_id?: string; limit?: number }, ctx, host) => {
        const c = await context(host, ctx.signal);
        const type = FOCUS_TYPES[i.type];
        if (i.focus_id !== undefined) {
          const one = await api.get<Focus>(apiPath('focus', i.focus_id), { query: { type }, signal: ctx.signal });
          return one?.id ? focusEntry(one, c) : fail(`Dida365 returned no focus record for focus_id ${i.focus_id}`);
        }
        if (i.from === undefined || i.to === undefined) return fail('give from and to, or a focus_id');
        const r = range(i.from, i.to, c.tz) as { from: number; to: number };
        const found = (await api.get<Focus[]>('/focus', { query: { from: toApiTime(r.from), to: toApiTime(r.to), type }, signal: ctx.signal })) ?? [];
        const total = found.reduce((sum, f) => sum + (f.duration ?? 0), 0);
        return listing(`Focus records (${i.type}), ${Math.round(total / 60)} min in total; times in ${c.tz}`, found, (f) => focusEntry(f, c), c.limit(i.limit), 'No focus records in that period.');
      },
    },
    {
      name: 'dida_focus_create',
      description: 'Record a finished focus session, optionally on a task.',
      inputSchema: object(
        {
          type: { enum: Object.keys(FOCUS_TYPES) },
          start: when('When it began.'),
          end: when('When it ended.'),
          duration_sec: { type: 'integer', minimum: 1, description: 'Focused seconds; default: end minus start minus pause_sec.' },
          pause_sec: { type: 'integer', minimum: 0, description: 'Seconds paused.' },
          task_id: id('task_id the focus was on.'),
          note: { type: 'string', maxLength: 5000 },
          relation_type: { type: 'array', items: { type: 'integer' }, description: 'Relation type codes, as Dida365 returns them.' },
        },
        ['type', 'start', 'end'],
      ),
      flags: WRITE,
      handler: async (i: { type: FocusTypeName; start: string; end: string; duration_sec?: number; pause_sec?: number; task_id?: string; note?: string; relation_type?: number[] }, ctx, host) => {
        const c = await context(host, ctx.signal);
        const start = parseWhen(i.start, c.tz).ms;
        const end = parseWhen(i.end, c.tz).ms;
        if (end <= start) return fail('end must be after start');
        const duration = i.duration_sec ?? Math.round((end - start) / 1000) - (i.pause_sec ?? 0);
        if (duration <= 0) return fail('the pause is as long as the session');
        const body = {
          type: FOCUS_TYPES[i.type],
          startTime: toApiTime(start),
          endTime: toApiTime(end),
          duration,
          ...(i.pause_sec !== undefined ? { pauseDuration: i.pause_sec } : {}),
          ...(i.task_id !== undefined ? { taskId: i.task_id } : {}),
          ...(i.note !== undefined ? { note: i.note } : {}),
          ...(i.relation_type !== undefined ? { relationType: i.relation_type } : {}),
        };
        const saved = await api.post<Focus>('/focus', body, { signal: ctx.signal });
        return saved?.id ? `Recorded:\n${focusEntry(saved, c)}` : 'Recorded the focus session.';
      },
    },
  ];

  const HABIT_PROPERTIES = {
    name: { type: 'string', minLength: 1, maxLength: 1000 },
    type: { type: 'string', description: '"Boolean": done or not; "Real": an amount counted towards goal.' },
    goal: { type: 'number', description: 'Amount that completes a day.' },
    step: { type: 'number', description: 'Amount one check-in adds.' },
    unit: { type: 'string', description: 'Unit of the amount, e.g. "Count", "km".' },
    repeat: { type: 'string', description: 'Recurrence rule, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR".' },
    reminders: { type: 'array', items: { type: 'string' }, description: 'Reminder times, in the form dida_habit_list shows.' },
    encouragement: { type: 'string' },
    icon: { type: 'string', description: 'Icon resource name, e.g. "habit_reading".' },
    color: { type: 'string' },
    section_id: id('section_id (dida_habit_list with sections shows them).'),
    record_enabled: { type: 'boolean', description: 'Ask for a note at each check-in.' },
    target_days: { type: 'integer', minimum: 0 },
    target_start: { type: 'string', description: 'Day the target counts from, e.g. 2026-01-01.' },
    completed_cycles: { type: 'integer', minimum: 0 },
    ex_dates: { type: 'array', items: { type: 'string' }, description: 'Excluded dates, as Dida365 returns them.' },
    status: { type: 'integer', description: 'Status code as Dida365 returns it (0 for an active habit).' },
    style: { type: 'integer' },
    sort_order: { type: 'integer' },
  } as const;
  interface HabitInput {
    habit_id?: string;
    name?: string;
    type?: string;
    goal?: number;
    step?: number;
    unit?: string;
    repeat?: string;
    reminders?: string[];
    encouragement?: string;
    icon?: string;
    color?: string;
    section_id?: string;
    record_enabled?: boolean;
    target_days?: number;
    target_start?: string;
    completed_cycles?: number;
    ex_dates?: string[];
    status?: number;
    style?: number;
    sort_order?: number;
  }
  const HABIT_FIELDS: ReadonlyArray<[keyof HabitInput, string]> = [
    ['name', 'name'],
    ['type', 'type'],
    ['goal', 'goal'],
    ['step', 'step'],
    ['unit', 'unit'],
    ['repeat', 'repeatRule'],
    ['reminders', 'reminders'],
    ['encouragement', 'encouragement'],
    ['icon', 'iconRes'],
    ['color', 'color'],
    ['section_id', 'sectionId'],
    ['record_enabled', 'recordEnable'],
    ['target_days', 'targetDays'],
    ['completed_cycles', 'completedCycles'],
    ['ex_dates', 'exDates'],
    ['status', 'status'],
    ['style', 'style'],
    ['sort_order', 'sortOrder'],
  ];

  const habits: DidaTool[] = [
    {
      name: 'dida_habit_list',
      description: 'List the habits (or read one by habit_id), optionally with the habit sections and with the check-ins of a period.',
      inputSchema: object({
        habit_id: id('Read only this habit.'),
        sections: { type: 'boolean', description: 'Also list the habit sections (default false).' },
        checkins_from: { type: 'string', description: 'First day of check-ins to include, e.g. 2026-04-01.' },
        checkins_to: { type: 'string', description: 'Last day of check-ins to include; default today.' },
      }),
      flags: READ,
      handler: async (i: { habit_id?: string; sections?: boolean; checkins_from?: string; checkins_to?: string }, ctx, host) => {
        const { tz } = rt.settings(host);
        const one = i.habit_id !== undefined ? await api.get<Habit>(apiPath('habit', i.habit_id), { signal: ctx.signal }) : undefined;
        if (i.habit_id !== undefined && !one?.id) return fail(`Dida365 returned no habit for habit_id ${i.habit_id}`);
        const list = one ? [one] : ((await api.get<Habit[]>('/habit', { signal: ctx.signal })) ?? []);
        // Asked for, the sections must be readable; otherwise they only put a name on a habit's section_id.
        const sections =
          i.sections || list.some((h) => h.sectionId)
            ? ((await api.get<HabitSection[]>('/habit/sections', { signal: ctx.signal }).catch((err: Error) => {
                if (i.sections) throw err;
                return undefined;
              })) ?? [])
            : [];
        const sectionNames = new Map(sections.map((x) => [x.id, x.name ?? x.id]));
        const lines = [listing('Habits', list, (h) => habitEntry(h, sectionNames), 200, 'No habits.')];
        if (i.sections) lines.push(listing('Habit sections', sections, sectionEntry, 200, 'No habit sections.'));
        if (i.checkins_from !== undefined && list.length > 0) {
          const from = toStamp(i.checkins_from);
          const to = toStamp(i.checkins_to ?? dayOf(rt.now(), tz));
          if (to < from) return fail('checkins_to is before checkins_from');
          const found = (await api.get<HabitCheckin[]>('/habit/checkins', { query: { habitIds: list.map((h) => h.id).join(','), from, to }, signal: ctx.signal })) ?? [];
          const names = new Map(list.map((h) => [h.id, h.name ?? h.id]));
          lines.push(listing(`Check-ins ${i.checkins_from} to ${i.checkins_to ?? 'today'}, as done/goal`, found, (x) => checkinEntry(x, names), 200, 'No check-ins in that period.'));
        }
        return lines.join('\n');
      },
    },
    {
      name: 'dida_habit_save',
      description: 'Create a habit (no habit_id, name required) or change one (with habit_id; fields left out stay).',
      inputSchema: object({ habit_id: id('habit_id of the habit to change; leave out to create one.'), ...HABIT_PROPERTIES }),
      flags: WRITE,
      handler: async (i: HabitInput, ctx) => {
        const body: Record<string, unknown> = {};
        for (const [from, to] of HABIT_FIELDS) if (i[from] !== undefined) body[to] = i[from];
        if (i.target_start !== undefined) body['targetStartDate'] = toStamp(i.target_start);
        if (i.habit_id === undefined && !i.name) return fail('a new habit needs a name');
        if (Object.keys(body).length === 0) return fail('nothing to change: name at least one field');
        const saved = await api.post<Habit>(i.habit_id === undefined ? '/habit' : apiPath('habit', i.habit_id), body, { signal: ctx.signal });
        const verb = i.habit_id === undefined ? 'Created' : 'Changed';
        return saved?.id ? `${verb} the habit:\n${habitEntry(saved, new Map())}` : `${verb} the habit.`;
      },
    },
    {
      name: 'dida_habit_checkin',
      description: 'Check in a habit for a day, or correct that day\'s check-in. For a counted habit, value is the amount reached that day.',
      inputSchema: object(
        {
          habit_id: id('habit_id.'),
          date: { type: 'string', description: 'The day, e.g. 2026-04-07; default today.' },
          value: { type: 'number', description: 'Amount done that day (default 1).' },
          goal: { type: 'number', description: 'Goal of that day (default 1).' },
          time: when('When it was done.'),
          status: { type: 'integer', description: 'Status code as Dida365 stores it; leave it out for a normal check-in.' },
        },
        ['habit_id'],
      ),
      flags: WRITE,
      handler: async (i: { habit_id: string; date?: string; value?: number; goal?: number; time?: string; status?: number }, ctx, host) => {
        const { tz } = rt.settings(host);
        const now = rt.now();
        const stamp = toStamp(i.date ?? dayOf(now, tz));
        const body = {
          stamp,
          opTime: toApiTime(now),
          ...(i.time !== undefined ? { time: toApiTime(parseWhen(i.time, tz).ms) } : {}),
          ...(i.value !== undefined ? { value: i.value } : {}),
          ...(i.goal !== undefined ? { goal: i.goal } : {}),
          ...(i.status !== undefined ? { status: i.status } : {}),
        };
        const saved = await api.post<HabitCheckin>(`${apiPath('habit', i.habit_id)}/checkin`, body, { signal: ctx.signal });
        const day = saved?.checkins?.filter((x) => x.stamp === stamp);
        return saved && day?.length ? `Checked in:\n${checkinEntry({ ...saved, checkins: day }, new Map())}` : `Checked in habit ${i.habit_id} for ${i.date ?? dayOf(now, tz)}.`;
      },
    },
  ];

  const countdowns: DidaTool[] = [
    {
      name: 'dida_countdown_list',
      description: 'List the countdowns and anniversaries (birthdays, deadlines, days since or until a date).',
      inputSchema: object({}),
      flags: READ,
      handler: async (_i: Record<string, never>, ctx) => listing('Countdowns', (await api.get<Countdown[]>('/countdown', { signal: ctx.signal })) ?? [], countdownEntry, 200, 'No countdowns.'),
    },
  ];

  /** What can be deleted depends on which tool sets are on. */
  const deletable = [...(enabled.has('tasks') ? ['task', 'comment'] : []), ...(enabled.has('projects') ? ['project', 'project_group'] : []), ...(enabled.has('focus') ? ['focus'] : [])];
  const remove: DidaTool = {
    name: 'dida_delete',
    description: `Delete something from Dida365 for good: ${deletable.map((x) => DELETABLE[x]).join(', ')}. A task needs project_id and task_id; a comment also comment_id; a project project_id (its tasks go with it); a project group group_id (its projects stay); a focus record focus_id and focus_type. To finish a task use dida_task_complete instead.`,
    inputSchema: object(
      {
        type: { enum: deletable },
        project_id: id('project_id.'),
        task_id: TASK,
        comment_id: id('comment_id.'),
        group_id: id('group_id.'),
        focus_id: id('focus_id.'),
        focus_type: { enum: Object.keys(FOCUS_TYPES) },
      },
      ['type'],
    ),
    flags: WRITE,
    handler: async (i: { type: string; project_id?: string; task_id?: string; comment_id?: string; group_id?: string; focus_id?: string; focus_type?: FocusTypeName }, ctx) => {
      if (!deletable.includes(i.type)) return fail(`cannot delete a ${i.type} here; type is one of ${deletable.join(', ')}`);
      const need = (...names: Array<'project_id' | 'task_id' | 'comment_id' | 'group_id' | 'focus_id' | 'focus_type'>): string | undefined => names.find((n) => !i[n]);
      const missing = (name: string) => fail(`deleting a ${DELETABLE[i.type]} needs ${name}`);
      const signal = ctx.signal;
      switch (i.type) {
        case 'task': {
          const m = need('project_id', 'task_id');
          if (m) return missing(m);
          await api.delete(apiPath('project', i.project_id as string, 'task', i.task_id as string), { signal });
          return `Deleted task ${i.task_id}.`;
        }
        case 'comment': {
          const m = need('project_id', 'task_id', 'comment_id');
          if (m) return missing(m);
          await api.delete(apiPath('project', i.project_id as string, 'task', i.task_id as string, 'comment', i.comment_id as string), { signal });
          return `Deleted comment ${i.comment_id}.`;
        }
        case 'project': {
          const m = need('project_id');
          if (m) return missing(m);
          await api.delete(apiPath('project', i.project_id as string), { signal });
          rt.forgetProjects();
          return `Deleted project ${i.project_id}.`;
        }
        case 'project_group': {
          const m = need('group_id');
          if (m) return missing(m);
          await api.delete(apiPath('project', 'group', i.group_id as string), { signal });
          return `Deleted project group ${i.group_id}.`;
        }
        default: {
          const m = need('focus_id', 'focus_type');
          if (m) return missing(m);
          await api.delete(apiPath('focus', i.focus_id as string), { query: { type: FOCUS_TYPES[i.focus_type as FocusTypeName] }, signal });
          return `Deleted focus record ${i.focus_id}.`;
        }
      }
    },
  };

  const entries: ToolEntry[] = [
    ...core.map((tool): ToolEntry => ({ set: 'core', tool })),
    ...tasks.map((tool): ToolEntry => ({ set: 'tasks', tool })),
    ...projects.map((tool): ToolEntry => ({ set: 'projects', tool })),
    ...tags.map((tool): ToolEntry => ({ set: 'tags', tool })),
    ...focus.map((tool): ToolEntry => ({ set: 'focus', tool })),
    ...habits.map((tool): ToolEntry => ({ set: 'habits', tool })),
    ...countdowns.map((tool): ToolEntry => ({ set: 'countdowns', tool })),
  ];
  const offered = entries.filter((e) => e.set === 'core' || enabled.has(e.set));
  const all = deletable.length > 0 ? [...offered, { set: 'core' as const, tool: remove }] : offered;
  return all.map((e): ToolEntry => {
    const approval = APPROVALS[e.tool.name];
    return approval ? { ...e, tool: { ...e.tool, approval } } : e;
  });
}
