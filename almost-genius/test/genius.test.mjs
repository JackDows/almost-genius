import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskService, validateTask, occurrence, runId, validDate } from '../src/tasks.mjs';
import { TaskScheduler } from '../src/task-scheduler.mjs';
import { ArchiveService } from '../src/archive.mjs';
import { ToolService, ToolGateway } from '../src/agent-tools.mjs';
import { AssistantService } from '../src/assistant.mjs';
import { WorkService } from '../src/work.mjs';
import { encryptBackup, decryptBackup } from '../src/backup.mjs';
import { dayRecord } from '../src/dates.mjs';
import { WecomSetup, splitMessages } from '../src/wecom.mjs';

class MemoryStore {
  constructor(value = {}) { this.value = {version:1,enabled:true,days:{},messages:{},...value}; this.queue=Promise.resolve(); }
  snapshot() { return structuredClone(this.value); }
  update(fn) { const operation=this.queue.then(()=>{const next=this.snapshot();fn(next);this.value=next;});this.queue=operation.catch(()=>{});return operation; }
}
test('中文长行按字节安全拆分，发送中断只重试未确认分段',async()=>{
  const content='中文🙂'.repeat(1000), chunks=splitMessages(content);
  assert.equal(chunks.join(''),content);assert.ok(chunks.every(c=>Buffer.byteLength(c)<=3500));
  const bot=new WecomSetup({});bot.connection='connected';bot.credentials={userId:'fake'};
  let count=0,attempt=0,fail=true;const received=[];
  bot.client={sendMessage:async(user,message)=>{attempt++;if(fail&&attempt===2)throw new Error('network');received.push(message.markdown.content);}};
  await assert.rejects(()=>bot.push(content,{onProgress:async n=>{count=n;}}));assert.equal(count,1);
  fail=false;await bot.push(content,{completedChunks:count,onProgress:async n=>{count=n;}});
  assert.deepEqual(received,chunks);
});
const input = (extra={}) => ({title:'站起来走走',instructions:'该活动一下了。',action:'reminder',schedule:{type:'daily',times:['15:00']},channels:['local','wecom'],...extra});
async function fixture(date='2026-09-15T07:00:00Z', initial={}) {
  let clock=new Date(date), connected=true, network=true;
  const store=new MemoryStore(initial), tasks=new TaskService(store,()=>clock); await tasks.initialize();
  const local=[],wecom=[];
  const bot={status:()=>({connection:connected?'connected':'disconnected',paired:true}),push:async text=>wecom.push(text)};
  const jira={upcoming:async()=>[],status:()=>({configured:true})};
  const scheduler=new TaskScheduler({store,tasks,jira,wecom:bot,notify:async(title,text)=>local.push({title,text}),online:async()=>network,now:()=>clock});
  const writer={busy:false,notice:'',summarize:async()=>'整理完成'};
  const work=new WorkService({store,writer,wecom:bot,scheduler,notify:scheduler.notify,now:()=>clock});
  return {store,tasks,local,wecom,bot,jira,scheduler,work,writer,setTime:value=>{clock=new Date(value);},offline:()=>{connected=network=false;},online:()=>{connected=network=true;}};
}

