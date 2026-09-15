import { beijing, dayRecord, addDays } from './dates.mjs';

function escapeMarkdown(value) { return String(value).replace(/[\[\]()*_`<>\\]/g, ' ').replace(/[\r\n]/g, ' '); }
export function weeklyPrompt(state, date) {
  const days = Object.entries(state.days).filter(([key]) => key >= addDays(date, -5) && key <= date);
  const notes = days.map(([key, day]) => day.summary ? `${key.slice(5)}：${day.summary}` : (day.notes?.length ? `${key.slice(5)}：${day.notes.map(note => note.text).join('；').slice(0, 70)}` : '')).filter(Boolean);
  return `本周工作核对：${notes.length ? '\n' + notes.join('\n') : '这周主要完成了什么？'}\n下周准备做什么？有遗漏请补充，回复“周计划 …”继续核对。`;
}

export function pendingItems(state, now, channel) {
  const { date, hour, weekday } = beijing(now);
  if (!state.enabled || hour < 15) return [];
  const day = state.days[date] || {};
  const sent = day.sent || {};
  const pending = id => !sent[`${id}.${channel}`];
  const items = [];
  if (!day.completed) {
    if (hour >= 22 && pending('report22')) items.push({ ids: ['report15', 'report22'], text: '今日 Jira 工时填报完成了吗？未填的话，告诉我今天做了什么；填好后回复“已填报”。' });
    else if (hour < 22 && pending('report15')) items.push({ ids: ['report15'], text: '今天做了什么？我帮你整理 50 字以内的填报内容。已填好请回复“已填报”。' });
  }
  if (day.jira?.issues?.length && pending('jira')) {
    const lines = day.jira.issues.map(issue => `${issue.due.slice(5)} [${issue.key}](${issue.url}) ${escapeMarkdown(issue.title)}`);
    items.push({ ids: ['jira'], text: '明天／后天到期：\n' + lines.join('\n') });
  }
  if (weekday === 6 && pending('weekly')) items.push({ ids: ['weekly'], text: weeklyPrompt(state, date) });
  return items;
}

export class Scheduler {
  constructor({ store, jira, wecom, notify, online, now = () => new Date() }) {
    Object.assign(this, { store, jira, wecom, notify, online, now });
    this.running = false;
    this.lastError = '';
    this.lastTickAt = null;
    this.network = 'unknown';
    this.retryJiraAt = 0;
    this.retrySendAt = 0;
  }

  async tick() {
    if (this.running) return;
    const now = this.now(); const { date, hour } = beijing(now);
    if (!this.store.snapshot().enabled || hour < 15) return;
    const state = this.store.snapshot();
    if (state.days[date]?.jira && !pendingItems(state, now, 'local').length && !pendingItems(state, now, 'wecom').length) return;
    this.running = true;
    try {
      this.lastTickAt = now.toISOString();
      const online = this.wecom.status().connection === 'connected' || await this.online();
      this.network = online ? 'online' : 'offline';
      if (!online) {
        if (!this.store.snapshot().days[date]?.sent?.['offline.local']) {
          const items = pendingItems(this.store.snapshot(), now, 'local');
          await this.notify('Jira 工作提醒', '当前未联网，请连接网络。联网后会自动补检查。\n' + items.map(item => item.text).join('\n').slice(0, 150));
          await this.mark(date, ['offline', ...items.flatMap(item => item.ids)], 'local');
        }
        // 22 点的本机日报提醒不能因为离线而丢失。
        await this.deliver(date, 'local');
        return;
      }

      if (!this.store.snapshot().days[date]?.jira && now.getTime() >= this.retryJiraAt) {
        this.retryJiraAt = now.getTime() + 5 * 60000;
        try {
          const issues = await this.jira.upcoming(date);
          await this.store.update(state => { dayRecord(state, date).jira = { checkedAt: now.toISOString(), issues }; });
          this.lastError = '';
        } catch {
          this.lastError = this.jira.status().notice || 'Jira 检查未完成，请在本机页面查看连接。';
          if (!this.store.snapshot().days[date]?.sent?.['jira-error.local']) {
            await this.notify('Jira 检查需要处理', this.lastError);
            await this.mark(date, ['jira-error'], 'local');
          }
        }
      }
      await this.deliver(date, 'local');
      if (this.wecom.status().connection === 'connected' && now.getTime() >= this.retrySendAt) {
        this.retrySendAt = now.getTime() + 60000;
        await this.deliver(date, 'wecom');
      }
    } catch { this.lastError = '提醒尚未全部送达，将自动重试；可在本机页面查看。'; }
    finally { this.running = false; }
  }

  async mark(date, ids, channel) {
    await this.store.update(state => {
      const day = dayRecord(state, date);
      for (const id of ids) day.sent[`${id}.${channel}`] = this.now().toISOString();
    });
  }

  async deliver(date, channel) {
    // 查询网络可能跨过午夜或 22 点，每次实际发送前重新取时间和完成状态。
    const now = this.now();
    if (beijing(now).date !== date) return;
    const items = pendingItems(this.store.snapshot(), now, channel);
    if (!items.length) return;
    const text = items.map(item => item.text).join('\n\n');
    if (channel === 'wecom') await this.wecom.push(text);
    else {
      const localText = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      await this.notify('Jira 工作提醒', localText.slice(0, 195) + '\n点击查看任务链接和今日记录。');
    }
    await this.mark(date, items.flatMap(item => item.ids), channel);
  }
}
