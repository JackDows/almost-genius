import { beijing, dayRecord, addDays } from './dates.mjs';
import { occurrence, runId } from './tasks.mjs';
import { weeklyPrompt } from './scheduler.mjs';
import { workHoursReference, hoursReferenceText } from './work-hours.mjs';

export function dueText(issues, date) {
  const escape = v => String(v).replace(/[\[\]()*_`<>\\\r\n]/g, ' ');
  const labels = { [date]: '今天到期', [addDays(date, 1)]: '明日到期', [addDays(date, 2)]: '后天到期' };
  return issues.length ? '临期任务：\n' + [...issues].sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key)).map((i, n) => `${n + 1}、[${escape(i.title)}（${i.key}）](${i.url}) ${labels[i.due] || '即将到期'} 到期时间${i.due.replaceAll('-', '.')}`).join('\n') : '';
}
export class TaskScheduler {
  constructor(options) { Object.assign(this, { now: () => new Date(), ...options }); this.running = false; this.lastTickAt = null; this.lastError = ''; this.network = 'unknown'; }
  valid(task, slot) {
    const s = this.store.snapshot(), current = s.tasks[task.id];
    if (!s.enabled || !current || current.revision !== task.revision || beijing(this.now()).date !== slot.date || task.reportIncomplete && s.days[slot.date]?.completed) return false;
    const started = s.taskRuns[runId(task, slot)]?.startedAt;
    const next = occurrence(started ? { ...current, missed: 'today' } : current, this.now(), s);
    return next && runId(current, next) === runId(task, slot);
  }
  async set(id, patch) { await this.store.update(s => { if (s.taskRuns[id]) Object.assign(s.taskRuns[id], patch); }); }
  async tick() {
    if (this.running || this.maintenance?.() || !this.store.snapshot().enabled) return;
    this.running = true;
    try {
      const now = this.now(), { date } = beijing(now);
      this.lastTickAt = now.toISOString();
      const snapshot = this.store.snapshot();
      const terminal = ['done','skipped','cancelled'];
      const expired = Object.values(snapshot.taskRuns).filter(r => !terminal.includes(r.status) && (!snapshot.tasks[r.taskId] || !this.valid(snapshot.tasks[r.taskId], r)));
      if (expired.length) await this.store.update(s => { for (const run of expired) if (s.taskRuns[run.id]?.revision === run.revision) { s.taskRuns[run.id].status = 'skipped'; s.taskRuns[run.id].error = null; } });
      const tasks = this.tasks.list().map(task => {
        const state = this.store.snapshot();
        const active = Object.values(state.taskRuns).find(r => r.taskId === task.id && r.startedAt && !terminal.includes(r.status) && this.valid(task, r));
        return { task, slot: occurrence(task, now, state) || active };
      }).filter(({ task, slot }) => slot && this.valid(task, slot));
      if (!tasks.some(({ task, slot }) => { const run = this.store.snapshot().taskRuns[runId(task, slot)]; return !['done', 'skipped', 'cancelled'].includes(run?.status) || run?.status === 'cancelled' && run.revision !== task.revision; })) return;
      const online = this.wecom.status().connection === 'connected' || await this.online();
      this.network = online ? 'online' : 'offline';
      if (!online && !this.store.snapshot().days[date]?.sent?.['offline.local']) {
        await this.notify('Almost Genius', '当前未联网，请连接网络。联网后会自动补检查。');
        await this.store.update(s => { dayRecord(s, date).sent['offline.local'] = this.now().toISOString(); });
      }
      for (const { task, slot } of tasks) {
        if (!this.valid(task, slot) || this.maintenance?.()) continue;
        const id = runId(task, slot); let run = this.store.snapshot().taskRuns[id];
        if (run?.status === 'cancelled' && run.revision !== task.revision) { await this.set(id, { revision: task.revision, status: 'pending', text: '', error: null, retryAt: null, wecomChunks: 0 }); run = this.store.snapshot().taskRuns[id]; }
        if (run && ['done', 'skipped', 'cancelled'].includes(run.status)) continue;
        if (!run) {
          run = { id, taskId: task.id, revision: task.revision, ...slot, status: 'pending', channels: {}, text: '', attempts: 0 };
          await this.store.update(s => {
            s.taskRuns[id] = run;
            const old = Object.values(s.taskRuns).filter(r => r.date < addDays(date, -90));
            for (const item of old) delete s.taskRuns[item.id];
          });
        }
        if (task.channels.every(c => run.channels[c])) { await this.set(id, { status: 'done' }); continue; }
        if (run.retryAt && Date.parse(run.retryAt) > this.now()) continue;
        if (run.status === 'running') continue;
        try {
          if (!run.text) {
            if (task.action === 'agent') {
              if (!online || this.assistant.writer.busy) continue;
              await this.set(id, { status: 'running', startedAt: this.now().toISOString() });
              // AI 在独立异步工作中运行，不阻塞其它任务、本机提醒和用户改期。
              void this.runAgent(task, slot, id);
              continue;
            }
            let text;
            if (task.action === 'jira') {
              if (!online) continue;
              await this.set(id, { startedAt: this.now().toISOString() });
              const issues = await this.jira.upcoming(date, task.dueDays);
              if (!this.valid(task, slot)) { await this.set(id, { status: 'cancelled' }); continue; }
              await this.store.update(s => { dayRecord(s, date).jira = { checkedAt: this.now().toISOString(), issues, scope: `today+${task.dueDays}` }; });
              text = dueText(issues, date);
            } else if (task.action === 'weekly') text = weeklyPrompt(this.store.snapshot(), date);
            else if (task.action === 'report') {
              text = slot.customId ? '到约定的填报时间了，今天做了什么？已填好请回复“已填报”。' : '今天做了什么？我帮你整理50字以内的填报内容。已填好请回复“已填报”。';
              text += '\n' + hoursReferenceText(workHoursReference(this.now(), this.store.snapshot().days));
            }
            else text = task.instructions;
            await this.set(id, { text, status: text ? 'ready' : 'skipped', error: null, startedAt: this.store.snapshot().taskRuns[id].startedAt || this.now().toISOString() });
            if (!text) continue;
          }
          for (const channel of ['local', 'wecom'].filter(c => task.channels.includes(c))) {
            run = this.store.snapshot().taskRuns[id];
            if (run.channels[channel] || !this.valid(task, slot)) continue;
            if (channel === 'wecom' && this.wecom.status().connection !== 'connected') continue;
            if (channel === 'wecom') await this.wecom.push(run.text, { completedChunks: run.wecomChunks || 0, valid: () => this.valid(task, slot), onProgress: count => this.set(id, { wecomChunks: count }) }); else await this.notify(task.title, run.text);
            await this.store.update(s => {
              s.taskRuns[id].channels[channel] = this.now().toISOString();
              if (s.assistant && !s.taskRuns[id].contextSaved) {
                s.assistant.turns.push({ role: 'assistant', text: run.text, at: this.now().toISOString(), taskId: task.id, scheduled: true });
                s.taskRuns[id].contextSaved = true;
              }
              // 保留旧版今日状态页与备份的已发送标记。
              const key = task.action === 'jira' ? 'jira' : task.action === 'weekly' ? 'weekly' : slot.customId ? `report-custom:${slot.customId}` : beijing(new Date(slot.at)).hour >= 22 ? 'report22' : 'report15';
              if (['daily-report', 'jira-due', 'weekly-review'].includes(task.id)) dayRecord(s, date).sent[`${key}.${channel}`] = this.now().toISOString();
            });
          }
          run = this.store.snapshot().taskRuns[id];
          if (task.channels.every(c => run.channels[c])) await this.set(id, { status: 'done' });
          this.lastError = '';
        } catch {
          this.lastError = `“${task.title}”未完成，稍后自动重试；详情可在任务页查看。`;
          const current = this.store.snapshot().taskRuns[id];
          await this.set(id, { status: 'failed', error: this.lastError, retryAt: new Date(this.now().getTime() + (current.text ? 60000 : 300000)).toISOString(), attempts: (run.attempts || 0) + 1 });
          if (task.action === 'jira' && !current.text && this.valid(task, slot) && !this.store.snapshot().days[date]?.sent?.['jira-error.local']) {
            await this.notify('Jira 检查需要处理', this.jira.status().notice || this.lastError);
            await this.store.update(s => { dayRecord(s, date).sent['jira-error.local'] = this.now().toISOString(); });
          }
        }
      }
    } finally {
      this.lastError = Object.values(this.store.snapshot().taskRuns || {}).find(r => r.date === beijing(this.now()).date && r.error && ['failed','skipped'].includes(r.status))?.error || '';
      this.running = false;
    }
  }
  async runAgent(task, slot, id) {
    try {
      const result = await this.assistant.scheduled(task, () => this.valid(task, slot));
      if (!this.valid(task, slot)) return await this.set(id, { status: 'cancelled' });
      await this.set(id, { text: result.text, status: result.notify && result.text ? 'ready' : 'skipped', error: null });
    } catch {
      // 工具可能已成功写入候选；失败时不自动重做 AI 写操作。
      await this.set(id, { status: 'skipped', error: 'AI 未完成，本次不自动重做。请在对话中查看操作结果后重试。' });
      this.lastError = `“${task.title}”的 AI 执行未完成。`;
    }
  }
  async recover() {
    await this.store.update(s => { for (const run of Object.values(s.taskRuns)) if (run.status === 'running') { run.status = 'skipped'; run.error = '上次运行中断，请核对结果。'; } });
  }
}
