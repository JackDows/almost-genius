import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialStore, StateStore } from './store.mjs';
import { WecomSetup } from './wecom.mjs';
import { JiraClient, JiraError } from './jira.mjs';
import { WorkService, WorkError } from './work.mjs';
import { CodexWriter } from './codex.mjs';
import { Scheduler } from './scheduler.mjs';
import { notifyLocal, isOnline } from './notifications.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('需要 JSON 请求。');
  const data = await new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size <= 16384) parts.push(chunk); });
    req.on('end', () => size > 16384 ? reject(new Error('请求过长。')) : resolve(Buffer.concat(parts)));
    req.on('error', () => reject(new Error('请求中断。')));
  });
  let body;
  try { body = JSON.parse(data.toString('utf8')); }
  catch { throw new Error('请求格式无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效。');
  return body;
}

export function createSetupServer(setup, template, services = {}) {
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const instance = randomBytes(16).toString('hex');
  let mutationActive = false;
  const server = http.createServer(async (req, res) => {
    const authority = `127.0.0.1:${server.address().port}`;
    const origin = `http://${authority}`;
    // 固定本机 Host，并检查来源和会话令牌，阻止网页跨站提交密钥或发消息。
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin)) {
      return send(res, 403, { error: '仅允许当前本机配置页访问。' });
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { app: 'aonor-jira-reminder-setup', pid: process.pid, instance });
    }
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      return send(res, 200, template.replaceAll('__TOKEN__', token).replaceAll('__NONCE__', nonce), 'text/html; charset=utf-8');
    }
    const asset = services.assets?.[req.url];
    if (req.method === 'GET' && asset) return send(res, 200, asset.body, asset.type);
    if (!req.url?.startsWith('/api/')) return send(res, 404, { error: '页面不存在。' });
    const receivedToken = req.headers['x-setup-token'];
    if (typeof receivedToken !== 'string' || !/^[a-f0-9]{64}$/.test(receivedToken) ||
        !timingSafeEqual(Buffer.from(receivedToken), Buffer.from(token))) {
      return send(res, 403, { error: '配置页已过期，请刷新页面。' });
    }
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ...setup.status(), serverTime: new Date().toISOString(), remindersEnabled: services.work?.status().enabled || false, jira: services.jira?.status(), work: services.work?.status() });
    if (req.method !== 'POST' || !['/api/connect', '/api/test-push', '/api/jira/connect', '/api/jira/check', '/api/work/complete', '/api/work/reopen', '/api/work/record', '/api/work/retry', '/api/work/enable', '/api/work/test-local'].includes(req.url)) {
      return send(res, 404, { error: '操作不存在。' });
    }
    if (mutationActive) return send(res, 409, { error: '正在处理，请稍后。' });
    mutationActive = true;
    try {
      const body = await readJson(req);
      if (req.url.startsWith('/api/work/') && services.work) {
        const work = services.work;
        const operations = {
          '/api/work/complete': () => work.complete(),
          '/api/work/reopen': () => work.complete(false),
          '/api/work/record': () => work.record(body.text, body.kind),
          '/api/work/retry': () => work.retry(),
          '/api/work/enable': () => work.enable(body.enabled),
          '/api/work/test-local': async () => { await work.notify('Jira 本机通知测试', '本机提醒已提交。点击可查看今日完成记录。'); return '本机通知已提交，请确认 Windows 通知。'; },
        };
        return send(res, 200, { message: await operations[req.url]() });
      }
      if (req.url === '/api/jira/connect' && services.jira) {
        await services.jira.configure(body);
        return send(res, 200, { message: 'Jira 已连接，密码已在本机加密保存。' });
      }
      if (req.url === '/api/jira/check' && services.jira) {
        const issues = await services.jira.upcoming();
        return send(res, 200, { message: `检查完成：明天或后天到期的未完成任务共 ${issues.length} 条。`, issues });
      }
      if (req.url === '/api/connect') {
        await setup.configure(body);
        return send(res, 200, { message: '连接成功，配置已加密保存。' });
      }
      await setup.pushTest();
      return send(res, 200, { message: '测试提醒已提交，请在企业微信确认收到。' });
    } catch (error) {
      if (error instanceof JiraError || error instanceof WorkError) return send(res, 400, { error: error.message });
      if (req.url.startsWith('/api/work/')) return send(res, 400, { error: '本机操作未完成，请稍后重试。' });
      // 不将 SDK 异常中的请求、认证字段或帧内容回传给页面。
      return send(res, 400, { error: req.url === '/api/connect'
        ? '连接未成功，请检查 Bot ID、Secret、长连接设置及网络后重试。'
        : '推送未成功，请确认机器人已连接且账号已绑定。' });
    } finally { mutationActive = false; }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  return { server, instance };
}

async function main() {
  const local = path.join(root, '.local');
  const setup = new WecomSetup(new CredentialStore(local));
  const jira = new JiraClient(new CredentialStore(local, 'jira.dpapi'));
  await jira.initialize();
  const store = new StateStore(local);
  await store.initialize();
  const writer = new CodexWriter(path.join(local, 'codex'));
  const scheduler = new Scheduler({ store, jira, wecom: setup, notify: notifyLocal, online: isOnline });
  const work = new WorkService({ store, writer, wecom: setup, scheduler, notify: notifyLocal });
  setup.onText = (text, messageId) => work.handle(text, messageId);
  const template = await readFile(path.join(root, 'web', 'index.html'), 'utf8');
  const assets = {
    '/app.js': { body: await readFile(path.join(root, 'web', 'app.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    '/view-state.mjs': { body: await readFile(path.join(root, 'web', 'view-state.mjs'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    '/style.css': { body: await readFile(path.join(root, 'web', 'style.css'), 'utf8'), type: 'text/css; charset=utf-8' },
  };
  const { server, instance } = createSetupServer(setup, template, { jira, work, assets });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(60500, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, 'runtime.json'), JSON.stringify({ url, pid: process.pid, instance }), 'utf8');
  process.stdout.write(`配置入口：${url}\n`);
  await setup.initialize();
  const run = () => {
    void setup.recover();
    void scheduler.tick();
    void work.processJobs().catch(() => { scheduler.lastError = '本地工作记录处理失败，请检查磁盘空间。'; });
  };
  run();
  const interval = setInterval(run, 15000);
  const close = () => { clearInterval(interval); setup.close(); server.close(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('配置服务启动失败。\n'); process.exit(1); });
}