test('全新任务从零创建，校验参数、修订冲突、暂停、删除恢复和撤销',async()=>{
  const f=await fixture(); const created=await f.tasks.create(input());
  assert.equal(created.revision,1); assert.equal(f.tasks.list().length,4);
  const changed=await f.tasks.change(created.id,1,'update',{schedule:{type:'weekly',times:['18:00'],weekdays:[5]}});
  assert.equal(changed.next,'2026-09-18T10:00:00.000Z');
  await assert.rejects(()=>f.tasks.change(created.id,1,'delete'),/修改/);
  await f.tasks.undo(); assert.equal(f.tasks.get(created.id).schedule.type,'daily');
  let t=await f.tasks.change(created.id,3,'delete'); assert.equal(f.tasks.list().length,3);
  t=await f.tasks.change(created.id,t.revision,'restore'); assert.equal(t.enabled,false);
  assert.throws(()=>validateTask(input({tools:['shell.run']})),/能力/);
  assert.throws(()=>validateTask(input({enabled:'false'})),/布尔/);
  assert.equal(validDate('2026-99-99'),false); assert.equal(validDate('2026-02-30'),false);
});
test('北京时间单次、间隔、每周、同日补跑与错过跳过',()=>{
  const state={days:{}},now=new Date('2026-09-15T10:00:00Z');
  assert.equal(occurrence(validateTask(input()),now,state).at,'2026-09-15T07:00:00.000Z');
  assert.equal(occurrence(validateTask(input({missed:'skip'})),now,state),null);
  assert.equal(occurrence(validateTask(input({schedule:{type:'once',at:'2026-09-14T15:00:00+08:00'}})),now,state),null);
  assert.equal(occurrence(validateTask(input({schedule:{type:'interval',minutes:60,anchor:'2026-09-15T15:00:00+08:00'}})),now,state).at,'2026-09-15T10:00:00.000Z');
  assert.equal(occurrence(validateTask(input({schedule:{type:'weekly',times:['15:00'],weekdays:[6]}})),now,state),null);
});
test('新版调度默认15点与22点分渠道一次，完成后不再催报，周日也运行',async()=>{
  const f=await fixture(); await f.scheduler.tick();await f.scheduler.tick();assert.equal(f.wecom.length,1);assert.equal(f.local.length,1);
  f.setTime('2026-09-15T14:00:00Z');await f.scheduler.tick();assert.equal(f.wecom.length,2);
  f.setTime('2026-09-20T07:00:00Z');await f.work.complete();await f.scheduler.tick();assert.equal(f.wecom.length,2);
  assert.equal(f.jira.lastError,undefined);
});
test('升级迁移既有已发送状态，无重复；离线通知与联网补发独立',async()=>{
  const initial={days:{'2026-09-15':{completed:false,notes:[],sent:{'report15.local':'x','report15.wecom':'x'}}}};
  const f=await fixture(undefined,initial);await f.scheduler.tick();assert.equal(f.wecom.length,0);
  f.setTime('2026-09-16T07:00:00Z');f.offline();await f.scheduler.tick();await f.scheduler.tick();assert.equal(f.local.length,2);assert.equal(f.wecom.length,0);
  f.online();await f.scheduler.tick();assert.equal(f.wecom.length,1);assert.equal(f.local.length,2);
});
test('晚间首次开机只补最近一次；改期18点保存，22点复查，跨日不补昨天',async()=>{
  const late=await fixture('2026-09-15T15:30:00Z');await late.scheduler.tick();assert.equal(late.wecom.length,1);
  const f=await fixture('2026-09-15T06:00:00Z');await f.work.setReminder('18:00');f.setTime('2026-09-15T07:00:00Z');await f.scheduler.tick();assert.equal(f.wecom.length,0);
  f.setTime('2026-09-15T10:00:00Z');await f.scheduler.tick();assert.equal(f.wecom.length,1);
  f.setTime('2026-09-15T14:00:00Z');await f.scheduler.tick();assert.equal(f.wecom.length,2);
  f.setTime('2026-09-15T16:05:00Z');await f.scheduler.tick();assert.equal(f.wecom.length,2);
});
test('临期范围可修改且标题日期正确，Jira 查询期间完成或改期不发送旧提醒',async()=>{
  const f=await fixture(); const seen=[];
  f.jira.upcoming=async(date,days)=>{seen.push(days);await f.work.complete();return [{key:'AG-1',title:'测试',due:date,url:'https://jira.aonorx.com/browse/AG-1'}];};
  await f.tasks.change('jira-due',1,'update',{dueDays:5});await f.scheduler.tick();
  assert.deepEqual(seen,[5]);assert.match(f.wecom.at(-1),/临期任务：[\s\S]*今天到期 到期时间2026.09.15/);
});
test('修改已开始的 AI 任务会拒绝旧结果，暂停后恢复能补执行',async()=>{
  const f=await fixture();await f.store.update(s=>{for(const t of Object.values(s.tasks))t.enabled=false;});
  let finish; const wait=new Promise(r=>finish=r); f.scheduler.assistant={writer:{busy:false},scheduled:async()=>wait};
  let task=await f.tasks.create(input({action:'agent'}));await f.scheduler.tick();
  task=await f.tasks.change(task.id,task.revision,'pause');finish({text:'过期结果',notify:true});await new Promise(r=>setImmediate(r));await f.scheduler.tick();assert.equal(f.wecom.length,0);
  task=await f.tasks.change(task.id,task.revision,'update',{action:'reminder'});await f.tasks.change(task.id,task.revision,'resume');await f.scheduler.tick();assert.equal(f.wecom.length,1);
});
test('档案保存真实证据、中文检索、确认与编辑后重新核对，原始资料删除不丢证据',async()=>{
  const f=await fixture();await f.store.update(s=>{dayRecord(s,'2026-09-15').notes.push({kind:'daily',text:'调试设备通讯协议',at:'2026-09-15T07:00:00Z'});});
  const archive=new ArchiveService(f.store);await archive.initialize('正在学习嵌入式');
  const entry=await archive.propose({type:'experience',title:'设备通讯调试',content:'分析通讯超时问题，结果待确认。',sourceIds:['note:2026-09-15:0']});
  assert.equal(entry.status,'candidate');assert.equal(archive.search('通讯')[0].id,entry.id);
  await assert.rejects(()=>archive.propose({type:'skill',title:'错误来源',content:'未知',sourceIds:['invented']}),/来源/);
  let changed=await archive.change(entry.id,1,'confirm');assert.equal(changed.status,'confirmed');
  changed=await archive.change(entry.id,2,'update',{content:'通过日志定位超时原因。'});assert.equal(changed.status,'candidate');
  await f.store.update(s=>{s.days={};});assert.equal(archive.get(entry.id).evidence[0].text,'调试设备通讯协议');
  assert.match(archive.export().markdown,/调试设备通讯协议/);
});
test('跳过策略只限制启动时间；已开始的AI可完成，离线未启动的过期记录会关闭',async()=>{
  const f=await fixture();await f.store.update(s=>{for(const t of Object.values(s.tasks))t.enabled=false;});
  let finish;const pending=new Promise(r=>finish=r);f.scheduler.assistant={writer:{busy:false},scheduled:async()=>pending};
  const task=await f.tasks.create(input({action:'agent',missed:'skip'}));await f.scheduler.tick();
  f.setTime('2026-09-15T07:02:00Z');finish({text:'已开始任务的结果',notify:true});await new Promise(r=>setImmediate(r));await f.scheduler.tick();assert.equal(f.wecom.length,1);
  const g=await fixture();await g.store.update(s=>{for(const t of Object.values(s.tasks))t.enabled=false;});g.offline();
  const skipped=await g.tasks.create(input({action:'agent',missed:'skip'}));g.scheduler.assistant={writer:{busy:false}};await g.scheduler.tick();
  g.setTime('2026-09-15T07:02:00Z');g.online();await g.scheduler.tick();assert.equal(g.tasks.get(skipped.id).lastRun.status,'skipped');
});
test('能力网关限制定时任务读写范围并在任务失效后拒绝调用',async t=>{
  const f=await fixture();const archive=new ArchiveService(f.store);await archive.initialize();
  const service=new ToolService({...f,archive});const gateway=new ToolGateway(service);await gateway.start();t.after(()=>gateway.close());
  let active=true;const grant=gateway.grant({scheduled:true,tools:['archive.search','archive.propose'],valid:()=>active});
  const call=async(method,params,token=grant.env.ALMOST_GENIUS_TOOL_TOKEN)=>fetch(grant.env.ALMOST_GENIUS_TOOL_URL,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({method,params})});
  assert.equal((await call('tools/list',{},'wrong')).status,403);
  const list=await (await call('tools/list',{})).json();assert.deepEqual(list.tools.map(t=>t.name),['archive_search','archive_propose']);
  const refused=await (await call('tools/call',{name:'tasks_create',arguments:{task:input()}})).json();assert.equal(refused.isError,true);
  active=false;assert.equal((await(await call('tools/call',{name:'archive_search',arguments:{query:'学习'}})).json()).isError,true);
  grant.revoke();assert.equal((await call('tools/list',{})).status,403);
});
test('新档案、任务与聊天可加密备份，未知工具和损坏档案拒绝导入',async()=>{
  const f=await fixture();const archive=new ArchiveService(f.store);await archive.initialize('个人背景');await archive.propose({type:'skill',title:'学习中',content:'能力待核对'});
  await f.store.update(s=>{s.assistant={turns:[],jobs:{},outbox:{}};});
  const encrypted=await encryptBackup({format:1,state:f.store.snapshot()},'twelve-chars-password');const result=await decryptBackup(encrypted,'twelve-chars-password');assert.equal(result.state.archive.profile.content,'个人背景');
  result.state.tasks['daily-report'].tools=['shell.run'];await assert.rejects(()=>encryptBackup(result,'twelve-chars-password'),/任务/);
});
test('聊天消息持久化去重，中断重启不自动重做写操作',async()=>{
  const f=await fixture();const assistant=new AssistantService({...f,wecom:f.bot,gateway:{},archive:{}});await assistant.initialize();assistant.maintenance=()=>true;
  await assert.rejects(()=>assistant.enqueue('你好'),/切换/);assistant.maintenance=()=>false;assistant.processing=true;
  await assistant.enqueue('你好','wecom','same');await assistant.enqueue('你好','wecom','same');assert.equal(assistant.status().turns.length,1);
  await f.store.update(s=>{s.assistant.jobs.same.status='running';});await assistant.initialize();assert.equal(assistant.status().jobs[0].status,'failed');
});
