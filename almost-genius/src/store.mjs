import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 密钥仅通过标准输入传给 DPAPI，不进入命令行、日志或明文文件。
export function dpapi(input, mode) {
  if (process.platform !== 'win32') throw new Error('密钥存储需要 Windows。');
  if (!['Protect', 'Unprotect'].includes(mode)) throw new Error('存储操作无效。');
  const code = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
    `$result=[System.Security.Cryptography.ProtectedData]::${mode}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', code], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 Windows 密钥保护。')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !output.trim()) return reject(new Error('Windows 密钥保护失败，请在当前 Windows 用户下运行。'));
      resolve(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.end(input.toString('base64'));
  });
}

export class CredentialStore {
  constructor(directory, filename = 'wecom.dpapi') {
    this.directory = directory;
    this.filename = path.join(directory, filename);
  }

  async read() {
    let encrypted;
    try { encrypted = await readFile(this.filename); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return JSON.parse((await dpapi(encrypted, 'Unprotect')).toString('utf8'));
  }

  async write(value) {
    const encrypted = await dpapi(Buffer.from(JSON.stringify(value)), 'Protect');
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, encrypted, { flag: 'wx' });
    await rename(temporary, this.filename);
  }
}

// 所有修改串行、先写临时文件再替换，完成记录不会被并发提醒覆盖。
export class StateStore {
  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(directory, 'state.json');
    this.value = { version: 1, enabled: false, days: {}, messages: {} };
    this.queue = Promise.resolve();
  }

  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.filename, 'utf8'));
      if (saved.version !== 1 || typeof saved.days !== 'object' || !saved.days || Array.isArray(saved.days)) throw new Error('本地记录格式错误。');
      this.value = { ...saved, messages: saved.messages || {} };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  snapshot() { return structuredClone(this.value); }

  update(change) {
    const operation = this.queue.then(async () => {
      const next = this.snapshot();
      const result = change(next);
      await mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
      await rename(temporary, this.filename);
      this.value = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
