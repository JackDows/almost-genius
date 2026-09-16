export class WorkHoursError extends Error {}

export function validWorkDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
}

function clockMinutes(value, label) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new WorkHoursError(`请告诉我${label}，例如 22:00。`);
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function durationText(minutes) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 小时';
}

export function jiraDuration(minutes) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours}h` : '', rest ? `${rest}m` : ''].filter(Boolean).join(' ') || '0m';
}

// 用整数分钟计算，避免小数舍入；规则按工作归属日期判断，跨午夜不切换到次日规则。
export function calculateWorkHours(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validWorkDate(input.date)) throw new WorkHoursError('请填写有效的工作日期。');
  const { date, endTime, nextDay = false } = input;
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const mode = input.mode ?? (weekday === 0 ? 'interval' : 'schedule');
  if (!['schedule', 'interval'].includes(mode) || typeof nextDay !== 'boolean') throw new WorkHoursError('计时方式或跨日选项无效。');
  if (weekday === 0 && mode !== 'interval') throw new WorkHoursError('周日请提供上班时间、下班时间和休息分钟数，按实际时段减去休息计算。');
  const end = clockMinutes(endTime, '下班时间') + (nextDay ? 1440 : 0);
  let baseMinutes = null, overtimeMinutes = null, totalMinutes, startTime, breakMinutes, calculation;
  if (mode === 'schedule') {
    const threshold = weekday === 6 ? 16 * 60 : 18 * 60;
    if (input.startTime !== undefined || input.breakMinutes !== undefined) throw new WorkHoursError('日常规则已包含基础工时；如有特殊安排，请告诉我实际起止时间和休息多久，我按实际时长算。');
    if (end < threshold) throw new WorkHoursError('今天提前下班的话，你几点上班、休息了多久？我按实际时长帮你算。');
    if (end > 9 * 60 + 1440) throw new WorkHoursError('工作时段不能超过 24 小时，请检查工作日期和次日下班选项。');
    baseMinutes = weekday === 6 ? 300 : 420;
    overtimeMinutes = end - threshold;
    totalMinutes = baseMinutes + overtimeMinutes;
    calculation = `基础 ${durationText(baseMinutes)} + 加班 ${durationText(overtimeMinutes)} = ${durationText(totalMinutes)}`;
  } else {
    startTime = input.startTime;
    if (startTime === undefined || input.breakMinutes === undefined) throw new WorkHoursError('请告诉我几点上班、几点下班，休息多久；没休息也请说明。');
    const start = clockMinutes(startTime, '上班时间');
    const elapsed = end - start;
    breakMinutes = input.breakMinutes;
    if (elapsed <= 0 || elapsed > 1440) throw new WorkHoursError('下班须晚于上班且时段不超过 24 小时；跨午夜请说明是次日下班。');
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > elapsed) throw new WorkHoursError('休息需填写整数分钟，且不能超过整个工作时段。');
    totalMinutes = elapsed - breakMinutes;
    calculation = `${startTime}–${nextDay ? '次日 ' : ''}${endTime}，共 ${durationText(elapsed)} − 休息 ${durationText(breakMinutes)} = ${durationText(totalMinutes)}`;
  }
  return { ruleVersion: 1, date, mode, endTime, nextDay, ...(mode === 'interval' ? { startTime, breakMinutes } : {}), baseMinutes, overtimeMinutes, totalMinutes, timeSpentSeconds: totalMinutes * 60, display: durationText(totalMinutes), jiraDuration: jiraDuration(totalMinutes), calculation };
}

export function validateWorkHours(record, date) {
  if (!record || record.ruleVersion !== 1 || record.date !== date || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new WorkHoursError('工时记录无效。');
  const expected = calculateWorkHours(record);
  for (const [key, value] of Object.entries(expected)) if (record[key] !== value) throw new WorkHoursError('工时记录与计算规则不一致。');
  return record;
}

export function workHoursReference(now, days = {}) {
  const local = new Date(now.getTime() + 8 * 3600000).toISOString();
  const date = local.slice(0, 10), time = local.slice(11, 16);
  const saved = days[date]?.workHours;
  if (saved) return { ...saved, state: 'saved', label: '已计算的日报工时' };
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  if (weekday === 0) return { date, state: 'needs_details', label: '周日按实际时长计算', display: '待确认', message: '告诉我几点上班、几点下班、休息多久，我来算。' };
  const end = weekday === 6 ? '16:00' : '18:00';
  return { ...calculateWorkHours({ date, endTime: time < end ? end : time }), state: time < end ? 'base' : 'estimate', label: time < end ? '正常下班的工时' : `若按 ${time} 下班` };
}

export function hoursReferenceText(reference) {
  return reference.state === 'needs_details' ? `周日工时：${reference.message}` : `${reference.label}：${reference.display}（Jira：${reference.jiraDuration}）。`;
}

export function clockOutInput(now) {
  const local = new Date(now.getTime() + 8 * 3600000).toISOString();
  let date = local.slice(0, 10);
  const endTime = local.slice(11, 16), nextDay = endTime < '09:00';
  if (nextDay) date = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  return { date, endTime, nextDay };
}

export function isClockOutMessage(text) {
  return typeof text === 'string' && /^(?:我)?(?:今天|现在)?(?:已经|已)?下班(?:了|啦|咯|了哈)?[。！!～~]*$/.test(text.trim());
}
