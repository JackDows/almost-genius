import { randomUUID } from 'node:crypto';
import { beijing, addDays } from './dates.mjs';

export class TaskError extends Error {}
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TASK_TOOLS = ['archive.search', 'archive.get', 'archive.propose', 'history.query', 'jira.search', 'web.search'];
const kinds = ['reminder', 'agent', 'report', 'jira', 'weekly'];
export function validDate(date) { return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date; }
function text(value, max, label) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TaskError(`${label}不能为空，最多 ${max} 字。`); return value.trim(); }
export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskError('任务格式无效。');
  const title = text(input.title, 120, '任务名称');
  const instructions = text(input.instructions, 6000, '任务说明');
  const action = input.action || 'agent';
  if (!kinds.includes(action)) throw new TaskError('不支持这个任务类型。');
  const s = input.schedule;
  if (!s || !['once', 'daily', 'weekly', 'interval'].includes(s.type)) throw new TaskError('请选择一次性、每天、每周或间隔执行。');
  const schedule = { type: s.type, timezone: 'Asia/Shanghai' };
  if (s.type === 'once') {
    if (typeof s.at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s.at) || !Number.isFinite(Date.parse(s.at))) throw new TaskError('一次性任务需要包含时区的完整时间。');
    schedule.at = new Date(s.at).toISOString();
  } else if (s.type === 'interval') {
    if (!Number.isInteger(s.minutes) || s.minutes < 5 || s.minutes > 10080 || !Number.isFinite(Date.parse(s.anchor))) throw new TaskError('间隔至少5分钟，最多7天，并需要起始时间。');
    schedule.minutes = s.minutes; schedule.anchor = new Date(s.anchor).toISOString();
  } else {
    if (!Array.isArray(s.times) || !s.times.length || s.times.length > 12 || s.times.some(t => typeof t !== 'string' || !clock.test(t))) throw new TaskError('执行时间格式为 HH:mm，每天最多12个时间。');
    schedule.times = [...new Set(s.times)].sort();
    if (s.type === 'weekly') {
      if (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new TaskError('星期使用0至6，0代表周日。');
      schedule.weekdays = [...new Set(s.weekdays)].sort();
    }
  }
  const channels = input.channels || ['wecom', 'local'];
  if (!Array.isArray(channels) || !channels.length || channels.some(c => !['wecom', 'local'].includes(c))) throw new TaskError('通知渠道只能是企业微信和本机。');
  const tools = input.tools || [];
  if (!Array.isArray(tools) || tools.some(tool => !TASK_TOOLS.includes(tool))) throw new TaskError('任务包含尚未接入的能力。');
  const missed = input.missed || 'today';
  if (!['today', 'skip'].includes(missed)) throw new TaskError('错过时间的处理方式无效。');
  const dueDays = input.dueDays ?? 2;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean' || input.reportIncomplete !== undefined && typeof input.reportIncomplete !== 'boolean') throw new TaskError('任务开关必须是布尔值。');
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 90) throw new TaskError('临期范围应为0至90天。');
  return { title, instructions, action, schedule, channels: [...new Set(channels)], tools: [...new Set(tools)], missed, dueDays,
    enabled: input.enabled !== false, reportIncomplete: input.reportIncomplete === true || action === 'report' };
}

export function defaultTasks(now) {
  const defaults = [
    { id: 'daily-report', title: '日报填报提醒', action: 'report', instructions: '询问今天做了什么，协助整理50字以内的填报内容；已填报则停止当天催报。', schedule: { type: 'daily', times: ['15:00', '22:00'] } },
    { id: 'jira-due', title: 'Jira 临期检查', action: 'jira', instructions: '检查所有分配给我的未完成任务，列出今天至后天到期的项目、完整日期与链接。', schedule: { type: 'daily', times: ['15:00'] } },
    { id: 'weekly-review', title: '本周工作与下周计划核对', action: 'weekly', instructions: '根据本周工作记录与我核对工作和下周计划，不直接出正稿。', schedule: { type: 'weekly', weekdays: [6], times: ['15:00'] } },
  ];
  return defaults.map(t => ({ ...validateTask(t), id: t.id, revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), deletedAt: null, pauseUntil: null }));
}

