import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { beijing, dayRecord, addDays } from '../src/dates.mjs';
import { JiraClient, upcomingJql } from '../src/jira.mjs';
import { Scheduler, pendingItems } from '../src/scheduler.mjs';
import { WorkService } from '../src/work.mjs';

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
  const scheduler = new Scheduler({ store, jira, wecom, notify, online: async () => online, now });
  return { directory, store, scheduler, jira, wecom, local, pushed, notify, now, calls: () => calls,
    time: value => { instant = new Date(value); }, network: value => { online = connected = value; } };
}

test('北京时间跨日、跨年，JQL 覆盖明天后天且不包含今天和第四天', () => {
  assert.equal(beijing(new Date('2026-12-31T16:00:00Z')).date, '2027-01-01');
  assert.match(upcomingJql('2026-12-31'), /duedate >= "2027-01-01" AND duedate < "2027-01-03"/);
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('15 点发送一次，22 点未完成再次发送，两渠道均不重复', async t => {
  const f = await fixture(t, '2026-09-15T14:59:59+08:00');
  await f.scheduler.tick(); assert.equal(f.local.length, 0); assert.equal(f.calls(), 0);
  f.time('2026-09-15T15:00:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 1); assert.equal(f.pushed.length, 1); assert.equal(f.calls(), 1);
  assert.match(f.pushed[0], /https:\/\/jira.aonorx.com\/browse\/TEST-1/);
  f.time('2026-09-15T22:00:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 2); assert.equal(f.pushed.length, 2);
  assert.doesNotMatch(f.pushed[1], /TEST-1/);
});

test('22 点后首次开机合并两轮；次日不沿用完成记录', async t => {
  const f = await fixture(t, '2026-09-15T23:30:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.pushed.length, 1); assert.equal(f.local.length, 1);
  assert.ok(f.store.snapshot().days['2026-09-15'].sent['report22.wecom']);
  await f.store.update(state => { dayRecord(state, '2026-09-15').completed = true; });
  f.time('2026-09-16T15:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length, 2);
});

test('已完成后夜间静默，Jira 和周六核对仍执行，周日开机也提醒', async t => {
  const f = await fixture(t, '2026-09-19T15:00:00+08:00');
  await f.store.update(state => { dayRecord(state, '2026-09-19').completed = true; });
  await f.scheduler.tick();
  assert.match(f.pushed[0], /本周工作核对/); assert.match(f.pushed[0], /TEST-1/);
  assert.doesNotMatch(f.pushed[0], /已填好请回复/);
  f.time('2026-09-19T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length, 1);
  f.time('2026-09-20T15:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.pushed.length, 2);
});

test('离线仅本机提示；联网补发，离线 22 点仍复查且无重复', async t => {
  const f = await fixture(t); f.network(false);
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.local.length, 1); assert.match(f.local[0].text, /连接网络/); assert.equal(f.calls(), 0);
  f.time('2026-09-15T22:00:00+08:00'); await f.scheduler.tick(); assert.equal(f.local.length, 2);
  f.network(true); f.time('2026-09-15T22:01:00+08:00'); await f.scheduler.tick();
  assert.equal(f.pushed.length, 1); assert.equal(f.local.length, 3); assert.match(f.local[2].text, /TEST-1/);
  await f.scheduler.tick(); assert.equal(f.pushed.length, 1);
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
  assert.equal(f.local.length, count + 1); assert.equal(f.pushed.length, 1); assert.match(f.pushed[0], /TEST-1/);
  assert.equal(f.store.snapshot().days['2026-09-15'].jira.issues.length, 1);
});

test('跨午夜查询结束不把昨日提醒发到今天', async t => {
  const f = await fixture(t, '2026-09-15T23:59:59+08:00');
  f.jira.upcoming = async () => { f.time('2026-09-16T00:00:02+08:00'); return []; };
  await f.scheduler.tick(); assert.equal(f.pushed.length, 0); assert.equal(f.local.length, 0);
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
  assert.deepEqual(issues.map(issue => issue.key), ['T-1']); assert.equal(requests, 2);
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
