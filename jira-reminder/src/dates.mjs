const DAY = 86400000;
export function beijing(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), weekday: shifted.getUTCDay() };
}
export function addDays(date, days) { return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10); }
export function weekStart(date) { const weekday = new Date(date + 'T00:00:00Z').getUTCDay(); return addDays(date, -(weekday === 0 ? 6 : weekday - 1)); }
export function dayRecord(state, date) {
  return state.days[date] ||= { completed: false, notes: [], summary: '', sent: {}, jira: null, weekly: null };
}
