import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WecomSetup, validateCredentials } from '../src/wecom.mjs';
import { createSetupServer } from '../src/server.mjs';
import { dpapi } from '../src/store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const secret = 'synthetic-test-secret-only';
const credentials = { botId: 'aibot_test', secret };

class FakeClient extends EventEmitter {
  replies = [];
  pushes = [];
  connect() { queueMicrotask(() => this.emit('authenticated')); }
  disconnect() { this.emit('disconnected'); }
  async replyStream(frame, id, text) { this.replies.push({ frame, text }); return { errcode: 0 }; }
  async sendMessage(userId, body) { this.pushes.push({ userId, body }); return { errcode: 0 }; }
}

function fixture(clientFactory = () => new FakeClient()) {
  const writes = [];
  const store = { async read() { return null; }, async write(value) { writes.push(structuredClone(value)); } };
  return { setup: new WecomSetup(store, clientFactory), writes, store };
}

function message(text, extras = {}) {
  return { headers: { req_id: 'request' }, body: {
    aibotid: credentials.botId, chattype: 'single', from: { userid: 'owner' },
    msgid: crypto.randomUUID(), text: { content: text }, ...extras,
  } };
}

test('更换机器人时不沿用旧密钥或旧收件人', () => {
  const old = { ...credentials, userId: 'owner' };
  assert.throws(() => validateCredentials({ botId: 'different' }, old));
  assert.deepEqual(validateCredentials({ botId: 'different', secret, userId: 'untrusted' }, old), {
    botId: 'different', secret, userId: '',
  });
  assert.deepEqual(validateCredentials({ botId: credentials.botId, secret: '' }, old), old);
});

test('只允许正确绑定码、单聊和匹配的机器人绑定账号', async () => {
  const { setup, writes } = fixture();
  await setup.configure(credentials);
  assert.equal(setup.status().connection, 'connected');
  assert.equal(JSON.stringify(setup.status()).includes(secret), false);
  assert.equal(writes.length, 1);
  const binding = `绑定 ${setup.status().pairCode}`;
  await setup.receive(setup.client, message('绑定 000000'));
  await setup.receive(setup.client, message(binding, { chattype: 'group' }));
  await setup.receive(setup.client, message(binding, { aibotid: 'another_bot' }));
  assert.equal(setup.status().paired, false);
  assert.equal(setup.client.replies.length, 0);
  await setup.receive(setup.client, message(binding));
  assert.equal(writes.at(-1).userId, 'owner');
  assert.equal(setup.status().pairCode, null);
  assert.equal(setup.status().paired, true);
  assert.equal(setup.client.replies.length, 1);
  setup.close();
});

test('绑定后的测试只处理本人；重复消息只回复一次', async () => {
  const { setup } = fixture();
  await setup.configure(credentials);
  await setup.receive(setup.client, message(`绑定 ${setup.status().pairCode}`));
  const frame = message('测试');
  setup.client.emit('message.text', frame);
  setup.client.emit('message.text', frame);
  setup.client.emit('message.text', message('测试', { from: { userid: 'someone_else' } }));
  await setup.messageQueue;
  assert.equal(setup.client.replies.length, 2);
  assert.match(setup.client.replies.at(-1).text, /收发正常/);
  await setup.pushTest();
  assert.equal(setup.client.pushes.length, 1);
  assert.equal(setup.client.pushes[0].userId, 'owner');
  assert.ok(setup.status().lastPushAt);
  setup.close();
});

test('未绑定账号时不允许主动发送', async () => {
  const { setup } = fixture();
  await setup.configure(credentials);
  await assert.rejects(setup.pushTest());
  assert.equal(setup.client.pushes.length, 0);
  setup.close();
});

test('身份认证失败不保存配置，也不泄露 SDK 原始错误', async () => {
  class Failing extends FakeClient {
    connect() { queueMicrotask(() => this.emit('error', new Error(secret))); }
  }
  const { setup, writes } = fixture(() => new Failing());
  await assert.rejects(setup.configure(credentials));
  assert.equal(writes.length, 0);
  assert.equal(setup.status().connection, 'error');
  assert.equal(JSON.stringify(setup.status()).includes(secret), false);
  setup.client.emit('authenticated');
  assert.equal(setup.status().connection, 'error');
  setup.close();
});

