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

test('品牌图标在 Windows 桌面使用的 .NET Framework 中能正确绘制全部托盘尺寸', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'almost-genius-icon-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const iconPath = path.join(fixture, 'AlmostGenius.ico');
  const script = `
$ErrorActionPreference = 'Stop'
& ${quote(path.join(root, 'desktop', 'Build-Icon.ps1'))} -OutputPath ${quote(iconPath)} | Out-Null
$results = foreach ($size in @(16,20,24,32,40,48,64,96,128)) {
  $icon = [Drawing.Icon]::new(${quote(iconPath)},$size,$size)
  $bitmap = [Drawing.Bitmap]::new($size,$size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.DrawIcon($icon,[Drawing.Rectangle]::new(0,0,$size,$size))
    $red = 0
    for ($y=0;$y -lt $size;$y++) {
      for ($x=0;$x -lt $size;$x++) {
        $pixel = $bitmap.GetPixel($x,$y)
        if ($pixel.A -gt 128 -and $pixel.R -gt 2*$pixel.G -and $pixel.R -gt 2*$pixel.B) { $red++ }
      }
    }
    [pscustomobject]@{size=$size;redFraction=$red/($size*$size);cornerAlpha=$bitmap.GetPixel(0,0).A}
  } finally { $graphics.Dispose(); $bitmap.Dispose(); $icon.Dispose() }
}
ConvertTo-Json -InputObject @($results)
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30000 });
  const results = JSON.parse(stdout);
  assert.equal(results.length, 9);
  for (const result of results) {
    assert.ok(result.redFraction > 0.45, `${result.size}px icon must retain its red background, not render corrupt pixels`);
    assert.equal(result.cornerAlpha, 0, `${result.size}px icon must retain transparent corners`);
  }
});

test('桌面保留 Markdown、JSON、加密备份扩展名；普通网页可打开，脚本和凭据链接拒绝', { skip: process.platform !== 'win32' }, async () => {
  const source = path.join(root, 'desktop', 'ContentPolicy.cs');
  const script = `Add-Type -Path ${quote(source)}; @{
    markdown=[DesktopContentPolicy]::ExportExtension('profile.md');
    json=[DesktopContentPolicy]::ExportExtension('profile.json');
    backup=[DesktopContentPolicy]::ExportExtension('profile.jwrbackup');
    program=[DesktopContentPolicy]::ExportExtension('profile.exe');
    website=[DesktopContentPolicy]::CanOpenLink('https://www.python.org/');
    script=[DesktopContentPolicy]::CanOpenLink('javascript:alert(1)');
    localFile=[DesktopContentPolicy]::CanOpenLink('file:///C:/test.txt');
    credential=[DesktopContentPolicy]::CanOpenLink('https://user:secret@example.com/');
  } | ConvertTo-Json`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:20000});
  assert.deepEqual(JSON.parse(stdout),{markdown:'.md',json:'.json',backup:'.jwrbackup',program:null,website:true,script:false,localFile:false,credential:false});
});

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
