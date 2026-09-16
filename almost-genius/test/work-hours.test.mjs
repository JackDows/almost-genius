import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { calculateWorkHours, workHoursReference, clockOutInput, isClockOutMessage } from '../src/work-hours.mjs';
import { WorkService } from '../src/work.mjs';
import { AssistantService } from '../src/assistant.mjs';
import { ToolService } from '../src/agent-tools.mjs';
import { TaskService } from '../src/tasks.mjs';
import { TaskScheduler } from '../src/task-scheduler.mjs';
import { createSetupServer } from '../src/server.mjs';
import { validateBackup, encryptBackup, decryptBackup } from '../src/backup.mjs';

async function fixture(t, instant = '2026-09-16T22:00:00+08:00') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'genius-hours-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.initialize();
  let clock = new Date(instant);
  const now = () => clock;
  const wecom = { status: () => ({ connection: 'disconnected' }) };
  const writer = { busy: false, notice: '', agent: async () => { throw new Error('简单下班消息不应调用 AI'); }, summarize: async () => '完成设备联调。' };
  const work = new WorkService({ store, writer, now, wecom, scheduler: {}, notify: async () => {} });
  return { directory, store, work, writer, now, wecom, time: value => { clock = new Date(value); } };
}

test('周一至五按7小时起算，周六按5小时，22点均为11小时', () => {
  for (const date of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
    assert.equal(calculateWorkHours({ date, endTime: '18:00' }).totalMinutes, 420);
    const late = calculateWorkHours({ date, endTime: '22:00' });
    assert.equal(late.totalMinutes, 660); assert.equal(late.timeSpentSeconds, 39600);
    assert.equal(late.jiraDuration, '11h'); assert.equal(late.overtimeMinutes, 240);
  }
  assert.equal(calculateWorkHours({ date: '2026-09-19', endTime: '16:00' }).totalMinutes, 300);
  const saturday = calculateWorkHours({ date: '2026-09-19', endTime: '22:00' });
  assert.equal(saturday.totalMinutes, 660); assert.equal(saturday.overtimeMinutes, 360);
});

test('逐分钟计算且不舍入，周日按整个时段减休息', () => {
  const half = calculateWorkHours({ date: '2026-09-16', endTime: '18:30' });
  assert.equal(half.totalMinutes, 450); assert.equal(half.display, '7 小时 30 分钟'); assert.equal(half.jiraDuration, '7h 30m');
  assert.equal(calculateWorkHours({ date: '2026-09-16', endTime: '18:01' }).timeSpentSeconds, 25260);
  assert.equal(calculateWorkHours({ date: '2026-09-19', endTime: '16:17' }).jiraDuration, '5h 17m');
  const sunday = { date: '2026-09-20', startTime: '09:00', endTime: '21:00', breakMinutes: 60 };
  assert.equal(calculateWorkHours(sunday).jiraDuration, '11h');
  assert.equal(calculateWorkHours({ ...sunday, endTime: '21:17' }).jiraDuration, '11h 17m');
  assert.equal(calculateWorkHours({ ...sunday, breakMinutes: 0 }).totalMinutes, 720);
  assert.equal(calculateWorkHours({ ...sunday, breakMinutes: 720 }).totalMinutes, 0);
});

test('缺少周日信息、错误日期、时间和休息时长不凭空计算', () => {
  const sunday = { date: '2026-09-20', startTime: '09:00', endTime: '21:00', breakMinutes: 60 };
  for (const field of ['startTime', 'endTime', 'breakMinutes']) {
    const input = { ...sunday }; delete input[field]; assert.throws(() => calculateWorkHours(input));
  }
  for (const breakMinutes of [-1, 721, 0.5, '60', null]) assert.throws(() => calculateWorkHours({ ...sunday, breakMinutes }));
  for (const endTime of ['24:00', '22:60', '10点', '9:00', null, '08:00']) assert.throws(() => calculateWorkHours({ ...sunday, endTime }));
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', 'not-a-date']) assert.throws(() => calculateWorkHours({ ...sunday, date }));
  assert.equal(calculateWorkHours({ date: '2028-02-29', endTime: '18:00' }).totalMinutes, 420);
  assert.throws(() => calculateWorkHours({ ...sunday, mode: 'schedule' }), /周日/);
  assert.throws(() => calculateWorkHours({ date: '2026-09-16', endTime: '17:00' }), /提前下班/);
  assert.throws(() => calculateWorkHours({ date: '2026-09-16', endTime: '22:00', breakMinutes: 60 }), /基础工时/);
});

