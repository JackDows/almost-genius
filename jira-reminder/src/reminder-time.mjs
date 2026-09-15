import { beijing } from './dates.mjs';

const digits = '零一二三四五六七八九';
function number(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const value = text.replaceAll('两', '二').replaceAll('〇', '零');
  if (value === '十') return 10;
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, ones] = value.split('十');
    return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
  }
  return value.length === 1 ? digits.indexOf(value) : NaN;
}

// 只解析明确的当天改期指令，不让模型凭一句工作描述改变提醒安排。
export function reminderCommand(text, now) {
  const compact = text.replace(/\s+/g, '').replace(/：/g, ':');
  if (/^(取消稍后提醒|取消改期|恢复默认提醒)[。！!？?]?$/.test(compact)) return { time: null };
  if (!/(提醒我|再提醒|提醒.*(?:改|调整|推迟)|(?:推迟|改到|调整).*(?:提醒))/.test(compact)) return null;
  if (/(明天|明日|后天|每天|每日|下周|星期|周[一二三四五六日天]|天后|\d{4}[-./年])/.test(compact)) return { error: '这里只调整今天的填报提醒，例如“今天18:00再提醒我”。' };
  const help = { error: '请明确今天的时间，例如“今天18:00再提醒我”或“半小时后提醒我”。' };
  if (/\d+:\d{3,}/.test(compact)) return help;
  const relative = compact.match(/(半|[\d零〇一二两三四五六七八九十]+)(分钟|小时)后/);
  if (relative) {
    const amount = relative[1] === '半' ? 0.5 : number(relative[1]);
    if (!Number.isFinite(amount) || amount <= 0) return help;
    const later = new Date(Math.ceil((now.getTime() + amount * (relative[2] === '小时' ? 3600000 : 60000)) / 60000) * 60000);
    if (beijing(later).date !== beijing(now).date) return { error: '改期时间需在今天内，跨日后会恢复默认提醒。' };
    return { time: new Date(later.getTime() + 8 * 3600000).toISOString().slice(11, 16) };
  }
  const clock = compact.match(/(凌晨|早上|上午|中午|下午|晚上|晚间)?([\d零〇一二两三四五六七八九十]+)(?::([\d]{1,2})|[点时](半|[\d零〇一二两三四五六七八九十]+分?)?)/);
  if (!clock) return help;
  let hour = number(clock[2]);
  const minute = clock[3] ? Number(clock[3]) : clock[4] === '半' ? 30 : clock[4] ? number(clock[4].replace(/分$/, '')) : 0;
  if (['晚上', '晚间'].includes(clock[1]) && hour === 12) return { error: '晚上十二点已跨日，请指定今天内的提醒时间。' };
  if (['早上', '上午', '凌晨'].includes(clock[1]) && hour > 12) return help;
  if (['下午', '晚上', '晚间'].includes(clock[1]) && hour >= 1 && hour <= 11) hour += 12;
  if (clock[1] === '中午' && hour >= 1 && hour <= 2) hour += 12;
  if (clock[1] === '凌晨' && hour === 12) hour = 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return help;
  if (!clock[1] && !clock[3] && hour >= 1 && hour <= 11) return { error: '请补充上午或下午，例如“下午六点再提醒我”，也可以写“18:00再提醒我”。' };
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}
