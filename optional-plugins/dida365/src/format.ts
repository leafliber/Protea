import type { ChecklistItem, Column, Comment, Countdown, Focus, Habit, HabitCheckin, HabitSection, Member, Project, ProjectGroup, Tag, Task } from './api.js';
import { dayOf, fromApiTime, fromStamp, isTimeZone, minuteOf } from './time.js';

/** What rendering needs besides the object itself. */
export interface FormatContext {
  /** Zone in which times are shown. */
  tz: string;
  projectName(id: string): string | undefined;
}

export const PRIORITIES = { none: 0, low: 1, medium: 3, high: 5 } as const;
export type PriorityName = keyof typeof PRIORITIES;
const PRIORITY_NAME: Record<number, string> = { 0: 'none', 1: 'low', 3: 'medium', 5: 'high' };

export const TASK_STATUS = { open: 0, completed: 2, abandoned: -1 } as const;
export type TaskStatusName = keyof typeof TASK_STATUS;

export const FOCUS_TYPES = { pomodoro: 0, timing: 1 } as const;
export type FocusTypeName = keyof typeof FOCUS_TYPES;

export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function box(status: number | undefined): string {
  return status === 2 || status === 1 ? '[x]' : status === -1 ? '[-]' : '[ ]';
}

/** The zone an all-day date belongs to: the task's own, since its midnight is what the API stores. */
export function dateZone(t: { isAllDay?: boolean; timeZone?: string }, tz: string): string {
  return t.isAllDay && t.timeZone && isTimeZone(t.timeZone) ? t.timeZone : tz;
}

/** `2026-11-13 15:00`, `2026-11-13 (all day)`, or a range. */
export function taskWhen(t: Task, tz: string): string | undefined {
  const start = fromApiTime(t.startDate);
  const due = fromApiTime(t.dueDate);
  const first = start ?? due;
  if (first === undefined) return undefined;
  const zone = dateZone(t, tz);
  const show = (ms: number): string => (t.isAllDay ? dayOf(ms, zone) : minuteOf(ms, zone));
  const a = show(first);
  const b = due !== undefined ? show(due) : a;
  return `${a === b ? a : `${a} → ${b}`}${t.isAllDay ? ' (all day)' : ''}`;
}

function projectLabel(id: string, ctx: FormatContext): string {
  const name = ctx.projectName(id);
  return name ? `${id} (${clip(name, 60)})` : id;
}

function minutes(seconds: number | undefined): string {
  return `${Math.round((seconds ?? 0) / 60)} min`;
}