test('跨午夜仍用工作归属日的规则，并限制过长时段', () => {
  assert.equal(calculateWorkHours({ date: '2026-09-18', endTime: '01:15', nextDay: true }).jiraDuration, '14h 15m');
  assert.equal(calculateWorkHours({ date: '2026-09-19', endTime: '01:00', nextDay: true }).totalMinutes, 840);
  assert.equal(calculateWorkHours({ date: '2026-09-20', startTime: '09:00', endTime: '01:00', nextDay: true, breakMinutes: 60 }).jiraDuration, '15h');
  assert.throws(() => calculateWorkHours({ date: '2026-09-16', endTime: '10:00', nextDay: true }), /24 小时/);
  assert.throws(() => calculateWorkHours({ date: '2026-09-20', startTime: '09:00', endTime: '10:00', nextDay: true, breakMinutes: 0 }), /24 小时/);
  assert.deepEqual(clockOutInput(new Date('2027-01-01T00:30:00+08:00')), { date: '2026-12-31', endTime: '00:30', nextDay: true });
  assert.deepEqual(clockOutInput(new Date('2026-09-16T14:00:00Z')), { date: '2026-09-16', endTime: '22:00', nextDay: false });
});

test('工作台自动显示参考值，未下班时不创建实际记录', () => {
  const days = {};
  const early = workHoursReference(new Date('2026-09-16T15:00:00+08:00'), days);
  assert.equal(early.state, 'base'); assert.equal(early.totalMinutes, 420);
  const late = workHoursReference(new Date('2026-09-16T22:17:00+08:00'), days);
  assert.equal(late.state, 'estimate'); assert.equal(late.totalMinutes, 677); assert.match(late.label, /22:17/);
  assert.equal(workHoursReference(new Date('2026-09-19T15:00:00+08:00'), days).totalMinutes, 300);
  assert.equal(workHoursReference(new Date('2026-09-20T22:00:00+08:00'), days).state, 'needs_details');
  assert.deepEqual(days, {});
});

test('实际下班记录可修改且重启保留，不改日报草稿和完成标记', async t => {
  const f = await fixture(t); await f.work.complete();
  await f.store.update(s => { s.days['2026-09-16'].summary = '完成联调。'; });
  await f.work.clockOut();
  let hours = f.work.status().hours;
  assert.equal(hours.state, 'saved'); assert.equal(hours.totalMinutes, 660);
  f.time('2026-09-16T23:00:00+08:00'); assert.equal(f.work.status().hours.totalMinutes, 660);
  await f.work.saveHours({ endTime: '22:30' });
  const restored = new StateStore(f.directory); await restored.initialize();
  const day = restored.snapshot().days['2026-09-16'];
  assert.equal(day.workHours.totalMinutes, 690); assert.equal(day.summary, '完成联调。'); assert.equal(day.completed, true);
  f.time('2026-09-17T18:00:00+08:00'); await f.work.clockOut();
  assert.equal(f.store.snapshot().days['2026-09-16'].workHours.totalMinutes, 690);
  assert.equal(f.store.snapshot().days['2026-09-17'].completed, false);
  f.work.maintenance = () => true;
  await assert.rejects(() => f.work.saveHours({ endTime: '22:00' }), /备份/);
});

test('周日下班只询问必要信息，提前下班也不擅自记满基础工时', async t => {
  const f = await fixture(t, '2026-09-20T21:00:00+08:00');
  assert.match(await f.work.clockOut(), /几点上班、几点下班，休息/);
  assert.deepEqual(f.store.snapshot().days, {});
  f.time('2026-09-16T16:30:00+08:00');
  assert.match(await f.work.clockOut(), /提前下班/);
  assert.deepEqual(f.store.snapshot().days, {});
});

test('下班消息直接计算、去重并使用发送时间，队列延迟跨日不多算', async t => {
  const f = await fixture(t, '2026-09-16T22:17:59+08:00');
  const assistant = new AssistantService({ ...f, gateway: {}, archive: {} }); await assistant.initialize();
  f.writer.busy = true;
  await assistant.enqueue('我下班了！', 'local', 'clock-out'); await assistant.enqueue('我下班了！', 'local', 'clock-out');
  f.time('2026-09-17T10:00:00+08:00'); f.writer.busy = false; await assistant.process();
  assert.equal(f.store.snapshot().days['2026-09-16'].workHours.totalMinutes, 677);
  assert.equal(f.store.snapshot().days['2026-09-17'], undefined);
  assert.equal(assistant.status().turns.length, 2); assert.match(assistant.status().turns[1].text, /11h 17m/);
  for (const text of ['比如下班了', '明天下班了', '今天10点下班', '下班了吗？', '还没下班', '如果现在下班了']) assert.equal(isClockOutMessage(text), false);
  for (const text of ['下班了', '现在下班', '我今天已经下班了！']) assert.equal(isClockOutMessage(text), true);
});

