import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CodexAuth, CodexRuntime, CodexWriter, checkLoginPort } from '../src/codex.mjs';

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new PassThrough(); this.kills = 0; }
  kill() { this.kills++; this.emit('close', null); return true; }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('状态没有按预期完成');
}
async function fixture(t, handle = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'almost-genius-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const environment = { PATH: process.env.PATH, CODEX_HOME: path.join(directory, 'desktop-codex'), CODEX_ACCESS_TOKEN: 'synthetic-desktop-token', OPENAI_API_KEY: 'synthetic-api-key', CODEX_API_KEY: 'synthetic-key', CODEX_THREAD_ID: 'desktop-thread', HTTPS_PROXY: 'http://127.0.0.1:12345' };
  await mkdir(environment.CODEX_HOME);
  await writeFile(path.join(environment.CODEX_HOME, 'auth.json'), 'desktop-auth-must-stay-unchanged');
  const runtime = new CodexRuntime({ home: path.join(directory, 'app-codex'), networkFile: path.join(directory, 'network.json'), environment, find: async () => 'fake-codex', spawnProcess(executable, args, options) {
    const child = new FakeChild(); calls.push({ executable, args, options, child });
    setImmediate(() => handle(child, args, options)); return child;
  } });
  return { directory, calls, runtime, environment };
}

test('独立登录、状态检查都只使用应用凭据目录，不继承桌面令牌或修改父进程环境', async t => {
  let loggedIn = false;
  const f = await fixture(t, (child, args, options) => {
    if (args.includes('--device-auth')) {
      loggedIn = true;
      void writeFile(path.join(options.env.CODEX_HOME, 'auth.json'), 'app-auth').then(() => child.emit('close', 0));
    } else { child.stderr.write(loggedIn ? 'Logged in using ChatGPT' : 'Not logged in'); child.emit('close', loggedIn ? 0 : 1); }
  });
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  assert.equal((await auth.check()).state, 'logged_out');
  await auth.login('device'); await until(() => auth.status().state === 'logged_in');
  assert.equal(f.calls.length, 3);
  for (const { args, options } of f.calls) {
    assert.equal(options.env.CODEX_HOME, f.runtime.home);
    assert.ok(args.includes('cli_auth_credentials_store="file"'));
    for (const key of ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_THREAD_ID']) assert.equal(options.env[key], undefined);
    assert.equal(options.env.HTTPS_PROXY, f.environment.HTTPS_PROXY);
  }
  assert.equal(await readFile(path.join(f.environment.CODEX_HOME, 'auth.json'), 'utf8'), 'desktop-auth-must-stay-unchanged');
  assert.equal(f.environment.CODEX_ACCESS_TOKEN, 'synthetic-desktop-token');
});

test('设备码分段输出能展示官方链接和验证码，不启动本机网页登录回调', async t => {
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  await auth.login('device'); const { child, args } = f.calls[0];
  assert.deepEqual(args.slice(2), ['login', '--device-auth']);
  child.stdout.write('\u001b[32mhttps://auth.openai.com/codex/dev');
  child.stdout.write('ice\u001b[0m\nEnter the code: ABCD-');
  child.stdout.write('EFGHI\n');
  assert.equal(auth.status().verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(auth.status().userCode, 'ABCD-EFGHI');
  assert.equal(auth.status().state, 'logging_in');
  child.stderr.write('authorization: Bearer synthetic-private-token');
  assert.ok(!JSON.stringify(auth.status()).includes('synthetic-private-token'));
});

test('403 地区错误会结束登录并保留可理解的原因，不用其他已登录状态掩盖失败', async t => {
  const f = await fixture(t, child => { child.stderr.write('Token exchange failed: 403 Forbidden: Country, region, or territory not supported'); child.emit('close', 1); });
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  await auth.login('device'); await until(() => auth.status().state === 'error');
  assert.match(auth.status().message, /地区.*403/);
  assert.equal(f.calls.length, 1); assert.equal(auth.child, null);
  assert.equal(auth.status().userCode, undefined);
});

test('未开启设备码登录和网络失败显示不同原因，不回显令牌或原始输出', async t => {
  for (const [output, expected] of [['Device code authentication is not enabled', /设置 → 安全/], ['error sending request: synthetic-private-token', /网络/]]) {
    const f = await fixture(t, child => { child.stderr.write(output); child.emit('close', 1); });
    const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
    await auth.login('device'); await until(() => auth.status().state === 'error');
    assert.match(auth.status().message, expected);
    assert.ok(!JSON.stringify(auth.status()).includes('synthetic-private-token'));
  }
});

test('登录超时主动结束等待，清除旧验证码，只终止本应用发起的进程', async t => {
  const f = await fixture(t, child => child.stdout.write('https://auth.openai.com/codex/device\nABCD-EFGHI\n'));
  const auth = new CodexAuth({ runtime: f.runtime, loginTimeoutMs: 30 }); t.after(() => auth.cancel());
  await auth.login('device'); await until(() => auth.status().state === 'error');
  assert.match(auth.status().message, /超时/);
  assert.equal(auth.status().userCode, undefined); assert.equal(f.calls[0].child.kills, 1);
});

test('取消后旧登录退出或输出不会覆盖新一轮状态；重复点击不创建并行登录', async t => {
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  await Promise.all([auth.login('device'), auth.login('device')]);
  assert.equal(f.calls.length, 1);
  const old = f.calls[0].child;
  auth.cancel(); await auth.login('device');
  old.stdout.write('https://auth.openai.com/codex/device\nOLD1-CODE1\n'); old.emit('close', 0);
  assert.equal(auth.status().state, 'logging_in'); assert.equal(auth.status().userCode, undefined);
  assert.equal(f.calls.length, 2);
  f.calls[1].child.stdout.write('https://auth.openai.com/codex/device\nNEW1-CODE2\n');
  assert.equal(auth.status().userCode, 'NEW1-CODE2');
});

test('登录发起时旧状态检查不会覆盖登录状态，检查进程会被正确回收', async t => {
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  const check = auth.check(); await until(() => f.calls.length === 1);
  await auth.login('device'); await check;
  f.calls[0].child.emit('close', 0);
  assert.equal(auth.status().state, 'logging_in'); assert.equal(f.calls[0].child.kills, 1);
  assert.equal(f.calls.length, 2);
});

test('状态检查超时或启动失败不会错误标成未登录', async t => {
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime, checkTimeoutMs: 20 }); t.after(() => auth.cancel());
  assert.equal((await auth.check()).state, 'error'); assert.match(auth.status().message, /超时/);
  const failed = new CodexAuth({ runtime: { start: async () => { throw new Error('synthetic-sensitive-path'); } } });
  assert.equal((await failed.check()).state, 'error'); assert.ok(!failed.status().message.includes('synthetic'));
});

