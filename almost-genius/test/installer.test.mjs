import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

test('只有计划任务、没有注册表启动项时，迁移和移除自动启动仍能完成', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'jwr-installer-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dev = path.join(fixture, 'dev');
  await mkdir(path.join(dev, '.local'), { recursive: true });
  await mkdir(path.join(fixture, 'empty-run-key'));
  await writeFile(path.join(dev, 'package.json'), JSON.stringify({ name: 'aonor-jira-reminder' }));
  const state = JSON.stringify({ enabled: true, days: { '2026-09-15': { completed: true } } });
  await writeFile(path.join(dev, '.local', 'state.json'), state);
  await writeFile(path.join(dev, '.local', 'wecom.dpapi'), 'synthetic-encrypted-data');
  // 用空目录的属性模拟缺失的注册表值；保留真实 Get-ItemPropertyValue 的缺项异常。
  // 启动任务和进程操作全部替换，测试不会更改电脑上的实际启动项。
  const harness = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${quote(path.join(fixture, 'appdata'))}
$taskDev = ${quote(dev)}
$taskEmptyKey = ${quote(path.join(fixture, 'empty-run-key'))}
function Get-ScheduledTask { [pscustomobject]@{Actions=@([pscustomobject]@{Arguments=('-File "'+(Join-Path $taskDev 'Run-Background.ps1')+'"')})} }
function Stop-ScheduledTask {}
function Unregister-ScheduledTask {}
function Get-CimInstance {}
function Get-ItemPropertyValue { param($LiteralPath,$Name,$ErrorAction) Microsoft.PowerShell.Management\\Get-ItemPropertyValue -LiteralPath $taskEmptyKey -Name $Name -ErrorAction $ErrorAction }
function Get-ItemProperty { param($LiteralPath,$ErrorAction) Microsoft.PowerShell.Management\\Get-ItemProperty -LiteralPath $taskEmptyKey -ErrorAction $ErrorAction }
function Remove-ItemProperty { throw '不应删除不存在的启动项' }
& ${quote(path.join(root, 'packaging', 'Prepare-Install.ps1'))} -InstallRoot ${quote(path.join(fixture, 'install'))}
function Get-ScheduledTask {}
& ${quote(path.join(root, 'Remove-Autostart.ps1'))}
`;
  const script = path.join(fixture, 'repro.ps1');
  await writeFile(script, '\ufeff' + harness, 'utf8');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 20000 });
  const migrated = path.join(fixture, 'appdata', 'JiraWorkReminder');
  assert.equal(await readFile(path.join(migrated, 'state.json'), 'utf8'), state);
  assert.equal(await readFile(path.join(migrated, 'wecom.dpapi'), 'utf8'), 'synthetic-encrypted-data');
  assert.equal(await readFile(path.join(dev, '.local', 'state.json'), 'utf8'), state);
});
