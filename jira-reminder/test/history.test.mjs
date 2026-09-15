import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { historyRange,readJiraHistory,HistoryService } from '../src/history.mjs';
import { StateStore } from '../src/store.mjs';
import { weeklyPrompt } from '../src/scheduler.mjs';
import { encryptBackup,decryptBackup } from '../src/backup.mjs';
import { JIRA_BASE } from '../src/jira.mjs';

const log=(id,started,author='self')=>({id,started,author:{key:author,name:author},comment:'完成测试联调',timeSpentSeconds:3600});
function fakeJira(logs) {
  return {credentials:{username:'self'},async request(endpoint) {
    if(endpoint==='myself') return {name:'self',key:'self',timeZone:'Etc/UTC'};
    const query=new URLSearchParams(endpoint.split('?')[1]);
    if(endpoint.startsWith('search?')) {
      assert.match(query.get('jql'),/worklogAuthor = currentUser/);
      assert.doesNotMatch(query.get('jql'),/assignee|statusCategory/);
      return {startAt:0,total:1,issues:[{key:'T-1',fields:{summary:'已完成且已改派的任务'}}]};
    }
    const startAt=Number(query.get('startAt'));
    return {startAt,total:logs.length,worklogs:logs.slice(startAt,startAt+2)};
  }};
}
test('两个月按日历月回退，月末、闰年和跨年正确',()=>{
  assert.deepEqual(historyRange('2026-09-15'),{from:'2026-07-15',to:'2026-09-15'});
  assert.equal(historyRange('2026-08-31').from,'2026-06-30');
  assert.equal(historyRange('2028-04-30').from,'2028-02-29');
  assert.equal(historyRange('2026-01-31').from,'2025-11-30');
});
test('工时逐页读取，按作者而非经办人筛选，UTC 时间转北京时间',async()=>{
  const jira=fakeJira([
    log('1','2026-07-14T16:00:00.000+0000'),
    log('2','2026-07-16T01:00:00.000+0000','other'),
    log('3','2026-07-14T15:59:59.000+0000'),
    log('4','2026-09-15T15:59:59.000+0000'),
    log('5','2026-09-15T16:00:00.000+0000')]);
  const result=await readJiraHistory(jira,historyRange('2026-09-15'));
  assert.deepEqual(result.records.map(r=>r.externalId),['1','4']);
  assert.deepEqual(result.records.map(r=>r.date),['2026-07-15','2026-09-15']);
  assert.equal(result.records[0].source,'jira'); assert.equal(result.records[0].timeSpentSeconds,3600);
});
test('服务器忽略分页时拒绝不完整的历史',async()=>{
  const jira=fakeJira([]), original=jira.request;
  jira.request=async endpoint=>endpoint.startsWith('issue/') ? {total:3,startAt:0,worklogs:[log('1','2026-09-15T01:00:00Z')]} : original(endpoint);
  await assert.rejects(readJiraHistory(jira,historyRange('2026-09-15')),/分页不完整/);
});
test('历史同步幂等，更新和删除记录，失败保留旧数据；来源记录进入备份和周报素材',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'jwr-history-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new StateStore(dir); await store.initialize();
  const logs=[log('1','2026-09-14T01:00:00Z'),log('2','2026-09-15T01:00:00Z')];
  const jira=fakeJira(logs), history=new HistoryService({store,jira,now:()=>new Date('2026-09-15T15:00:00+08:00')});
  assert.equal(await history.sync(),true); assert.equal(await history.sync(),true); assert.equal(history.list().length,2);
  assert.deepEqual(store.snapshot().days,{});
  assert.match(weeklyPrompt(store.snapshot(),'2026-09-15'),/完成测试联调/);
  logs.pop(); logs[0].comment='修改后的日报';
  assert.equal(await history.sync(),true); assert.equal(history.list().length,1); assert.equal(history.list()[0].text,'修改后的日报');
  const before=store.snapshot(); jira.request=async()=>{throw new Error('unavailable');};
  assert.equal(await history.sync(),false); assert.deepEqual(store.snapshot(),before);
  const cipher=await encryptBackup({format:1,state:before,wecom:null,jira:null},'history-test-password');
  const restored=await decryptBackup(cipher,'history-test-password');
  assert.equal(Object.values(restored.state.activities)[0].sourceUrl,JIRA_BASE);
  assert.equal(Object.values(restored.state.activities)[0].text,'修改后的日报');
});
