import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 安装版的数据不放进程序目录，升级和卸载均保留个人数据。
export const localRoot = process.env.JIRA_REMINDER_DATA
  ? path.resolve(process.env.JIRA_REMINDER_DATA)
  : existsSync(path.join(root, 'installed.json'))
    ? path.join(process.env.LOCALAPPDATA, 'JiraWorkReminder') : path.join(root, '.local');
