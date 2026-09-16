import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAuth, CodexRuntime, CodexWriter } from '../src/codex.mjs';

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
  const runtime = new CodexRuntime({ home: path.join(directory, 'app-codex'), environment, find: async () => 'fake-codex', spawnProcess(executable, args, options) {
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
  await auth.login(); await until(() => auth.status().state === 'logged_in');
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
  await auth.login(); const { child, args } = f.calls[0];
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
  await auth.login(); await until(() => auth.status().state === 'error');
  assert.match(auth.status().message, /地区.*403/);
  assert.equal(f.calls.length, 1); assert.equal(auth.child, null);
  assert.equal(auth.status().userCode, undefined);
});

test('未开启设备码登录和网络失败显示不同原因，不回显令牌或原始输出', async t => {
  for (const [output, expected] of [['Device code authentication is not enabled', /设置 → 安全/], ['error sending request: synthetic-private-token', /网络/]]) {
    const f = await fixture(t, child => { child.stderr.write(output); child.emit('close', 1); });
    const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
    await auth.login(); await until(() => auth.status().state === 'error');
    assert.match(auth.status().message, expected);
    assert.ok(!JSON.stringify(auth.status()).includes('synthetic-private-token'));
  }
});

test('登录超时主动结束等待，清除旧验证码，只终止本应用发起的进程', async t => {
  const f = await fixture(t, child => child.stdout.write('https://auth.openai.com/codex/device\nABCD-EFGHI\n'));
  const auth = new CodexAuth({ runtime: f.runtime, loginTimeoutMs: 30 }); t.after(() => auth.cancel());
  await auth.login(); await until(() => auth.status().state === 'error');
  assert.match(auth.status().message, /超时/);
  assert.equal(auth.status().userCode, undefined); assert.equal(f.calls[0].child.kills, 1);
});

test('取消后旧登录退出或输出不会覆盖新一轮状态；重复点击不创建并行登录', async t => {
  const f = await fixture(t);
  const auth = new CodexAuth({ runtime: f.runtime }); t.after(() => auth.cancel());
  await Promise.all([auth.login(), auth.login()]);
  assert.equal(f.calls.length, 1);
  const old = f.calls[0].child;
  auth.cancel(); await auth.login();
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
  await auth.login(); await check;
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
  const pending = auth.login(); auth.cancel();
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
