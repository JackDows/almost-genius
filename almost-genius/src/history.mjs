import { beijing, addDays } from './dates.mjs';
import { JIRA_BASE, JiraError } from './jira.mjs';

export function historyRange(date = beijing().date) {
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 3, 1));
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, last));
  return { from: start.toISOString().slice(0,10), to: date };
}

// 外部活动独立保存，不写进手工对话或“已填报”标记。
// 以后增加其他来源时，保留 source、externalId、date、text、url 即可参与展示和整理。
export function activitiesInRange(state, from, to) {
  return Object.values(state.activities || {}).filter(item => item.date >= from && item.date <= to &&
    (!state.sources?.[item.source]?.accountId || state.sources[item.source].accountId === item.accountId))
    .sort((a,b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}

export async function readJiraHistory(jira, range, progress = () => {}) {
  const credentials = jira.credentials;
  const me = await jira.request('myself', credentials);
  if (!me.name || !me.key) throw new JiraError('无法确认 Jira 个人账号，未加载历史。');
  const accountId = me.key;
  // Jira 账号的时区可能是 UTC。检索两端放宽一天，再按实际 started 时间换算北京时间过滤。
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${addDays(range.from,-1)}" AND worklogDate < "${addDays(range.to,2)}" ORDER BY key ASC`;
  const issues = new Map(); let startAt = 0;
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new JiraError('历史任务过多，本次加载未完成，旧记录仍保留。');
    const result = await jira.request('search?' + new URLSearchParams({jql, fields:'summary', startAt:String(startAt), maxResults:'100'}), credentials);
    if (!Array.isArray(result.issues) || !Number.isInteger(result.total) || (result.startAt !== undefined && result.startAt !== startAt)) throw new JiraError('历史任务分页不完整，未替换本地记录。');
    for (const issue of result.issues) {
      if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue.key) || typeof issue.fields?.summary !== 'string') throw new JiraError('历史任务数据不完整。');
      issues.set(issue.key,issue);
    }
    startAt += result.issues.length;
    if (startAt >= result.total) break;
    if (!result.issues.length) throw new JiraError('历史任务分页提前结束，未替换本地记录。');
  }
  const records = new Map(); let completed = 0;
  for (const issue of issues.values()) {
    let offset = 0; const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new JiraError('工时分页未完成，旧记录仍保留。');
      const result = await jira.request(`issue/${encodeURIComponent(issue.key)}/worklog?startAt=${offset}&maxResults=100`, credentials);
      if (!Array.isArray(result.worklogs) || !Number.isInteger(result.total) || (result.startAt !== undefined && result.startAt !== offset)) throw new JiraError('工时分页不完整，未替换本地记录。');
      let added = 0;
      for (const worklog of result.worklogs) {
        if (typeof worklog.id !== 'string' || !/^\d+$/.test(worklog.id)) throw new JiraError('工时记录编号无效。');
        if (!seen.has(worklog.id)) { seen.add(worklog.id); added++; }
        if (worklog.author?.key !== me.key && worklog.author?.name !== me.name) continue;
        const started = new Date(worklog.started);
        if (!Number.isFinite(started.getTime())) throw new JiraError('个人工时日期无效。');
        const date = beijing(started).date;
        if (date < range.from || date > range.to) continue;
        if (worklog.comment != null && typeof worklog.comment !== 'string') throw new JiraError('工时正文格式不受支持。');
        if (!Number.isFinite(worklog.timeSpentSeconds) || worklog.timeSpentSeconds < 0) throw new JiraError('工时数量无效。');
        const id = `jira:${JIRA_BASE}:${accountId}:worklog:${worklog.id}`;
        records.set(id, { id, source:'jira', kind:'worklog', externalId:worklog.id, sourceUrl:JIRA_BASE, accountId,
          date, occurredAt:started.toISOString(), title:issue.fields.summary, text:worklog.comment || '',
          issueKey:issue.key, url:`${JIRA_BASE}/browse/${issue.key}`, timeSpentSeconds:worklog.timeSpentSeconds,
          updatedAt:worklog.updated || worklog.created || started.toISOString() });
      }
      offset += result.worklogs.length;
      if (offset >= result.total) break;
      if (!added) throw new JiraError('服务器未返回下一页工时，未替换本地记录。');
    }
    progress(++completed,issues.size);
  }
  if (jira.credentials !== credentials) throw new JiraError('查询期间 Jira 账号已变更，请重新加载。');
  return { accountId, records:[...records.values()], issueCount:issues.size };
}

export class HistoryService {
  constructor({store,jira,now=()=>new Date()}) { Object.assign(this,{store,jira,now}); this.busy=false; this.notice=''; this.progress=''; this.nextAttempt=0; }
  status() { return { ...this.store.snapshot().sources?.jira, busy:this.busy, notice:this.notice, progress:this.progress }; }
  list() { const state=this.store.snapshot(); return activitiesInRange(state,'0000-01-01','9999-12-31'); }
  start() { if (!this.busy && !this.maintenance?.()) void this.sync(); return '正在加载过去两个月的个人 Jira 工时记录，可继续使用应用。'; }
  auto() {
    if (!this.jira.credentials || this.busy || this.maintenance?.() || this.now().getTime()<this.nextAttempt) return;
    const last=this.status().syncedAt, current=beijing(this.now());
    if (!last || (beijing(new Date(last)).date !== current.date && current.hour>=15)) this.start();
  }
  async sync() {
    if (this.busy || this.maintenance?.()) return false;
    this.busy=true; this.notice=''; this.progress='正在查找本人填报过的任务'; this.nextAttempt=this.now().getTime()+600000;
    const range=historyRange(beijing(this.now()).date);
    try {
      const result=await readJiraHistory(this.jira,range,(done,total)=>{this.progress=`已读取 ${done} / ${total} 个任务`;});
      const syncedAt=this.now().toISOString();
      await this.store.update(state=>{
        state.activities ||= {}; state.sources ||= {};
        // 仅在全部查询成功后替换当前账号、当前区间的 Jira 缓存，保留手工记录及其他来源。
        for (const [id,item] of Object.entries(state.activities)) if (item.source==='jira' && item.sourceUrl===JIRA_BASE && item.accountId===result.accountId && item.date>=range.from && item.date<=range.to) delete state.activities[id];
        for (const item of result.records) state.activities[item.id]={...item,importedAt:syncedAt};
        state.sources.jira={accountId:result.accountId,...range,syncedAt,count:result.records.length,issueCount:result.issueCount};
      });
      this.progress=''; return true;
    } catch (error) { this.notice=error instanceof JiraError ? error.message : '历史加载未完成，已保存的记录仍可查看。'; return false; }
    finally { this.busy=false; }
  }
}
