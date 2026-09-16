import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { beijing, dayRecord } from './dates.mjs';
import { TaskError, validDate } from './tasks.mjs';
import { ArchiveError } from './archive.mjs';
import { WorkError } from './work.mjs';
import { JiraError } from './jira.mjs';

const str = { type: 'string' }, num = { type: 'integer' }, obj = { type: 'object' };
const definition = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const TOOL_DEFINITIONS = [
  definition('tasks_list', '查询全部任务与最近运行结果，修改前先读取。', { includeDeleted: { type: 'boolean' } }),
  definition('tasks_get', '读取指定任务及其 revision。', { id: str }, ['id']),
  definition('tasks_preview', '校验一个全新任务并预览执行时间。task 包含 title、instructions、action(reminder/agent/report/jira/weekly)、schedule、channels(local/wecom)、tools。schedule 为 daily/weekly 的 times:[HH:mm]、weekdays:[0..6，0周日]；once 的 at 必须带时区；interval 的 minutes 至少5与 anchor。timezone 固定北京时间。tools 仅 archive.search/archive.get/archive.propose/history.query/jira.search/web.search。missed=today 当天补跑，skip 则不补。', { task: obj }, ['task']),
  definition('tasks_create', '按用户明确要求创建全新任务，先 preview。agent 类型按 instructions 调用明确允许的 tools；reminder 直接发送说明。返回实际结果后才说明已创建。', { task: obj }, ['task']),
  definition('tasks_change', '修改、删除、恢复、暂停或恢复运行。operation:update/delete/restore/pause/resume，patch 提供更改字段或暂停恢复时间 until。使用最新 revision。删除可恢复，restore 默认暂停。', { id: str, revision: num, operation: str, patch: obj }, ['id', 'revision', 'operation']),
  definition('tasks_undo', '用户要求时撤销最后一次任务变更。'),
  definition('archive_search', '检索个人技能、经验、项目、偏好、收藏。结果包含待核对与已确认状态；候选不代表已掌握。', { query: str }, ['query']),
  definition('archive_get', '读取完整档案及证据。', { id: str }, ['id']),
  definition('archive_propose', '根据用户表达或真实来源提出档案候选。entry 包含 type(experience/skill/project/memory/bookmark)、title、content、tags、sourceIds。sourceIds 从 history_query 获取，不能编造。技能强度/成果不明时保留待核对。不会自动确认。', { entry: obj }, ['entry']),
  definition('archive_change', '仅用户明确要求时修改/确认/删除/恢复档案，operation:update/confirm/delete/restore，patch 为 title/content/type/tags；修改后重新待核对。', { id: str, revision: num, operation: str, patch: obj }, ['id', 'revision', 'operation']),
  definition('profile_get', '读取本人背景、目标、兴趣和沟通偏好。'),
  definition('profile_set', '仅按用户明确要求更新个人背景，保留未被修改的内容。', { content: str, revision: num }, ['content', 'revision']),
  definition('history_query', '查找已保存的原始工作记录，可用于成长提炼、日报或周报。返回真实来源编号。日期为 YYYY-MM-DD；最多50条，offset 翻页。', { from: str, to: str, query: str, offset: num }),
  definition('jira_search', '检查本人未完成且今天到指定天数内到期的 Jira 任务。', { dueDays: num }),
  definition('report_status', '读取今天完成标记、已有草稿、原始记录和自动计算的工时参考。hours 区分正常下班基础工时、按当前时间下班的估算和已保存的实际安排。'),
  definition('report_hours', '计算或保存 Jira 日报工时。date 为工作归属日期 YYYY-MM-DD，省略为今天；endTime 是24小时制下班时间。周一至五基础7小时，18:00后累加；周六基础5小时，16:00后累加，按实际分钟。周日必须 mode=interval，提供 startTime、endTime、breakMinutes（无休息填0）；提前下班或特殊安排也可明确选择 interval。跨午夜 nextDay=true，仍按工作日期规则。save=true 只在用户明确提供实际下班安排或要求保存时使用；假设、举例、查询一律 save=false。保存只是本机填报参考，不代表 Jira 已填报。', { date: str, mode: { type: 'string', enum: ['schedule', 'interval'] }, startTime: str, endTime: str, breakMinutes: num, nextDay: { type: 'boolean' }, save: { type: 'boolean' } }, ['endTime']),
  definition('report_complete', '仅在用户明确说已填报或撤销完成时修改完成标记。', { completed: { type: 'boolean' } }, ['completed']),
  definition('report_remind', '修改今天这一次日报提醒，time 为 HH:mm；null 取消改期。永久时间修改请用 tasks_change。', { time: { type: ['string', 'null'] } }, ['time']),
  definition('report_save', '把用户原始内容和核对后的日报/周报草稿分别保存。日报 summary 不超过50字。不会自动完成填报。', { kind: { type: 'string', enum: ['daily', 'weekly'] }, original: str, summary: str }, ['kind', 'original', 'summary']),
];
const scheduledNames = { 'archive.search': 'archive_search', 'archive.get': 'archive_get', 'archive.propose': 'archive_propose', 'history.query': 'history_query', 'jira.search': 'jira_search' };
export class ToolService {
  constructor(services) { Object.assign(this, services); }
  definitions(context) {
    const allowed = context.scheduled ? new Set((context.tools || []).map(t => scheduledNames[t]).filter(Boolean)) : new Set(TOOL_DEFINITIONS.map(t => t.name));
    return TOOL_DEFINITIONS.filter(t => allowed.has(t.name));
  }
  async call(name, a, context) {
    if (!this.definitions(context).some(t => t.name === name)) throw new TaskError('这轮任务没有该操作权限。');
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new TaskError('参数需要对象。');
    const definition = TOOL_DEFINITIONS.find(t => t.name === name);
    if (definition.inputSchema.required.some(k => a[k] === undefined) || Object.keys(a).some(k => !Object.hasOwn(definition.inputSchema.properties, k))) throw new TaskError('参数字段不完整或不支持。');
    if (this.maintenance?.()) throw new TaskError('正在切换数据，请稍后。');
    if (context.scheduled && !context.valid()) throw new TaskError('任务已修改、暂停或失效，停止执行。');
    switch (name) {
      case 'tasks_list': return { tasks: this.tasks.list(a.includeDeleted === true), globallyEnabled: this.store.snapshot().enabled };
      case 'tasks_get': return this.tasks.get(a.id);
      case 'tasks_preview': return this.tasks.preview(a.task);
      case 'tasks_create': return { task: await this.tasks.create(a.task, 'ai'), globallyEnabled: this.store.snapshot().enabled };
      case 'tasks_change': return this.tasks.change(a.id, a.revision, a.operation, a.patch, 'ai');
      case 'tasks_undo': return this.tasks.undo();
      case 'archive_search': return this.archive.search(a.query);
      case 'archive_get': return this.archive.get(a.id);
      case 'archive_propose': return this.archive.propose(a.entry, context.scheduled ? 'task:' + context.taskId : 'conversation');
      case 'archive_change': return this.archive.change(a.id, a.revision, a.operation, a.patch);
      case 'profile_get': return this.archive.profile();
      case 'profile_set': return this.archive.setProfile(a.content, a.revision);
      case 'history_query': {
        if (a.from && !validDate(a.from) || a.to && !validDate(a.to) || a.offset !== undefined && (!Number.isInteger(a.offset) || a.offset < 0)) throw new TaskError('日期或分页格式无效。');
        if (a.query !== undefined && typeof a.query !== 'string') throw new TaskError('查询必须是文字。');
        const all = this.archive.sources().filter(i => (!a.from || i.date >= a.from) && (!a.to || i.date <= a.to) && (!a.query || `${i.title} ${i.text}`.toLowerCase().includes(a.query.toLowerCase())));
        return { total: all.length, entries: all.slice(a.offset || 0, (a.offset || 0) + 50) };
      }
      case 'jira_search': return this.jira.upcoming(beijing().date, a.dueDays ?? 2);
      case 'report_status': { const w = this.work.status(); return { date: w.date, today: w.today, hours: w.hours, enabled: w.enabled }; }
      case 'report_hours': {
        if (a.save !== undefined && typeof a.save !== 'boolean') throw new WorkError('保存选项无效。');
        const { save, ...input } = a;
        return save === true ? this.work.saveHours(input) : this.work.previewHours(input);
      }
      case 'report_complete': if (typeof a.completed !== 'boolean') throw new WorkError('完成标记无效。'); return this.work.complete(a.completed);
      case 'report_remind': return this.work.setReminder(a.time);
      case 'report_save': {
        if (!['daily', 'weekly'].includes(a.kind) || typeof a.original !== 'string' || !a.original.trim() || a.original.length > 4000 || typeof a.summary !== 'string' || !a.summary.trim() || [...a.summary].length > (a.kind === 'daily' ? 50 : 1000)) throw new WorkError('日报最多50字，周报最多1000字，原始内容不能为空。');
        await this.store.update(s => { const day = dayRecord(s, beijing().date); day.notes.push({ text: a.original, kind: a.kind, at: new Date().toISOString() }); day[a.kind === 'daily' ? 'summary' : 'weekly'] = a.summary; });
        return { saved: true, summary: a.summary, completed: this.work.status().today.completed };
      }
    }
  }
}