// 每次只补执行最近一次应运行的任务，不堆积关机期间的多轮提醒。
export function occurrence(task, now, state, future = false) {
  if (!task.enabled || task.deletedAt || (task.pauseUntil && Date.parse(task.pauseUntil) > now.getTime())) return null;
  const { date } = beijing(now); const s = task.schedule;
  if (s.type === 'once') {
    const at = new Date(s.at); const sameDay = beijing(at).date === date;
    if (future) return at > now ? { at: at.toISOString(), date: beijing(at).date } : null;
    return at <= now && sameDay && (task.missed !== 'skip' || now - at < 60000) ? { at: at.toISOString(), date } : null;
  }
  if (s.type === 'interval') {
    const anchor = Date.parse(s.anchor), step = s.minutes * 60000;
    const n = future ? Math.max(0, Math.floor((now.getTime() - anchor) / step) + 1) : Math.floor((now.getTime() - anchor) / step);
    if (n < 0) return null;
    const at = new Date(anchor + n * step);
    if (!future && (beijing(at).date !== date || task.missed === 'skip' && now - at >= 60000)) return null;
    return { at: at.toISOString(), date: beijing(at).date };
  }
  const options = [];
  for (let dayOffset = 0; dayOffset <= (future ? 8 : 0); dayOffset++) {
    const day = addDays(date, dayOffset); const weekday = new Date(`${day}T12:00:00+08:00`).getUTCDay();
    if (s.type === 'weekly' && !s.weekdays.includes(weekday)) continue;
    let times = s.times;
    const override = task.id === 'daily-report' && state.days?.[day]?.reminder;
    if (override) {
      const custom = new Date(Date.parse(override.at) + 8 * 3600000).toISOString().slice(11, 16);
      times = [custom, ...s.times.slice(1).filter(time => time > custom)];
    }
    for (const time of times) {
      const at = new Date(`${day}T${time}:00+08:00`);
      if (future ? at > now : at <= now && (task.missed !== 'skip' || now - at < 60000)) options.push({ at: at.toISOString(), date: day, customId: override && at.toISOString() === override.at ? override.id : null });
    }
  }
  return future ? options[0] || null : options.at(-1) || null;
}
export function runId(task, slot) { return `${task.id}:${slot.at}${slot.customId ? ':' + slot.customId : ''}`; }

