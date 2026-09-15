import { beijing, addDays } from './dates.mjs';

export const JIRA_BASE = 'https://jira.aonorx.com';
export class JiraError extends Error {}

export function upcomingJql(date) {
  return `assignee = currentUser() AND statusCategory != Done AND duedate >= "${date}" AND duedate < "${addDays(date, 3)}" ORDER BY duedate ASC, key ASC`;
}

export class JiraClient {
  constructor(store, fetcher = fetch) {
    this.store = store;
    this.fetcher = fetcher;
    this.credentials = null;
    this.identity = '';
    this.lastCheckAt = null;
    this.issues = [];
    this.notice = '';
    this.busy = false;
  }

  async initialize() {
    this.credentials = await this.store.read();
    this.identity = this.credentials?.displayName || '';
  }

  status() {
    return { configured: Boolean(this.credentials), identity: this.identity, lastCheckAt: this.lastCheckAt,
      issues: this.issues, notice: this.notice, busy: this.busy, field: '到期日（duedate）', scope: '所有分配给我的未完成任务' };
  }

  async request(endpoint, credentials = this.credentials) {
    if (!credentials) throw new JiraError('请先在本机页面连接 Jira。');
    let response;
    try {
      response = await this.fetcher(`${JIRA_BASE}/rest/api/2/${endpoint}`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'), Accept: 'application/json' },
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { throw new JiraError('暂时无法连接 Jira，请检查网络后重试。'); }
    if (response.status === 401 || response.status === 403) throw new JiraError('Jira 登录未通过。请确认用户名和密码；如有验证码，先在 Jira 官网完成验证。');
    if (!response.ok) throw new JiraError('Jira 查询失败，请稍后重试。');
    if (!response.headers.get('content-type')?.includes('application/json')) throw new JiraError('Jira 返回了登录页面，请检查登录方式。');
    try { return await response.json(); }
    catch { throw new JiraError('Jira 响应无法识别。'); }
  }

  async configure(body) {
    if (this.busy) throw new JiraError('正在连接 Jira，请稍后。');
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || username.length > 200 || /[:\r\n]/.test(username) || !password || password.length > 1024) throw new JiraError('请填写 Jira 用户名和密码。');
    this.busy = true;
    try {
      const credentials = { username, password };
      const myself = await this.request('myself', credentials);
      if (!myself.name || myself.active === false) throw new JiraError('无法确认当前 Jira 账号。');
      const fields = await this.request('field', credentials);
      if (!Array.isArray(fields) || !fields.some(field => field.id === 'duedate')) throw new JiraError('Jira 未提供标准到期日字段，需要核对看板字段。');
      credentials.displayName = String(myself.displayName || myself.name);
      await this.store.write(credentials);
      this.credentials = credentials;
      this.identity = credentials.displayName;
      this.notice = '';
    } finally { this.busy = false; }
  }

  async upcoming(date = beijing().date) {
    try {
      const issues = [];
      let startAt = 0;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ jql: upcomingJql(date), fields: 'summary,duedate,status', startAt: String(startAt), maxResults: '100' });
        const data = await this.request(`search?${query}`);
        if (!Array.isArray(data.issues) || !Number.isFinite(data.total)) throw new JiraError('Jira 查询结果不完整，未将本次检查记为成功。');
        for (const issue of data.issues) {
          const due = issue.fields?.duedate;
          if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue.key || '') || typeof issue.fields?.summary !== 'string') throw new JiraError('Jira 任务数据不完整。');
          if (due !== date && due !== addDays(date, 1) && due !== addDays(date, 2)) continue;
          if (issue.fields?.status?.statusCategory?.key === 'done') continue;
          issues.push({ key: issue.key, title: issue.fields.summary, due, url: `${JIRA_BASE}/browse/${issue.key}` });
        }
        startAt += data.issues.length;
        if (startAt >= data.total) {
          this.issues = [...new Map(issues.map(issue => [issue.key, issue])).values()];
          this.lastCheckAt = new Date().toISOString();
          this.notice = '';
          return this.issues;
        }
        if (!data.issues.length) break;
      }
      throw new JiraError('任务较多或查询中断，本次检查未完成。');
    } catch (error) {
      this.notice = error instanceof JiraError ? error.message : 'Jira 检查未完成，请重试。';
      throw new JiraError(this.notice);
    }
  }
}
