import { randomUUID } from 'node:crypto';
import { beijing, dayRecord, addDays } from './dates.mjs';
import { weeklyPrompt } from './scheduler.mjs';

export class WorkError extends Error {}
export class WorkService {
  constructor({ store, writer, wecom, scheduler, notify, now = () => new Date() }) {
    Object.assign(this, { store, writer, wecom, scheduler, notify, now });
    this.processing = false;
    this.flushing = false;
    this.lastPushAttempt = 0;
  }

  status() {
    const state = this.store.snapshot(); const { date } = beijing(this.now());
    const today = state.days[date] || { completed: false, notes: [], summary: '', sent: {} };
    return { date, enabled: state.enabled, today, busy: this.processing, writerNotice: this.writer.notice,
      lastTickAt: this.scheduler.lastTickAt, network: this.scheduler.network, notice: this.scheduler.lastError };
  }

  async complete(completed = true) {
    const now = this.now(); const { date } = beijing(now);
    await this.store.update(state => { const day = dayRecord(state, date); day.completed = completed; day.completedAt = completed ? now.toISOString() : null; });
    return completed ? '已记录今日填报完成，今晚不再提醒填报。' : '已取消今日完成标记。';
  }

  async enable(enabled) {
    if (typeof enabled !== 'boolean') throw new WorkError('提醒开关无效。');
    if (enabled && (!this.wecom.status().paired || !this.scheduler.jira.status().configured)) throw new WorkError('请先连接 Jira 并绑定企业微信。');
    await this.store.update(state => { state.enabled = enabled; });
    if (enabled) void this.scheduler.tick();
    return enabled ? '每日提醒已启用。' : '每日提醒已暂停。';
  }

  async record(text, kind = 'daily', origin = 'local') {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !['daily', 'weekly'].includes(kind)) throw new WorkError('请填写 1～4000 字工作内容。');
    const now = this.now(); const { date } = beijing(now);
    await this.store.update(state => {
      const day = dayRecord(state, date);
      if (day.notes.length >= 200) throw new WorkError('今日记录较多，请在现有内容上核对。');
      day.notes.push({ text: text.trim(), kind, at: now.toISOString() });
      day.jobs ||= {};
      day.jobs[kind] = { id: randomUUID(), status: 'pending', origin };
    });
    void this.processJobs().catch(() => { this.scheduler.lastError = '本地记录处理失败，请检查磁盘空间。'; });
    return '已记录，正在整理。填报完成后请回复“已填报”。';
  }

  async retry() {
    const { date } = beijing(this.now());
    await this.store.update(state => {
      const day = dayRecord(state, date);
      for (const job of Object.values(day.jobs || {})) if (job.status === 'failed') job.status = 'pending';
    });
    void this.processJobs().catch(() => { this.scheduler.lastError = '本地记录处理失败，请检查磁盘空间。'; });
    return '已安排重试。';
  }

  async handle(text, messageId) {
    const previous = this.store.snapshot().messages[messageId];
    if (previous) return previous;
    let response;
    if (text === '已填报') response = await this.complete();
    else if (text === '撤销完成') response = await this.complete(false);
    else if (text === '测试') response = '收发正常。发送工作内容可整理日报；填好后回复“已填报”。';
    else if (text === '状态') response = `${beijing(this.now()).date}：${this.status().today.completed ? '已填报' : '尚未确认填报'}。提醒${this.store.snapshot().enabled ? '已启用' : '未启用'}。`;
    else if (text === '重试') response = await this.retry();
    else if (text === '周计划') response = weeklyPrompt(this.store.snapshot(), beijing(this.now()).date);
    else if (/^周计划[\s：:]/.test(text)) { await this.record(text.replace(/^周计划[\s：:]+/, ''), 'weekly', 'wecom'); response = '已收到，整理后请你核对。'; }
    else response = await this.record(text.replace(/^记录[\s：:]+/, ''), 'daily', 'wecom');
    await this.store.update(state => {
      state.messages[messageId] = response;
      const ids = Object.keys(state.messages);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete state.messages[id];
    });
    return response;
  }

  async processJobs() {
    if (this.processing) return;
    this.processing = true;
    try {
      const { date } = beijing(this.now());
      for (;;) {
        if (beijing(this.now()).date !== date) break;
        const state = this.store.snapshot(); const day = state.days[date];
        const entry = Object.entries(day?.jobs || {}).find(([, job]) => job.status === 'pending');
        if (!entry) break;
        const [kind, job] = entry;
        const notes = kind === 'weekly'
          ? Object.entries(state.days).filter(([key]) => key >= addDays(date, -6) && key <= date).map(([key, value]) => ({ date: key, notes: value.notes, summary: value.summary, draft: value.weekly }))
          : day.notes.filter(note => note.kind === 'daily').map(note => note.text);
        try {
          const text = await this.writer.summarize(kind, notes);
          await this.store.update(next => {
            const current = dayRecord(next, date);
            if (current.jobs[kind].id !== job.id) return;
            current.jobs[kind].status = 'done';
            if (kind === 'daily') current.summary = text; else current.weekly = text;
            if (job.origin === 'wecom') {
              current.outbox ||= {};
              current.outbox[kind] = { id: job.id, text: kind === 'daily' ? `填报参考：${text}` : `核对草稿：\n${text}`, sent: false };
            }
          });
        } catch {
          await this.store.update(next => {
            const current = dayRecord(next, date);
            if (current.jobs[kind].id === job.id) {
              current.jobs[kind].status = 'failed';
              if (job.origin === 'wecom') {
                current.outbox ||= {};
                current.outbox[kind] = { id: job.id, text: '原始内容已记录，整理暂未成功。可稍后回复“重试”。', sent: false };
              }
            }
          });
        }
      }
    } finally { this.processing = false; }
    await this.flushOutbox();
  }

  async flushOutbox() {
    const now = this.now(); const { date } = beijing(now);
    if (this.flushing || now.getTime() < this.lastPushAttempt + 60000 || this.wecom.status().connection !== 'connected') return;
    const pending = Object.entries(this.store.snapshot().days[date]?.outbox || {}).filter(([, message]) => !message.sent);
    if (!pending.length) return;
    this.flushing = true;
    this.lastPushAttempt = now.getTime();
    try { for (const [kind, message] of pending) {
      if (beijing(this.now()).date !== date) break;
      try {
        await this.wecom.push(message.text);
        await this.store.update(state => { const current = dayRecord(state, date).outbox?.[kind]; if (current?.id === message.id) current.sent = true; });
      } catch { break; }
    } } finally { this.flushing = false; }
  }
}