test('工时工具示例默认只预览，明确保存才落盘，周日缺项和定时写入被拒绝', async t => {
  const f = await fixture(t); const service = new ToolService(f);
  assert.equal((await service.call('report_hours', { endTime: '22:00' }, {})).totalMinutes, 660);
  assert.deepEqual(f.store.snapshot().days, {});
  await service.call('report_hours', { endTime: '22:00', save: true }, {});
  assert.equal((await service.call('report_status', {}, {})).hours.state, 'saved');
  assert.equal(f.store.snapshot().days['2026-09-16'].completed, false);
  await assert.rejects(() => service.call('report_hours', { date: '2026-09-20', endTime: '21:00', save: true }, {}), /休息/);
  assert.equal(f.store.snapshot().days['2026-09-20'], undefined);
  await service.call('report_hours', { date: '2026-09-20', startTime: '09:00', endTime: '21:00', breakMinutes: 60, save: true }, {});
  assert.equal(f.store.snapshot().days['2026-09-20'].workHours.totalMinutes, 660);
  await assert.rejects(() => service.call('report_hours', { endTime: '22:00', save: 'true' }, {}), /保存选项/);
  await assert.rejects(() => service.call('report_hours', { endTime: '22:00', save: true }, { scheduled: true, tools: [], valid: () => true }), /权限/);
});

test('本机下班接口需要页面令牌，自动使用当前时间', async t => {
  const f = await fixture(t);
  const { server } = createSetupServer({ status: () => ({}) }, '<meta name="setup-token" content="__TOKEN__">', { work: f.work });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text(); const token = html.match(/content="([a-f0-9]+)"/)[1];
  const post = headers => fetch(origin + '/api/work/clock-out', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post({})).status, 403); assert.deepEqual(f.store.snapshot().days, {});
  const response = await post({ 'x-setup-token': token });
  assert.equal(response.status, 200); assert.match((await response.json()).message, /11h/);
  assert.equal(f.work.status().hours.totalMinutes, 660);
});

test('日报提醒和文字草稿附带工时，50字描述保持独立', async t => {
  const f = await fixture(t); await f.store.update(s => { s.enabled = true; });
  const tasks = new TaskService(f.store, f.now); await tasks.initialize();
  const notices = [];
  const scheduler = new TaskScheduler({ ...f, tasks, jira: { upcoming: async () => [] }, notify: async (title, text) => notices.push(text), online: async () => true });
  await f.work.saveHours({ endTime: '20:30' }); await scheduler.tick();
  assert.ok(notices.some(text => /已计算的日报工时.*9h 30m/.test(text)));
  f.writer.busy = true; await f.work.record('完成设备联调', 'daily', 'wecom'); f.writer.busy = false;
  await f.work.processJobs();
  const day = f.store.snapshot().days['2026-09-16'];
  assert.equal(day.summary, '完成设备联调。'); assert.match(day.outbox.daily.text, /9h 30m/); assert.equal(day.completed, false);
});

test('加密备份保留工时并拒绝损坏计算结果，旧备份保持兼容', async t => {
  const f = await fixture(t); const old = { format: 1, state: f.store.snapshot() };
  assert.doesNotThrow(() => validateBackup(old));
  await f.work.clockOut(); const value = { format: 1, state: f.store.snapshot() };
  const restored = await decryptBackup(await encryptBackup(value, 'twelve-chars-password'), 'twelve-chars-password');
  assert.deepEqual(restored.state.days['2026-09-16'].workHours, value.state.days['2026-09-16'].workHours);
  for (const [field, wrong] of [['totalMinutes', 999], ['timeSpentSeconds', 1], ['date', '2026-09-17'], ['updatedAt', 'invalid'], ['ruleVersion', 99]]) {
    const broken = structuredClone(restored); broken.state.days['2026-09-16'].workHours[field] = wrong;
    assert.throws(() => validateBackup(broken), /工时/);
  }
});