test('加密保存失败时不显示已连接', async () => {
  const { setup, store } = fixture();
  store.write = async () => { throw new Error('storage failure'); };
  await assert.rejects(setup.configure(credentials));
  assert.equal(setup.status().connection, 'error');
  assert.equal(setup.status().hasCredentials, false);
  setup.close();
});

test('本机配置接口防止跨站请求、非法 Host、伪造令牌和密钥回显', async t => {
  let configured = 0;
  const setup = {
    status: () => ({ connection: 'not_configured', hasCredentials: false }),
    configure: async () => { configured++; },
    pushTest: async () => {},
  };
  const template = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const { server } = createSetupServer(setup, template);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(origin);
  const html = await root.text();
  const token = html.match(/name="setup-token" content="([a-f0-9]+)"/)[1];
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(origin + '/api/status')).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(origin, { headers: { Host: 'untrusted.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  const headers = { 'Content-Type': 'application/json', 'x-setup-token': token, Origin: origin };
  assert.equal((await fetch(origin + '/api/connect', {
    method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify(credentials),
  })).status, 403);
  assert.equal(configured, 0);
  assert.equal((await fetch(origin + '/api/status', { headers: { 'x-setup-token': 'é'.repeat(64) } })).status, 403);
  assert.equal((await fetch(origin + '/api/connect', { method: 'POST', headers, body: 'invalid' })).status, 400);
  const response = await fetch(origin + '/api/connect', { method: 'POST', headers, body: JSON.stringify(credentials) });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(configured, 1);
  const status = await fetch(origin + '/api/status', { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.text()).includes(secret), false);
});

test('Windows DPAPI 可以往返保护中文及特殊字符，密文不包含原文', { skip: process.platform !== 'win32' }, async () => {
  const plain = Buffer.from(JSON.stringify({ secret: '仅测试：中文、引号"、$、反引号`、换行\n' }));
  const encrypted = await dpapi(plain, 'Protect');
  assert.equal(encrypted.includes(plain), false);
  assert.deepEqual(await dpapi(encrypted, 'Unprotect'), plain);
});

test('系统 Windows PowerShell 可解析全部中文启动脚本', { skip: process.platform !== 'win32' }, async () => {
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const directory = fileURLToPath(new URL('..', import.meta.url));
  const script = 'foreach($file in @("Paths.ps1","Start.ps1","Run-Background.ps1","Install-Autostart.ps1","Remove-Autostart.ps1","desktop/Build.ps1","desktop/Install-Desktop.ps1","packaging/Build-Release.ps1","packaging/Prepare-Install.ps1")) { $tokens=$null; $problems=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file),[ref]$tokens,[ref]$problems) | Out-Null; if($problems.Count -gt 0) { exit 1 } }';
  await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: directory, windowsHide: true, timeout: 15000 });
});

test('桌面资源可加载，4000 字中文记录可提交，超长请求仍受限', async t => {
  let recorded = '';
  const setup = { status: () => ({connection:'connected'}) };
  const work = { status: () => ({enabled:false}), record: async text => { recorded = text; return '已记录'; } };
  const template = await readFile(new URL('../web/index.html', import.meta.url),'utf8');
  const {server} = createSetupServer(setup,template,{work,assets:{'/app.js':{body:'export {};',type:'text/javascript; charset=utf-8'}}});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text();
  const token = html.match(/name="setup-token" content="([a-f0-9]+)"/)[1];
  assert.equal((await fetch(origin+'/app.js')).status,200);
  assert.equal((await fetch(origin+'/.local/state.json')).status,404);
  const headers = {'Content-Type':'application/json','x-setup-token':token};
  const text = '中'.repeat(4000);
  assert.equal((await fetch(origin+'/api/work/record',{method:'POST',headers,body:JSON.stringify({text,kind:'daily'})})).status,200);
  assert.equal(recorded,text);
  assert.equal((await fetch(origin+'/api/work/record',{method:'POST',headers,body:JSON.stringify({text:'中'.repeat(6000),kind:'daily'})})).status,400);
  assert.equal(recorded,text);
});
