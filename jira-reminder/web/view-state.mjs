export function runtimeView(status, reachable = true) {
  if (!reachable || !status?.work) return { text: '后台未连接', color: 'red' };
  if (!status.work.enabled) return { text: '提醒已暂停', color: 'amber' };
  if (status.work.notice) return { text: '运行中 · 检查需处理', color: 'amber' };
  if (status.connection !== 'connected') return { text: '运行中 · 等待企业微信', color: 'amber' };
  return { text: '正在运行', color: 'green' };
}

export function nextReminder(status) {
  if (!status?.work?.enabled) return { time: '已暂停', description: '可在设置中恢复提醒' };
  const time = new Date(new Date(status.serverTime).getTime() + 8 * 3600000);
  const hour = time.getUTCHours();
  const day = status.work.today;
  const reminder = day.reminder;
  const customPending = !day.completed && reminder && ['local', 'wecom'].some(channel => !day.sent?.[`report-custom:${reminder.id}.${channel}`]);
  if (hour >= 15 && !day.jira) return { time: '待补执行', description: '联网后自动检查今天的任务' };
  if (customPending && (hour >= 15 || Date.parse(reminder.at) < Date.parse(time.toISOString().slice(0, 10) + 'T15:00:00+08:00'))) {
    if (Date.parse(reminder.at) <= Date.parse(status.serverTime)) return { time: '待补执行', description: '已到约定的填报时间，正在等待送达' };
    return { time: new Date(Date.parse(reminder.at) + 8 * 3600000).toISOString().slice(11, 16), description: '今天 · 约定的填报提醒' };
  }
  if (hour < 15) return { time: '15:00', description: customPending ? '今天 · 临期检查，填报已改期' : '今天 · 日报与临期检查' };
  if (hour < 22 && !day.completed) return { time: '22:00', description: '今天 · 填报完成情况复查' };
  if (hour >= 22 && !day.completed && (!day.sent?.['report22.local'] || !day.sent?.['report22.wecom'])) return { time: '待补执行', description: '今日填报提醒正在等待送达' };
  return { time: '15:00', description: '明天 · 日报与临期检查' };
}

export function dueLabel(due, date) {
  const days = Math.round((Date.parse(due) - Date.parse(date)) / 86400000);
  return ['今天到期', '明日到期', '后天到期'][days] || '到期';
}

export function issueView(status) {
  const current = status?.jira;
  const saved = status?.work?.today?.jira;
  if (current?.lastCheckAt && (!saved?.checkedAt || current.lastCheckAt >= saved.checkedAt)) return { issues: current.issues, checkedAt: current.lastCheckAt };
  return { issues: saved?.issues || [], checkedAt: saved?.checkedAt || null };
}
