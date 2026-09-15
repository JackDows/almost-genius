import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { beijing, dayRecord, addDays } from '../src/dates.mjs';
import { JiraClient, upcomingJql } from '../src/jira.mjs';
import { TaskScheduler as Scheduler } from '../src/task-scheduler.mjs';
import { TaskService } from '../src/tasks.mjs';
import { WorkService } from '../src/work.mjs';
import { reminderCommand } from '../src/reminder-time.mjs';

async function fixture(t, time = '2026-09-15T15:00:00+08:00') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jira-reminder-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.initialize();
  await store.update(state => { state.enabled = true; });
  const local = [], pushed = [];
  let instant = new Date(time), connected = true, online = true, calls = 0;
  const wecom = { status: () => ({ connection: connected ? 'connected' : 'disconnected', paired: true }), async push(text) { pushed.push(text); } };
  const jira = { status: () => ({ configured: true, notice: '查询失败' }), async upcoming(date) { calls++; return [{ key: 'TEST-1', title: '测试任务', due: addDays(date, 1), url: 'https://jira.aonorx.com/browse/TEST-1' }]; } };
  const notify = async (title, text) => { local.push({ title, text }); };
  const now = () => instant;
  const tasks = new TaskService(store, now); await tasks.initialize();
  const scheduler = new Scheduler({ store, tasks, jira, wecom, notify, online: async () => online, now });
  return { directory, store, scheduler, jira, wecom, local, pushed, notify, now, writer:{notice:''}, calls: () => calls,
    time: value => { instant = new Date(value); }, network: value => { online = connected = value; } };
}

