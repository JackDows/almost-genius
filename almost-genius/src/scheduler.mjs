import { weekStart } from './dates.mjs';
import { activitiesInRange } from './history.mjs';

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
