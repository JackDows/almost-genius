import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialStore, StateStore } from './store.mjs';
import { WecomSetup } from './wecom.mjs';
import { JiraClient, JiraError } from './jira.mjs';
import { WorkService, WorkError } from './work.mjs';
import { CodexWriter, CodexAuth } from './codex.mjs';
import { BackupService, BackupError, MAX_BACKUP, dataDirectory } from './backup.mjs';
import { localRoot } from './paths.mjs';
import { HistoryService } from './history.mjs';
import { TaskScheduler } from './task-scheduler.mjs';
import { TaskService, TaskError } from './tasks.mjs';
import { ArchiveService, ArchiveError } from './archive.mjs';
import { ToolService, ToolGateway } from './agent-tools.mjs';
import { AssistantService } from './assistant.mjs';
import { notifyLocal, isOnline } from './notifications.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function readJson(req, limit = 16384) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('需要 JSON 请求。');
  const data = await new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size <= limit) parts.push(chunk); });
    req.on('end', () => size > limit ? reject(new Error('请求过长。')) : resolve(Buffer.concat(parts)));
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
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ...setup.status(), version: '0.4.2', preview: true, tasks: services.tasks?.list(), assistantBusy: services.assistant?.processing, history: services.history?.status(), codex: services.auth?.status(), backupPending: services.backup?.pending, serverTime: new Date().toISOString(), remindersEnabled: services.work?.status().enabled || false, jira: services.jira?.status(), work: services.work?.status() });
    if (req.method === 'GET' && req.url === '/api/tasks' && services.tasks) return send(res, 200, { tasks: services.tasks.list(true) });
    if (req.method === 'GET' && req.url === '/api/archive' && services.archive) return send(res, 200, { entries: services.archive.list(true), profile: services.archive.profile() });
    if (req.method === 'GET' && req.url === '/api/archive/export' && services.archive) return send(res, 200, services.archive.export());
    if (req.method === 'GET' && req.url === '/api/chat' && services.assistant) return send(res, 200, services.assistant.status());
    if (req.method === 'GET' && req.url === '/api/history' && services.history) return send(res,200,{entries:services.history.list()});
    if (req.method !== 'POST' || !['/api/tasks/create', '/api/tasks/change', '/api/tasks/undo', '/api/archive/create', '/api/archive/change', '/api/archive/profile', '/api/archive/extract', '/api/chat/send', '/api/chat/retry', '/api/history/sync', '/api/codex/login', '/api/codex/check', '/api/codex/cancel', '/api/backup/export', '/api/backup/import', '/api/app/restart', '/api/app/stop', '/api/connect', '/api/test-push', '/api/jira/connect', '/api/jira/check', '/api/work/complete', '/api/work/reopen', '/api/work/record', '/api/work/reminder', '/api/work/retry', '/api/work/enable', '/api/work/test-local'].includes(req.url)) {
      return send(res, 404, { error: '操作不存在。' });
    }
    if (mutationActive) return send(res, 409, { error: '正在处理，请稍后。' });
    mutationActive = true;
    try {
      const body = await readJson(req, req.url === '/api/backup/import' ? MAX_BACKUP + 1000000 : /^\/api\/(tasks|archive|chat)\//.test(req.url) ? 96000 : 16384);
      if (services.backup?.pending && req.url !== '/api/app/restart') throw new BackupError('备份已就绪，后台正在重启，请稍候。');
      if (req.url === '/api/tasks/create') return send(res, 200, { task: await services.tasks.create(body.task), message: '任务已创建。' });
      if (req.url === '/api/tasks/change') return send(res, 200, { task: await services.tasks.change(body.id, body.revision, body.operation, body.patch), message: '任务已更新。' });
      if (req.url === '/api/tasks/undo') return send(res, 200, { task: await services.tasks.undo(), message: '已撤销最后一次任务修改。' });
      if (req.url === '/api/archive/create') return send(res, 200, { entry: await services.archive.propose(body.entry), message: '已保存，等待核对。' });
      if (req.url === '/api/archive/change') return send(res, 200, { entry: await services.archive.change(body.id, body.revision, body.operation, body.patch), message: '档案已更新。' });
      if (req.url === '/api/archive/profile') return send(res, 200, { profile: await services.archive.setProfile(body.content, body.revision), message: '个人背景已保存。' });
      if (req.url === '/api/archive/extract') return send(res, 200, await services.assistant.extractHistory());
      if (req.url === '/api/chat/send') return send(res, 200, await services.assistant.enqueue(body.text));
      if (req.url === '/api/chat/retry') return send(res, 200, { message: await services.assistant.retry(body.id) });
      if (req.url === '/api/history/sync' && services.history) return send(res,200,{message:services.history.start()});
      if (req.url.startsWith('/api/codex/') && services.auth) {
        const method = req.url.split('/').at(-1);
        const result = await services.auth[method]();
        return send(res, 200, { message: typeof result === 'string' ? result : result.message });
      }
      if (req.url === '/api/backup/export' && services.backup) return send(res, 200, { file: await services.backup.export(body.password) });
      if (req.url === '/api/backup/import' && services.backup) {
        if (services.work?.processing || services.work?.flushing || services.work?.scheduler.running || services.history?.busy || services.assistant?.writer.busy || services.assistant?.flushing) throw new BackupError('正在整理、同步或发送提醒，请等本轮完成后导入。');
        services.backup.importing = true;
        let message;
        try { message = await services.backup.import(body.file, body.password, body.confirmed); }
        finally { services.backup.importing = false; }
        res.once('finish', () => services.restart?.());
        return send(res, 200, { message });
      }
      if (req.url === '/api/app/restart') { res.once('finish', () => services.restart?.()); return send(res, 200, { message: '后台正在重新启动。' }); }
      if (req.url === '/api/app/stop' && services.stop) { await services.stop(); res.once('finish', () => services.restart?.()); return send(res, 200, { message: '应用后台已停止。' }); }
      if (req.url.startsWith('/api/work/') && services.work) {
        const work = services.work;
        const operations = {
          '/api/work/complete': () => work.complete(),
          '/api/work/reopen': () => work.complete(false),
          '/api/work/record': () => work.record(body.text, body.kind),
          '/api/work/reminder': () => work.setReminder(body.time),
          '/api/work/retry': () => work.retry(),
          '/api/work/enable': () => work.enable(body.enabled),
          '/api/work/test-local': async () => { await work.notify('Jira 本机通知测试', '本机提醒已提交。点击可查看今日完成记录。'); return '本机通知已提交，请确认 Windows 通知。'; },
        };
        return send(res, 200, { message: await operations[req.url]() });
      }
      if (req.url === '/api/jira/connect' && services.jira) {
        await services.jira.configure(body);
        services.history?.start();
        return send(res, 200, { message: 'Jira 已连接，密码已在本机加密保存。' });
      }
      if (req.url === '/api/jira/check' && services.jira) {
        const issues = await services.jira.upcoming();
        return send(res, 200, { message: `检查完成：临期任务共 ${issues.length} 条。`, issues });
      }
      if (req.url === '/api/connect') {
        await setup.configure(body);
        return send(res, 200, { message: '连接成功，配置已加密保存。' });
      }
      await setup.pushTest();
      return send(res, 200, { message: '测试提醒已提交，请在企业微信确认收到。' });
    } catch (error) {
      if (error instanceof JiraError || error instanceof WorkError || error instanceof BackupError || error instanceof TaskError || error instanceof ArchiveError) return send(res, 400, { error: error.message });
      if (req.url.startsWith('/api/backup/')) return send(res, 400, { error: '备份操作未完成，请检查文件大小、磁盘空间后重试。' });
      if (req.url.startsWith('/api/codex/')) return send(res, 400, { error: 'Codex 组件不可用，请重新安装修复。' });
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
  const local = localRoot;
  const data = await dataDirectory(local);
  const wecomStore = new CredentialStore(data), jiraStore = new CredentialStore(data, 'jira.dpapi');
  const setup = new WecomSetup(wecomStore);
  const jira = new JiraClient(jiraStore);
  await jira.initialize();
  const store = new StateStore(data);
  await store.initialize();
  const writer = new CodexWriter(path.join(local, 'codex'));
  const auth = new CodexAuth();
  const backup = new BackupService(local, store, wecomStore, jiraStore);
  const history = new HistoryService({store,jira});
  void auth.check();
  const tasks = new TaskService(store); await tasks.initialize();
  const archive = new ArchiveService(store); await archive.initialize(await readFile(path.join(root, 'templates', 'profile.md'), 'utf8'));
  const scheduler = new TaskScheduler({ store, tasks, jira, wecom: setup, notify: notifyLocal, online: isOnline });
  await scheduler.recover();
  const work = new WorkService({ store, writer, wecom: setup, scheduler, notify: notifyLocal });
  const toolService = new ToolService({ store, tasks, archive, jira, work });
  const gateway = new ToolGateway(toolService); await gateway.start();
  const assistant = new AssistantService({ store, writer, gateway, archive, wecom: setup }); await assistant.initialize();
  scheduler.assistant = assistant;
  toolService.maintenance = assistant.maintenance = work.maintenance = scheduler.maintenance = history.maintenance = () => backup.pending || backup.importing;
  setup.onText = async (text, messageId) => {
    if (['已填报', '撤销完成', '状态', '测试', '重试', '日报', '周报', '周计划'].includes(text) || /^(日报|周报|周计划|记录)[\s：:]+/.test(text)) return work.handle(text, messageId);
    if (text === '重试聊天') { const failed = assistant.status().jobs.filter(j => j.status === 'failed').at(-1); return failed ? assistant.retry(failed.id) : '没有失败的聊天消息。'; }
    await assistant.enqueue(text, 'wecom', messageId); return null;
  };
  const template = await readFile(path.join(root, 'web', 'index.html'), 'utf8');
  const assets = {
    '/app-icon.png': { body: await readFile(path.join(root, 'web', 'app-icon.png')), type: 'image/png' },
    '/genius.js': { body: await readFile(path.join(root, 'web', 'genius.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    '/app.js': { body: await readFile(path.join(root, 'web', 'app.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    '/view-state.mjs': { body: await readFile(path.join(root, 'web', 'view-state.mjs'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    '/style.css': { body: await readFile(path.join(root, 'web', 'style.css'), 'utf8'), type: 'text/css; charset=utf-8' },
  };
  let interval;
  const close = () => { clearInterval(interval); auth.cancel(); writer.stopping = true; writer.child?.kill(); gateway.close(); setup.close(); server.close(); setTimeout(() => process.exit(0), 1000).unref(); };
  const { server, instance } = createSetupServer(setup, template, { jira, work, assets, auth, backup, history, tasks, archive, assistant, restart: () => close(), stop: () => writeFile(path.join(local, 'stopped'), 'stopped') });
  const port = Number(process.env.JIRA_REMINDER_PORT || 60500);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机端口无效。');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, 'runtime.json'), JSON.stringify({ url, pid: process.pid, instance, root }), 'utf8');
  process.stdout.write(`配置入口：${url}\n`);
  await setup.initialize();
  const run = () => {
    if (backup.pending) return;
    history.auto();
    void assistant.process().catch(() => {});
    void assistant.flush().catch(() => {});
    void setup.recover();
    void scheduler.tick();
    void work.processJobs().catch(() => { scheduler.lastError = '本地工作记录处理失败，请检查磁盘空间。'; });
  };
  run();
  interval = setInterval(run, 15000);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('配置服务启动失败。\n'); process.exit(1); });
}