test('准备启动时取消登录，迟到的子进程会被结束且不会恢复登录中状态', async () => {
  let start;
  const auth = new CodexAuth({ runtime: { start: () => new Promise(resolve => { start = resolve; }) } });
  const pending = auth.login('device'); auth.cancel();
  const child = new FakeChild(); start(child); await pending;
  assert.equal(child.kills, 1); assert.equal(auth.status().state, 'logged_out'); assert.equal(auth.operation, null);
});

test('聊天、任务和日报请求也使用独立登录目录，并保留本轮工具令牌', async t => {
  const f = await fixture(t, (child, args) => {
    if (!args.includes('exec')) return;
    child.stdin.resume();
    child.stdin.on('end', () => {
      const output = args[args.indexOf('-o') + 1];
      void writeFile(output, JSON.stringify({ text: '测试回答', notify: true })).then(() => child.emit('close', 0));
    });
  });
  const writer = new CodexWriter(path.join(f.directory, 'work'), { runtime: f.runtime });
  let revoked = false;
  const gateway = { grant: () => ({ env: { ALMOST_GENIUS_TOOL_TOKEN: 'synthetic-tool-token' }, revoke() { revoked = true; } }) };
  assert.deepEqual(await writer.agent('测试', gateway), { text: '测试回答', notify: true });
  assert.equal(await writer.summarize('daily', {}), '测试回答');
  assert.equal(revoked, true);
  assert.equal(f.calls[0].options.env.ALMOST_GENIUS_TOOL_TOKEN, 'synthetic-tool-token');
  for (const call of f.calls) {
    assert.equal(call.options.env.CODEX_HOME, f.runtime.home);
    assert.equal(call.options.env.CODEX_ACCESS_TOKEN, undefined);
    assert.ok(call.args.includes('cli_auth_credentials_store="file"'));
  }
});

