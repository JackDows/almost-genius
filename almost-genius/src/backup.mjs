import { randomBytes, randomUUID, scrypt as derive, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { CredentialStore } from './store.mjs';
import { validateCredentials } from './wecom.mjs';
import { beijing } from './dates.mjs';
import { validateTask } from './tasks.mjs';
import { validateEntry } from './archive.mjs';
import { validateWorkHours } from './work-hours.mjs';

const scrypt = promisify(derive);
const aad = Buffer.from('JiraWorkReminder.backup.v1');
export const MAX_BACKUP = 32 * 1024 * 1024;
export class BackupError extends Error {}
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const safeKeys = v => {
  if (v && typeof v === 'object') for (const key of Object.keys(v)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new BackupError('备份字段无效。');
    safeKeys(v[key]);
  }
};
function passwordCheck(password) {
  if (typeof password !== 'string' || [...password].length < 12 || password.length > 512) throw new BackupError('备份密码至少 12 个字符，最多 512 个字符。');
}
export function validateBackup(value) {
  safeKeys(value);
  if (!object(value) || value.format !== 1 || !object(value.state) || value.state.version !== 1 || !object(value.state.days)) throw new BackupError('备份版本或格式不受支持。');
  if (value.state.tasksSchema !== undefined) {
    const s = value.state;
    if (s.tasksSchema !== 1 || !object(s.tasks) || !object(s.taskRuns) || !Array.isArray(s.taskChanges)) throw new BackupError('任务备份格式无效。');
    for (const [id, task] of Object.entries(s.tasks)) {
      try { validateTask(task); } catch { throw new BackupError('任务内容无效。'); }
      if (task.id !== id || !Number.isInteger(task.revision) || task.revision < 1 || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt)) || task.pauseUntil && !Number.isFinite(Date.parse(task.pauseUntil))) throw new BackupError('任务版本或时间无效。');
    }
    for (const [id, run] of Object.entries(s.taskRuns)) if (!object(run) || run.id !== id || !s.tasks[run.taskId] || !object(run.channels) || typeof run.text !== 'string' || !Number.isFinite(Date.parse(run.at)) || !['pending','running','ready','done','skipped','cancelled','failed'].includes(run.status)) throw new BackupError('任务执行历史无效。');
    for (const change of s.taskChanges) if (!object(change) || !object(change.after) || !s.tasks[change.taskId] || !Number.isInteger(change.after.revision)) throw new BackupError('任务变更历史无效。');
  }
  if (value.state.archive !== undefined) {
    const archive = value.state.archive;
    if (!object(archive) || archive.version !== 1 || !object(archive.profile) || typeof archive.profile.content !== 'string' || archive.profile.content.length > 20000 || !Number.isInteger(archive.profile.revision) || !object(archive.items) || !Array.isArray(archive.changes)) throw new BackupError('个人档案格式无效。');
    for (const [id, item] of Object.entries(archive.items)) {
      try { validateEntry(item); } catch { throw new BackupError('个人档案内容无效。'); }
      if (item.id !== id || !['candidate','confirmed'].includes(item.status) || !Number.isInteger(item.revision) || !Number.isFinite(Date.parse(item.updatedAt)) || !Array.isArray(item.evidence) || item.evidence.some(e => !object(e) || typeof e.id !== 'string' || typeof e.text !== 'string' || typeof e.title !== 'string')) throw new BackupError('档案证据或状态无效。');
    }
  }
  if (value.state.assistant !== undefined) {
    const a = value.state.assistant;
    if (!object(a) || !Array.isArray(a.turns) || a.turns.some(t => !object(t) || !['user','assistant'].includes(t.role) || typeof t.text !== 'string') || !object(a.jobs) || !object(a.outbox)) throw new BackupError('助手对话格式无效。');
    for (const j of Object.values(a.jobs)) if (!object(j) || typeof j.id !== 'string' || typeof j.text !== 'string' || !['pending','running','done','failed'].includes(j.status)) throw new BackupError('助手任务格式无效。');
  }
  if (value.state.activities !== undefined) {
    if (!object(value.state.activities)) throw new BackupError('外部工作记录格式无效。');
    for (const [id,item] of Object.entries(value.state.activities)) {
      if (!object(item) || item.id!==id || typeof item.source!=='string' || typeof item.externalId!=='string' || typeof item.text!=='string' || typeof item.title!=='string' || !Number.isFinite(Date.parse(item.occurredAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) throw new BackupError('外部工作记录不完整。');
      try { const url=new URL(item.url); if (url.protocol!=='https:' || url.username || url.password) throw new Error(); } catch { throw new BackupError('外部记录链接无效。'); }
    }
  }
  if (value.state.sources !== undefined) {
    if (!object(value.state.sources)) throw new BackupError('来源状态格式无效。');
    for (const source of Object.values(value.state.sources)) if (!object(source) || (source.syncedAt && !Number.isFinite(Date.parse(source.syncedAt)))) throw new BackupError('来源同步时间无效。');
  }
  for (const [date, day] of Object.entries(value.state.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !object(day) || typeof day.completed !== 'boolean' || !Array.isArray(day.notes) || (day.sent !== undefined && !object(day.sent))) throw new BackupError('工作记录格式不完整。');
    if (day.workHours !== undefined) { try { validateWorkHours(day.workHours, date); } catch { throw new BackupError('日报工时记录无效。'); } }
    if (day.reminder && (!object(day.reminder) || !/^[a-f0-9-]{36}$/.test(day.reminder.id || '') || !Number.isFinite(Date.parse(day.reminder.at)) || beijing(new Date(day.reminder.at)).date !== date)) throw new BackupError('填报改期记录无效。');
    for (const key of ['summary','weekly','chat']) if (day[key] != null && typeof day[key] !== 'string') throw new BackupError('草稿格式无效。');
    if (day.notes.some(n => !object(n) || typeof n.text !== 'string' || n.text.length > 4000 || !['daily','weekly','chat'].includes(n.kind))) throw new BackupError('工作记录内容无效。');
    if (day.conversations && (!object(day.conversations) || Object.entries(day.conversations).some(([kind, turns]) => !['daily','weekly','chat'].includes(kind) || !Array.isArray(turns) || turns.some(t => !object(t) || !['user','assistant'].includes(t.role) || typeof t.text !== 'string')))) throw new BackupError('对话记录格式无效。');
  }
  if (value.wecom) {
    try { validateCredentials(value.wecom, value.wecom); } catch { throw new BackupError('机器人配置无效。'); }
    if (typeof value.wecom.userId !== 'string' || value.wecom.userId.length > 160) throw new BackupError('机器人绑定无效。');
  }
  if (value.jira && (!object(value.jira) || typeof value.jira.username !== 'string' || !value.jira.username || /[:\r\n]/.test(value.jira.username) || typeof value.jira.password !== 'string' || !value.jira.password)) throw new BackupError('Jira 配置无效。');
  return value;
}
export async function encryptBackup(value, password) {
  passwordCheck(password); validateBackup(value);
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > MAX_BACKUP / 1.4) throw new BackupError('备份超过 22 MB，请先归档部分记录。');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ format: 'JiraWorkReminder', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { key.fill(0); plain.fill(0); }
}
export async function decryptBackup(file, password) {
  passwordCheck(password);
  if (typeof file !== 'string' || Buffer.byteLength(file) > MAX_BACKUP) throw new BackupError('备份文件过大。');
  let key;
  try {
    const doc = JSON.parse(file);
    if (doc.format !== 'JiraWorkReminder' || doc.version !== 1) throw new Error();
    const salt = Buffer.from(doc.salt, 'base64'), iv = Buffer.from(doc.iv, 'base64'), tag = Buffer.from(doc.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error();
    key = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad); cipher.setAuthTag(tag);
    const plain = Buffer.concat([cipher.update(Buffer.from(doc.data, 'base64')), cipher.final()]);
    try { return validateBackup(JSON.parse(plain.toString('utf8'))); } finally { plain.fill(0); }
  } catch { throw new BackupError('备份密码错误、文件损坏或版本不受支持，现有数据未修改。'); }
  finally { key?.fill(0); }
}
async function pointer(local, name) {
  try {
    const item = JSON.parse(await readFile(path.join(local, name), 'utf8'));
    if (!/^[a-f0-9-]{36}$/.test(item.generation)) throw new Error('数据目录无效。');
    return item;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function dataDirectory(local) {
  const pending = await pointer(local, 'pending-data.json');
  if (pending) {
    // 文件全部写好后才切换目录；中断时重启仍然读到完整的新数据或旧数据。
    const next = path.join(local, 'data', pending.generation);
    const value = JSON.parse(await readFile(path.join(next, 'state.json'), 'utf8'));
    if (value.version !== 1) throw new Error('待导入数据不完整。');
    await rename(path.join(local, 'pending-data.json'), path.join(local, 'active-data.json'));
  }
  const active = await pointer(local, 'active-data.json');
  return active ? path.join(local, 'data', active.generation) : local;
}
export class BackupService {
  constructor(local, store, wecomStore, jiraStore) { Object.assign(this, { local, store, wecomStore, jiraStore }); this.pending = false; }
  async export(password) {
    await this.store.queue;
    return encryptBackup({ format: 1, createdAt: new Date().toISOString(), state: this.store.snapshot(), wecom: await this.wecomStore.read(), jira: await this.jiraStore.read() }, password);
  }
  async import(file, password, confirmed) {
    if (confirmed !== true) throw new BackupError('请先确认替换当前配置和记录。');
    if (this.pending) throw new BackupError('已有待导入备份，请先重启应用。');
    const value = await decryptBackup(file, password);
    const generation = randomUUID(), directory = path.join(this.local, 'data', generation);
    const state = structuredClone(value.state);
    state.enabled = false; state.messages = {}; delete state.mode;
    if (state.assistant) { state.assistant.jobs = {}; state.assistant.outbox = {}; }
    for (const run of Object.values(state.taskRuns || {})) if (!['done','skipped','cancelled'].includes(run.status)) { run.status = 'cancelled'; run.error = '恢复备份时已取消未完成的执行。'; }
    for (const day of Object.values(state.days)) { delete day.jobs; delete day.outbox; delete day.jira; delete day.reminder; }
    await mkdir(directory, { recursive: true });
    if (value.wecom) await new CredentialStore(directory).write(value.wecom);
    if (value.jira) await new CredentialStore(directory, 'jira.dpapi').write(value.jira);
    await writeFile(path.join(directory, 'state.json'), JSON.stringify(state), { flag: 'wx' });
    const temporary = path.join(this.local, `${generation}.tmp`);
    await writeFile(temporary, JSON.stringify({ generation }), { flag: 'wx' });
    await rename(temporary, path.join(this.local, 'pending-data.json'));
    this.pending = true;
    return '备份已验证。重启后台后生效；检查连接并恢复提醒即可。旧数据仍保留。';
  }
}