test('北京时间跨日、跨年，JQL 覆盖今天至后天且不包含第四天', () => {
  assert.equal(beijing(new Date('2026-12-31T16:00:00Z')).date, '2027-01-01');
  assert.match(upcomingJql('2026-12-31'), /duedate >= "2026-12-31" AND duedate < "2027-01-03"/);
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('15 点发送一次，22 点未完成再次发送，两渠道均不重复', async t => {
  const f = await fixture(t, '2026-09-15T14:59:59+08:00');
  await f.scheduler.tick(); assert.equal(f.local.length, 0); assert.equal(f.calls(), 0);
  f.time('2026-09-15T15:00:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 2); assert.equal(f.pushed.length, 2); assert.equal(f.calls(), 1);
  assert.doesNotMatch(f.pushed[0], /TEST-1/);
  assert.match(f.pushed[1], /https:\/\/jira.aonorx.com\/browse\/TEST-1/);
  f.time('2026-09-15T22:00:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 3); assert.equal(f.pushed.length, 3);
  assert.doesNotMatch(f.pushed[2], /TEST-1/);
});

test('22 点后首次开机合并两轮；次日不沿用完成记录', async t => {
  const f = await fixture(t, '2026-09-15T23:30:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.pushed.length, 2); assert.equal(f.local.length, 2);
  assert.ok(f.store.snapshot().days['2026-09-15'].sent['report22.wecom']);
  await f.store.update(state => { dayRecord(state, '2026-09-15').completed = true; });
  f.time('2026-09-16T15:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length, 4);
});

test('已完成后夜间静默，Jira 和周六核对仍执行，周日开机也提醒', async t => {
  const f = await fixture(t, '2026-09-19T15:00:00+08:00');
  await f.store.update(state => { dayRecord(state, '2026-09-19').completed = true; });
  await f.scheduler.tick();
  assert.match(f.pushed[1], /本周工作核对/); assert.match(f.pushed[0], /TEST-1/);
  assert.doesNotMatch(f.pushed[0], /已填好请回复/);
  f.time('2026-09-19T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length, 2);
  f.time('2026-09-20T15:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length, 4);
});

test('离线仅本机提示；联网补发，离线 22 点仍复查且无重复', async t => {
  const f = await fixture(t); f.network(false);
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 2); assert.match(f.local[0].text, /连接网络/); assert.equal(f.calls(), 0);
  f.time('2026-09-15T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.local.length, 3);
  f.network(true); f.time('2026-09-15T22:01:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length, 2); assert.equal(f.local.length, 4); assert.match(f.local[3].text, /TEST-1/);
  await f.scheduler.tick(); assert.equal(f.pushed.length, 2);
});

test('Jira 查询失败不记为空结果，五分钟后补查；推送失败不重复本机提醒', async t => {
  const f = await fixture(t); const original = f.jira.upcoming;
  f.jira.upcoming = async () => { throw new Error('offline'); };
  f.wecom.push = async () => { throw new Error('not sent'); };
  await f.scheduler.tick();
  assert.equal(f.store.snapshot().days['2026-09-15'].jira, null);
  const count = f.local.length;
  f.jira.upcoming = original; f.wecom.push = async text => f.pushed.push(text);
  f.time('2026-09-15T15:05:01+08:00'); await f.scheduler.tick();
  assert.equal(f.local.length, count + 1); assert.equal(f.pushed.length, 2); assert.match(f.pushed[1], /TEST-1/);
  assert.equal(f.store.snapshot().days['2026-09-15'].jira.issues.length, 1);
});

test('跨午夜查询结束不把昨日提醒发到今天', async t => {
  const f = await fixture(t, '2026-09-15T23:59:59+08:00');
  const delivered = [];
  f.wecom.push = async text => delivered.push({ text, date: beijing(f.now()).date });
  f.jira.upcoming = async () => { f.time('2026-09-16T00:00:02+08:00'); return []; };
  await f.scheduler.tick(); assert.ok(delivered.every(item => item.date === '2026-09-15'));
  assert.ok(delivered.every(item => !item.text.startsWith('临期任务')));
});

test('本地完成标记与其他记录并发保存，重启后仍然有效', async t => {
  const f = await fixture(t);
  await Promise.all([
    f.store.update(state => { dayRecord(state, '2026-09-15').completed = true; }),
    f.store.update(state => { dayRecord(state, '2026-09-15').summary = '测试文字'; }),
  ]);
  const second = new StateStore(f.directory); await second.initialize();
  const day = second.snapshot().days['2026-09-15']; assert.equal(day.completed, true); assert.equal(day.summary, '测试文字');
});

test('生成描述不算已填报，明确回复才记录；重复消息不追加记录', async t => {
  const f = await fixture(t);
  const writer = { notice: '', async summarize() { return '完成设备联调'; } };
  const work = new WorkService({ ...f, writer });
  await work.handle('完成设备联调', 'message-1');
  while (work.processing) await new Promise(resolve => setTimeout(resolve, 5));
  await work.handle('完成设备联调', 'message-1');
  assert.equal(work.status().today.completed, false); assert.equal(work.status().today.summary, '完成设备联调');
  assert.equal(work.status().today.notes.length, 1);
  await work.handle('已填报', 'message-2'); assert.equal(work.status().today.completed, true);
  await work.handle('撤销完成', 'message-3'); assert.equal(work.status().today.completed, false);
});

test('Jira 分页、到期日期和已完成任务过滤，凭据不出现在状态', async () => {
  let requests = 0;
  const payloads = [
    { total: 3, issues: [{ key: 'T-1', fields: { summary: '明天', duedate: '2026-09-16' } }, { key: 'T-2', fields: { summary: '今天', duedate: '2026-09-15' } }] },
    { total: 3, issues: [{ key: 'T-3', fields: { summary: '已完成', duedate: '2026-09-17', status: { statusCategory: { key: 'done' } } } }] },
  ];
  const jira = new JiraClient({ read: async () => ({ username: 'u', password: 'synthetic-secret' }) }, async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.headers.Authorization.startsWith('Basic '));
    if (requests) assert.match(url, /startAt=2/);
    return new Response(JSON.stringify(payloads[requests++]), { headers: { 'content-type': 'application/json' } });
  });
  await jira.initialize(); const issues = await jira.upcoming('2026-09-15');
  assert.deepEqual(issues.map(issue => issue.key), ['T-1', 'T-2']); assert.equal(requests, 2);
  assert.equal(JSON.stringify(jira.status()).includes('synthetic-secret'), false);
});

test('Jira 认证失败不保存密码；登录 HTML 不当作查询成功', async () => {
  let writes = 0;
  const jira = new JiraClient({ write: async () => { writes++; } }, async () => new Response('secret', { status: 401 }));
  await assert.rejects(jira.configure({ username: 'user', password: 'synthetic-secret' }), /登录未通过/);
  assert.equal(writes, 0);
  jira.credentials = { username: 'user', password: 'synthetic-secret' };
  jira.fetcher = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(jira.upcoming('2026-09-15'), /登录页面/);
  assert.equal(jira.lastCheckAt, null);
});

test('临期列表按日期排序、连续编号，标注相对日期和完整到期时间并保留链接', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    dayRecord(state, '2026-09-15').jira = { scope: 'today+2', issues: [
      { key:'T-3', title:'后天任务', due:'2026-09-17', url:'https://jira.aonorx.com/browse/T-3' },
      { key:'T-1', title:'今日任务', due:'2026-09-15', url:'https://jira.aonorx.com/browse/T-1' },
      { key:'T-2', title:'明日任务', due:'2026-09-16', url:'https://jira.aonorx.com/browse/T-2' },
    ] };
  });
  f.jira.upcoming = async () => f.store.snapshot().days['2026-09-15'].jira.issues;
  await f.scheduler.tick();
  assert.equal(f.pushed.length, 2);
  assert.equal(f.pushed[1], '临期任务：\n1、[今日任务（T-1）](https://jira.aonorx.com/browse/T-1) 今天到期 到期时间2026.09.15\n2、[明日任务（T-2）](https://jira.aonorx.com/browse/T-2) 明日到期 到期时间2026.09.16\n3、[后天任务（T-3）](https://jira.aonorx.com/browse/T-3) 后天到期 到期时间2026.09.17');
});

test('分条发送时只重试未成功的那条，不重复已送达的日报', async t => {
  const f = await fixture(t); let fail = true;
  f.wecom.push = async text => { if (text.startsWith('临期任务') && fail) throw new Error('network'); f.pushed.push(text); };
  await f.scheduler.tick(); assert.equal(f.pushed.length, 1);
  fail = false; f.time('2026-09-15T15:01:01+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length, 2); assert.match(f.pushed[1], /^临期任务/);
});

test('机器人接受明确的中文和数字时间，模糊时间会询问，不把普通工作描述当作改期', () => {
  const now = new Date('2026-09-15T15:12:10+08:00');
  for (const text of ['今天晚上六点再提醒我', '18:00再提醒我', '日报提醒改到18:00']) assert.deepEqual(reminderCommand(text, now), {time:'18:00'});
  assert.deepEqual(reminderCommand('下午六点半提醒我', now), {time:'18:30'});
  assert.deepEqual(reminderCommand('半小时后提醒我', now), {time:'15:43'});
  assert.deepEqual(reminderCommand('二十分钟后再提醒我', now), {time:'15:33'});
  assert.deepEqual(reminderCommand('取消稍后提醒', now), {time:null});
  for (const text of ['六点再提醒我', '25:00提醒我', '18:70提醒我', '18:300提醒我', '上午18点提醒我', '晚上十二点提醒我', '明天18:00提醒我', '每天18:00提醒我']) assert.ok(reminderCommand(text,now).error);
  assert.equal(reminderCommand('今天完成设备提醒模块的联调', now), null);
  assert.ok(reminderCommand('半小时后提醒我',new Date('2026-09-15T23:50:00+08:00')).error);
});

test('改到18点后重启仍记得，准时分渠道提醒一次，22点未完成仍复查', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const work = new WorkService({...f, writer:{summarize:async()=>{throw new Error('不应调用模型');}}});
  assert.equal(await work.handle('今天晚上六点再提醒我','snooze-1'),'已安排今天18:00提醒填报。');
  const id = work.status().today.reminder.id;
  await work.handle('今天晚上六点再提醒我','snooze-1'); assert.equal(work.status().today.reminder.id,id);
  assert.equal(work.status().today.notes.length,0);
  assert.match(await work.handle('状态','snooze-status'),/今天18:00/);
  const reload = new StateStore(f.directory); await reload.initialize();
  const scheduler = new Scheduler({...f,store:reload,tasks:new TaskService(reload,f.now),online:async()=>true});
  f.time('2026-09-15T17:59:59+08:00'); await scheduler.tick(); assert.equal(f.pushed.length,2);
  f.time('2026-09-15T18:00:00+08:00'); await scheduler.tick(); await scheduler.tick();
  assert.equal(f.pushed.length,3); assert.equal(f.local.length,3); assert.match(f.pushed[2],/约定/);
  f.time('2026-09-15T22:00:00+08:00'); await scheduler.tick(); assert.equal(f.pushed.length,4);
});

test('15点前改期只推迟日报，临期与周六核对照常；再次改期替换旧时间', async t => {
  const f = await fixture(t,'2026-09-19T14:00:00+08:00'); const work=new WorkService({...f});
  await work.setReminder('18:00'); f.time('2026-09-19T15:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length,2); assert.match(f.pushed[0],/^临期任务/); assert.match(f.pushed[1],/^本周工作核对/);
  await work.setReminder('19:00'); f.time('2026-09-19T18:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,2);
  f.time('2026-09-19T19:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,3);
});

test('改期支持15点之前，Jira检查仍等到15点；拒绝过去时间、暂停和已完成状态', async t => {
  const f=await fixture(t,'2026-09-15T09:00:00+08:00'); const work=new WorkService({...f});
  await assert.rejects(work.setReminder('08:00'),/已过/);
  await work.setReminder('10:00'); f.time('2026-09-15T10:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length,1); assert.equal(f.calls(),0);
  await work.complete(); assert.equal(work.status().today.reminder,undefined);
  await assert.rejects(work.setReminder('18:00'),/已标记/);
  await work.complete(false); await work.enable(false); await assert.rejects(work.setReminder('18:00'),/已暂停/);
});

test('改到22点以后不提前催报，到期补发合并夜间复查；跨日不追昨天', async t => {
  const f=await fixture(t); const work=new WorkService({...f}); await f.scheduler.tick(); await work.setReminder('23:00');
  f.time('2026-09-15T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,2);
  f.time('2026-09-15T23:10:00+08:00'); await f.scheduler.tick(); await f.scheduler.tick(); assert.equal(f.pushed.length,3);
  await work.setReminder('23:30'); f.time('2026-09-16T00:01:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,3);
  f.time('2026-09-16T15:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,5);
});

test('离线约定提醒在本机执行，联网后补企业微信；提前完成取消两渠道待提醒', async t => {
  const f=await fixture(t); const work=new WorkService({...f}); await f.scheduler.tick(); await work.setReminder('18:00');
  f.network(false); f.time('2026-09-15T18:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.local.length,4); assert.equal(f.pushed.length,2);
  f.network(true); f.time('2026-09-15T19:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,3); assert.equal(f.local.length,4);
  await work.setReminder('20:00'); await work.complete(); f.time('2026-09-15T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length,3);
});