test('保存的代理仅应用于独立 Codex 子进程，重启后仍生效且本机回调和工具不走代理', async t => {
  const f = await fixture(t);
  f.environment.https_proxy = 'http://old.example:3128';
  f.environment.NO_PROXY = 'internal.example';
  await f.runtime.configureNetwork(' http://127.0.0.1:10808/ ');
  const restored = new CodexRuntime({ networkFile: f.runtime.networkFile });
  await restored.initialize();
  assert.equal(restored.proxyUrl, 'http://127.0.0.1:10808');
  await f.runtime.start(['login']); await f.runtime.start(['exec']);
  for (const { options } of f.calls) {
    assert.equal(options.env.HTTPS_PROXY, restored.proxyUrl);
    assert.equal(options.env.HTTP_PROXY, restored.proxyUrl);
    assert.equal(options.env.ALL_PROXY, restored.proxyUrl);
    assert.equal(options.env.https_proxy, undefined);
    assert.equal(options.env.NO_PROXY, 'internal.example,localhost,127.0.0.1,[::1],::1');
    assert.equal(options.env.CODEX_HOME, f.runtime.home);
  }
  assert.equal(f.environment.https_proxy, 'http://old.example:3128');
  await f.runtime.configureNetwork(''); await f.runtime.start(['login']);
  assert.equal(f.calls[2].options.env.HTTPS_PROXY, f.environment.HTTPS_PROXY);
});

test('无代理配置时保留默认网络；非法或包含凭据的地址不会被保存', async t => {
  const f = await fixture(t); await f.runtime.initialize();
  assert.equal(f.runtime.proxyUrl, '');
  await f.runtime.configureNetwork('http://localhost:8080');
  for (const value of [null, {}, 'file:///tmp/a', 'ftp://localhost', 'http://user:secret@localhost:8080', 'http://localhost/path', 'http://localhost/?secret=1']) await assert.rejects(f.runtime.configureNetwork(value));
  assert.equal(f.runtime.proxyUrl, 'http://localhost:8080');
  assert.equal(JSON.parse(await readFile(f.runtime.networkFile, 'utf8')).proxyUrl, f.runtime.proxyUrl);
});

test('默认网页登录在端口检查后启动，完整官方地址输出后提供链接，取消清除链接', async t => {
  const f = await fixture(t); let checked = 0;
  const auth = new CodexAuth({ runtime: f.runtime, checkPort: async () => { checked++; assert.equal(f.calls.length, 0); } });
  t.after(() => auth.cancel());
  await auth.login(); assert.equal(checked, 1);
  assert.deepEqual(f.calls[0].args.slice(2), ['login']);
  f.calls[0].child.stderr.write('https://auth.openai.com/oauth/authorize?state=synthetic&code_challenge=split');
  assert.equal(auth.status().loginUrl, undefined);
  f.calls[0].child.stderr.write('-challenge\n');
  assert.match(auth.status().loginUrl, /split-challenge$/);
  assert.equal(auth.status().userCode, undefined);
  auth.cancel(); assert.equal(auth.status().loginUrl, undefined);
});

test('回调端口被占用时不启动 CLI、不访问或中断占用它的服务', async t => {
  let connections = 0;
  const occupied = net.createServer(socket => { connections++; socket.end(); });
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime, checkPort: () => checkLoginPort(occupied.address().port) });
  await auth.login();
  assert.equal(auth.status().state, 'error'); assert.match(auth.status().message, /1455/);
  assert.equal(f.calls.length, 0); assert.equal(connections, 0); assert.equal(occupied.listening, true);
  await auth.login('device'); assert.equal(f.calls.length, 1); auth.cancel();
});

test('等待回调端口检查时取消，不会在检查结束后启动登录', async () => {
  let release, starts = 0;
  const auth = new CodexAuth({ runtime: { start: async () => { starts++; } }, checkPort: () => new Promise(resolve => { release = resolve; }) });
  const pending = auth.login(); auth.cancel(); release(); await pending;
  assert.equal(starts, 0); assert.equal(auth.status().state, 'logged_out');
});

test('网页登录进程退出后即核对凭据，不等待浏览器继承的管道关闭', async t => {
  const f = await fixture(t, (child, args) => {
    if (args.includes('status')) { child.stderr.write('Logged in using ChatGPT'); child.emit('close', 0); }
  });
  const auth = new CodexAuth({ runtime: f.runtime, checkPort: async () => {}, loginTimeoutMs: 100 });
  t.after(() => auth.cancel());
  await auth.login();
  const loginChild = f.calls[0].child;
  loginChild.emit('exit', 0);
  await until(() => auth.status().state === 'logged_in');
  assert.equal(loginChild.stdout.destroyed, false);
  assert.equal(loginChild.stderr.destroyed, false);
  assert.equal(f.calls.length, 2);
  loginChild.stderr.write('late browser output'); loginChild.emit('close', 0);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(auth.status().state, 'logged_in'); assert.equal(f.calls.length, 2);
});