export class TaskService {
  constructor(store, now = () => new Date()) { this.store = store; this.now = now; }
  async initialize() {
    if (this.store.snapshot().tasksSchema === 1) return;
    await this.store.update(state => {
      state.tasksSchema = 1; state.tasks = Object.fromEntries(defaultTasks(this.now()).map(t => [t.id, t]));
      state.taskRuns = {}; state.taskChanges = [];
      // 将已发送标记迁入当前日期的执行记录，升级当天不会重发。
      const { date } = beijing(this.now()), day = state.days[date];
      if (!day) return;
      for (const task of Object.values(state.tasks)) {
        const slots = task.schedule.times.map(time => ({ at: new Date(`${date}T${time}:00+08:00`).toISOString(), date }));
        if (task.action === 'report' && day.reminder) slots.push({ at: day.reminder.at, date, customId: day.reminder.id });
        for (const slot of slots) {
          const key = task.action === 'jira' ? 'jira' : task.action === 'weekly' ? 'weekly' : slot.customId ? `report-custom:${slot.customId}` : slot.at.includes('T14:') ? 'report22' : 'report15';
          const channels = Object.fromEntries(['local', 'wecom'].filter(c => day.sent?.[`${key}.${c}`]).map(c => [c, day.sent[`${key}.${c}`]]));
          if (Object.keys(channels).length) state.taskRuns[runId(task, slot)] = { id: runId(task, slot), taskId: task.id, revision: 1, ...slot, status: 'ready', channels, text: '', migrated: true };
        }
      }
    });
  }
  list(includeDeleted = false) {
    const state = this.store.snapshot();
    return Object.values(state.tasks || {}).filter(t => includeDeleted || !t.deletedAt).map(task => ({ ...task, next: occurrence(task, this.now(), state, true)?.at || null,
      lastRun: Object.values(state.taskRuns || {}).filter(r => r.taskId === task.id).sort((a, b) => b.at.localeCompare(a.at))[0] || null }));
  }
  get(id) { const task = this.list(true).find(t => t.id === id); if (!task) throw new TaskError('没有找到该任务，请先查询任务列表。'); return task; }
  preview(input) { const task = validateTask(input); const now = this.now(); return { ...task, next: occurrence(task, now, this.store.snapshot(), true)?.at || null }; }
  async create(input, origin = 'local') {
    const valid = validateTask(input); const now = this.now().toISOString();
    if (valid.schedule.type === 'once' && Date.parse(valid.schedule.at) <= this.now().getTime()) throw new TaskError('一次性任务时间已过，请指定未来时间。');
    const task = { ...valid, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, deletedAt: null, pauseUntil: null };
    await this.store.update(state => {
      if (Object.values(state.tasks).filter(t => !t.deletedAt).length >= 200) throw new TaskError('最多保留200个有效任务，请先归档不用的任务。');
      state.tasks[task.id] = task; this.log(state, task.id, null, task, origin);
    });
    return this.get(task.id);
  }
  log(state, id, before, after, origin) {
    state.taskChanges ||= []; state.taskChanges.push({ id: randomUUID(), taskId: id, at: this.now().toISOString(), origin, before, after });
    state.taskChanges = state.taskChanges.slice(-300);
  }
  async change(id, revision, operation, patch = {}, origin = 'local') {
    await this.store.update(state => {
      const old = state.tasks[id]; if (!old) throw new TaskError('任务不存在。');
      if (revision !== old.revision) throw new TaskError('任务刚刚已被修改，请重新读取后操作。');
      const before = structuredClone(old); let next = structuredClone(old);
      if (operation === 'update') {
        if (old.deletedAt) throw new TaskError('请先恢复已删除任务。');
        if (Object.keys(patch).some(k => !['title', 'instructions', 'action', 'schedule', 'channels', 'tools', 'missed', 'dueDays', 'enabled', 'reportIncomplete'].includes(k))) throw new TaskError('修改包含不支持的字段。');
        next = { ...next, ...validateTask({ ...next, ...patch }) };
      } else if (operation === 'delete') next.deletedAt = this.now().toISOString();
      else if (operation === 'restore') { next.deletedAt = null; next.enabled = false; }
      else if (operation === 'pause') {
        next.enabled = false; next.pauseUntil = null;
        if (patch.until) {
          if (!Number.isFinite(Date.parse(patch.until)) || Date.parse(patch.until) <= this.now()) throw new TaskError('恢复时间需要在未来。');
          next.enabled = true; next.pauseUntil = new Date(patch.until).toISOString();
        }
      } else if (operation === 'resume') { next.enabled = true; next.pauseUntil = null; }
      else throw new TaskError('任务操作无效。');
      next.revision++; next.updatedAt = this.now().toISOString(); state.tasks[id] = next;
      if (id === 'daily-report' && operation === 'update' && patch.schedule) delete state.days[beijing(this.now()).date]?.reminder;
      for (const run of Object.values(state.taskRuns || {})) if (run.taskId === id && !['done', 'skipped', 'cancelled'].includes(run.status)) run.status = 'cancelled';
      this.log(state, id, before, next, origin);
    });
    return this.get(id);
  }
  async undo() {
    let restored;
    await this.store.update(state => {
      const change = [...state.taskChanges].reverse().find(c => !c.undone && c.origin !== 'undo');
      if (!change) throw new TaskError('没有可以撤销的任务修改。');
      const current = state.tasks[change.taskId];
      if (current.revision !== change.after.revision) throw new TaskError('这条任务后来又被修改，不能覆盖后续修改。');
      restored = change.before ? { ...change.before, revision: current.revision + 1, updatedAt: this.now().toISOString() } : { ...current, deletedAt: this.now().toISOString(), revision: current.revision + 1 };
      state.tasks[current.id] = restored; change.undone = true;
      for (const run of Object.values(state.taskRuns || {})) if (run.taskId === current.id && !['done', 'skipped'].includes(run.status)) run.status = 'cancelled';
    });
    return this.get(restored.id);
  }
}