/** A task in a listing: what it is, then the ids the other tools need. */
export function taskEntry(t: Task, ctx: FormatContext): string {
  const facts: string[] = [];
  const when = taskWhen(t, ctx.tz);
  if (when) facts.push(when);
  if (t.priority) facts.push(`${PRIORITY_NAME[t.priority] ?? t.priority} priority`);
  if (t.tags?.length) facts.push(t.tags.map((x) => `#${x}`).join(' '));
  if (t.repeatFlag) facts.push('repeats');
  if (t.items?.length) facts.push(`${t.items.filter((i) => i.status === 1).length}/${t.items.length} items done`);
  if (t.kind === 'NOTE') facts.push('note');
  if (t.parentId) facts.push('subtask');
  if (t.assigneeUsername) facts.push(`assigned to ${t.assigneeUsername}`);
  const done = fromApiTime(t.completedTime);
  if (t.status === 2 && done !== undefined) facts.push(`completed ${minuteOf(done, ctx.tz)}`);
  const lines = [`- ${box(t.status)} ${clip(t.title || '(untitled)', 200)}${facts.length ? ` — ${facts.join(' · ')}` : ''}`, `  task_id ${t.id} · project_id ${projectLabel(t.projectId, ctx)}`];
  const note = clip(t.content || t.desc || '', 160);
  if (note) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

function itemEntry(i: ChecklistItem, t: Task, ctx: FormatContext): string {
  const start = fromApiTime(i.startDate);
  const zone = i.timeZone ?? t.timeZone;
  const when = start === undefined ? '' : ` — ${i.isAllDay ? dayOf(start, zone && isTimeZone(zone) ? zone : ctx.tz) : minuteOf(start, ctx.tz)}`;
  return `  - ${box(i.status)} ${clip(i.title || '(untitled)', 200)}${when}${i.id ? ` (item id ${i.id})` : ''}`;
}

export function commentEntry(c: Comment, ctx: FormatContext): string {
  const at = fromApiTime(c.createdTime);
  return `  - ${at !== undefined ? `${minuteOf(at, ctx.tz)} ` : ''}(comment_id ${c.id})${c.replyCommentId ? ` in reply to ${c.replyCommentId}` : ''}: ${clip(c.title ?? '', 1000)}`;
}

/** Everything about one task. */
export function taskDetail(t: Task, ctx: FormatContext, comments?: Comment[]): string {
  const lines = [`${box(t.status)} ${t.title || '(untitled)'}`, `task_id: ${t.id}`, `project_id: ${projectLabel(t.projectId, ctx)}`];
  const add = (label: string, value: string | undefined | false): void => {
    if (value) lines.push(`${label}: ${value}`);
  };
  add('status', t.status === 2 ? 'completed' : t.status === -1 ? 'abandoned' : 'open');
  add('when', taskWhen(t, ctx.tz));
  add('time zone', t.timeZone);
  const done = fromApiTime(t.completedTime);
  add('completed', t.status === 2 && done !== undefined && minuteOf(done, ctx.tz));
  add('priority', PRIORITY_NAME[t.priority ?? 0] ?? String(t.priority));
  add('tags', t.tags?.join(', '));
  add('repeat', t.repeatFlag ? `${t.repeatFlag}${t.repeatFrom ? ` (repeat_from ${{ '0': 'due_date', '1': 'completed_date', '2': 'default' }[t.repeatFrom] ?? t.repeatFrom})` : ''}` : undefined);
  add('reminders', t.reminders?.join(', '));
  add('kind', t.kind);
  add('parent task_id', t.parentId);
  add('assignee', t.assigneeUsername);
  const focus = t.focusSummaries?.[0];
  if (focus) add('focus', `${focus.pomoCount ?? 0} pomodoros, ${minutes((focus.pomoDuration ?? 0) + (focus.stopwatchDuration ?? 0))} focused`);
  if (t.content) lines.push('content:', clip4k(t.content));
  if (t.desc) lines.push('description:', clip4k(t.desc));
  if (t.items?.length) lines.push('items:', ...t.items.map((i) => itemEntry(i, t, ctx)));
  if (comments) lines.push(comments.length ? 'comments:' : 'comments: none', ...comments.map((c) => commentEntry(c, ctx)));
  return lines.join('\n');
}

/** Long text keeps its line breaks but not its length. */
function clip4k(s: string): string {
  return s.length > 4000 ? `${s.slice(0, 4000)}\n… (${s.length - 4000} more characters)` : s;
}

export function projectEntry(p: Project, groups: Map<string, string>): string {
  const facts = [p.kind === 'NOTE' ? 'notes' : undefined, p.viewMode && p.viewMode !== 'list' ? `${p.viewMode} view` : undefined, p.closed ? 'archived' : undefined, p.permission && p.permission !== 'write' ? `${p.permission} only` : undefined].filter(Boolean);
  const groupName = p.groupId ? groups.get(p.groupId) : undefined;
  const group = p.groupId ? (groupName ? `group ${clip(groupName, 60)} (group_id ${p.groupId})` : `group_id ${p.groupId}`) : undefined;
  return `- ${clip(p.name || '(unnamed)', 120)} — project_id ${p.id}${[...facts, group].filter(Boolean).map((x) => ` · ${x}`).join('')}`;
}

export const groupEntry = (g: ProjectGroup): string => `- ${clip(g.name || '(unnamed)', 120)} — group_id ${g.id}`;
export const columnEntry = (c: Column): string => `- ${clip(c.name || '(unnamed)', 120)} — column_id ${c.id}`;
export const memberEntry = (m: Member): string => `- ${m.displayName || m.username || '(unknown)'}${m.username ? ` — username ${m.username}` : ''}${m.self ? ' (the owner)' : ''}`;
export const tagEntry = (t: Tag): string => `- ${t.label || t.name}${t.parent ? ` (under ${t.parent})` : ''}${t.type === 2 ? ' · team tag' : ''}`;

export function focusEntry(f: Focus, ctx: FormatContext): string {
  const start = fromApiTime(f.startTime);
  const end = fromApiTime(f.endTime);
  const span = start !== undefined ? `${minuteOf(start, ctx.tz)}${end !== undefined ? ` → ${minuteOf(end, ctx.tz).slice(11)}` : ''}` : 'no time';
  const about = f.tasks?.map((x) => x.title || x.timerName).filter(Boolean).join(', ');
  const facts = [f.duration !== undefined ? minutes(f.duration) : undefined, f.pauseDuration ? `paused ${minutes(f.pauseDuration)}` : undefined, about ? `on ${clip(about, 120)}` : f.taskId ? `task_id ${f.taskId}` : undefined, f.note ? `note: ${clip(f.note, 200)}` : undefined].filter(Boolean);
  return `- ${f.type === 1 ? 'timing' : 'pomodoro'} ${span}${facts.map((x) => ` · ${x}`).join('')} — focus_id ${f.id}`;
}

export function habitEntry(h: Habit, sections: Map<string, string>): string {
  const counted = h.type && h.type !== 'Boolean';
  const facts = [
    counted ? `goal ${h.goal ?? '?'} ${h.unit ?? ''}`.trim() : undefined,
    h.repeatRule,
    h.reminders?.length ? `reminders ${h.reminders.join(', ')}` : undefined,
    h.totalCheckIns !== undefined ? `${h.totalCheckIns} check-ins` : undefined,
    h.targetDays ? `target ${h.targetDays} days${fromStamp(h.targetStartDate) ? ` from ${fromStamp(h.targetStartDate)}` : ''}` : undefined,
    h.sectionId ? `section ${sections.get(h.sectionId) ?? h.sectionId}` : undefined,
    h.status ? `status ${h.status}${h.archivedTime ? ' (archived)' : ''}` : undefined,
    h.encouragement ? `"${clip(h.encouragement, 80)}"` : undefined,
  ].filter(Boolean);
  return `- ${clip(h.name || '(unnamed)', 120)} — habit_id ${h.id}${facts.map((x) => ` · ${x}`).join('')}`;
}

export const sectionEntry = (s: HabitSection): string => `- ${clip(s.name || '(unnamed)', 120)} — section_id ${s.id}`;

export function checkinEntry(c: HabitCheckin, habits: Map<string, string>): string {
  const days = (c.checkins ?? []).map((d) => `${fromStamp(d.stamp) ?? d.stamp}: ${d.value ?? 0}/${d.goal ?? 1}${d.status !== undefined ? ` (status ${d.status})` : ''}`);
  const name = c.habitId ? habits.get(c.habitId) : undefined;
  return `- ${name ? `${clip(name, 80)} (habit_id ${c.habitId})` : `habit_id ${c.habitId ?? '?'}`}: ${days.length ? days.join(', ') : 'no check-ins'}`;
}

export function countdownEntry(c: Countdown): string {
  const facts = [fromStamp(c.date) ?? 'no date', c.ignoreYear ? 'every year' : undefined, c.repeatFlag || undefined, c.remark ? clip(c.remark, 120) : undefined].filter(Boolean);
  return `- ${clip(c.name || '(unnamed)', 120)} — ${facts.join(' · ')} — countdown_id ${c.id}`;
}

/** A titled list, cut to `limit` entries with a note about the rest. */
export function listing<T>(title: string, all: readonly T[], render: (x: T) => string, limit: number, empty: string): string {
  if (all.length === 0) return empty;
  const shown = all.slice(0, limit);
  const rest = all.length - shown.length;
  return [`${title} (${rest > 0 ? `${shown.length} of ${all.length}` : all.length}):`, ...shown.map(render), ...(rest > 0 ? [`… ${rest} more not shown; narrow the query.`] : [])].join('\n');
}