// 每次 AI 运行有独立且可撤销的能力令牌，定时任务不获得任务管理权限。
export class ToolGateway {
  constructor(service) { this.service = service; this.grants = new Map(); }
  async start() {
    this.server = http.createServer(async (req, res) => {
      const grant = this.grants.get(req.headers.authorization?.replace(/^Bearer /, ''));
      const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method !== 'POST' || req.url !== '/tools' || req.headers.origin || req.headers.host !== `127.0.0.1:${this.server.address().port}` || !grant || Date.now() > grant.expires) return reply(403, {});
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) return reply(413, {}); }
        const { method, params } = JSON.parse(body);
        if (method === 'tools/list') return reply(200, { tools: this.service.definitions(grant.context) });
        if (method !== 'tools/call') return reply(400, {});
        const result = await this.service.call(params.name, params.arguments || {}, grant.context);
        return reply(200, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        const text = [TaskError, ArchiveError, WorkError, JiraError].some(Type => error instanceof Type) ? error.message : '操作未完成，请重新查询状态。';
        reply(200, { isError: true, content: [{ type: 'text', text }] });
      }
    });
    this.server.requestTimeout = 50000; this.server.headersTimeout = 5000;
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
  }
  grant(context) {
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { context, expires: Date.now() + 6 * 60000 });
    return { env: { ALMOST_GENIUS_TOOL_TOKEN: token, ALMOST_GENIUS_TOOL_URL: `http://127.0.0.1:${this.server.address().port}/tools` }, revoke: () => this.grants.delete(token) };
  }
  close() { this.grants.clear(); this.server?.close(); }
}
