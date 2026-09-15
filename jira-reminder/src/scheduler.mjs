import { beijing, dayRecord, weekStart, addDays } from './dates.mjs';
import { activitiesInRange } from './history.mjs';

function escapeMarkdown(value) { return String(value).replace(/[\[\]()*_`<>\\]/g, ' ').replace(/[\r\n]/g, ' '); }
export function weeklyPrompt(state, date) {
  const imported = activitiesInRange(state,weekStart(date),date);
  const dates = [...new Set([...Object.keys(state.days), ...imported.map(item=>item.date)])].filter(key=>key>=weekStart(date)&&key<=date).sort();
  const notes = dates.map(key=>{
    const day = state.days[key];
    const text = day?.summary || [...(day?.notes||[]).filter(note=>note.kind!=='chat').map(note=>note.text), ...imported.filter(item=>item.date===key).map(item=>item.text||item.title)].join('；').slice(0,100);
    return text ? `${key.slice(5)}：${text}` : '';
  }).filter(Boolean);
  return `本周工作核对：${notes.length ? '\n' + notes.join('\n') : '这周主要完成了什么？'}\n下周准备做什么？有遗漏请补充，回复“周计划 …”继续核对。`;
}

export function pendingItems(state, now, channel) {
  const { date, hour, weekday } = beijing(now);
  if (!state.enabled) return [];
  const day = state.days[date] || {};
  const sent = day.sent || {};
  const pending = id => !sent[`${id}.${channel}`];
  const items = [];
  if (!day.completed) {
    const reminder = day.reminder;
    const customId = reminder && `report-custom:${reminder.id}`;
    const waiting = reminder && Date.parse(reminder.at) > now.getTime();
    if (reminder && !waiting && pending(customId)) {
      items.push({ ids: [customId, 'report15', ...(hour >= 22 ? ['report22'] : [])], text: '到约定的填报时间了，今天做了什么？已填好请回复“已填报”。' });
    } else if (!waiting && hour >= 22 && pending('report22')) items.push({ ids: ['report22', 'report15'], text: '今日 Jira 工时填报完成了吗？未填的话，告诉我今天做了什么；填好后回复“已填报”。' });
    else if (!waiting && hour >= 15 && hour < 22 && pending('report15')) items.push({ ids: ['report15'], text: '今天做了什么？我帮你整理 50 字以内的填报内容。已填好请回复“已填报”。' });
  }
  if (hour >= 15 && day.jira?.issues?.length && pending('jira')) {
    const labels = { [date]: '今天到期', [addDays(date, 1)]: '明日到期', [addDays(date, 2)]: '后天到期' };
    const lines = [...day.jira.issues].sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key))
      .map((issue, index) => `${index + 1}、[${escapeMarkdown(issue.title)}（${issue.key}）](${issue.url}) ${labels[issue.due] || '到期'} 到期时间${issue.due.replaceAll('-', '.')}`);
    items.push({ ids: ['jira'], text: '临期任务：\n' + lines.join('\n') });
  }
  if (hour >= 15 && weekday === 6 && pending('weekly')) items.push({ ids: ['weekly'], text: weeklyPrompt(state, date) });
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
    if (this.running || this.maintenance?.()) return;
    const now = this.now(); const { date, hour } = beijing(now);
    if (!this.store.snapshot().enabled) return;
    const state = this.store.snapshot();
    const needsJira = hour >= 15 && state.days[date]?.jira?.scope !== 'today+2';
    if (!needsJira && !pendingItems(state, now, 'local').length && !pendingItems(state, now, 'wecom').length) return;
    this.running = true;
    try {
      this.lastTickAt = now.toISOString();
      const online = this.wecom.status().connection === 'connected' || await this.online();
      this.network = online ? 'online' : 'offline';
      if (!online) {
        if (!this.store.snapshot().days[date]?.sent?.['offline.local']) {
          await this.notify('Jira 工作提醒', '当前未联网，请连接网络。联网后会自动补检查。');
          await this.mark(date, ['offline'], 'local');
        }
        // 22 点的本机日报提醒不能因为离线而丢失。
        await this.deliver(date, 'local');
        return;
      }

      if (needsJira && now.getTime() >= this.retryJiraAt) {
        this.retryJiraAt = now.getTime() + 5 * 60000;
        try {
          const issues = await this.jira.upcoming(date);
          await this.store.update(state => { dayRecord(state, date).jira = { checkedAt: now.toISOString(), issues, scope: 'today+2' }; });
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
    for (const item of items) {
      if (beijing(this.now()).date !== date) return;
      // 每条独立确认；发送期间改期或确认完成后，不继续发送已失效的提醒。
      const current = pendingItems(this.store.snapshot(), this.now(), channel).find(next => next.ids[0] === item.ids[0]);
      if (!current) continue;
      if (channel === 'wecom') await this.wecom.push(current.text);
      else {
        const localText = current.text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        await this.notify('Jira 工作提醒', localText.slice(0, 195) + '\n点击查看任务链接和今日记录。');
      }
      await this.mark(date, current.ids, channel);
    }
  }
}
