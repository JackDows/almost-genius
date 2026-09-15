import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function notifyLocal(title, text, url = 'http://127.0.0.1:60500/') {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('本机通知地址无效。');
  const desktop = fileURLToPath(new URL('../desktop/bin/AlmostGenius.exe', import.meta.url));
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
    $payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json;
    $tray=New-Object System.Windows.Forms.NotifyIcon; $tray.Icon=[Drawing.SystemIcons]::Information;
    $tray.Text='Almost Genius'; $tray.Visible=$true;
    $openTarget=if($payload.desktop){$payload.desktop}else{$payload.url};
    $tray.add_BalloonTipClicked({Start-Process -FilePath $openTarget}); $tray.add_Click({Start-Process -FilePath $openTarget});
    $tray.ShowBalloonTip(15000,$payload.title,$payload.text,[Windows.Forms.ToolTipIcon]::Info);
    [Console]::Out.WriteLine('submitted');
    $until=[DateTime]::UtcNow.AddSeconds(30);
    while([DateTime]::UtcNow -lt $until){[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100};
    $tray.Visible=$false; $tray.Dispose();`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let submitted = false;
    const timer = setTimeout(() => { child.kill(); if (!submitted) reject(new Error('本机通知超时。')); }, 40000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('submitted')) { submitted = true; resolve(); } });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法显示 Windows 通知。')); });
    child.on('close', () => { clearTimeout(timer); if (!submitted) reject(new Error('Windows 通知未提交。')); });
    child.stdin.end(Buffer.from(JSON.stringify({ title: title.slice(0, 60), text: text.slice(0, 240), url, desktop: existsSync(desktop) ? desktop : null })).toString('base64'));
  });
}

export async function isOnline(fetcher = fetch) {
  // 收到任一服务的 HTTP 响应即可说明联网；Jira 登录失败由 JiraClient 单独处理。
  const results = await Promise.allSettled(['https://jira.aonorx.com/login.jsp', 'https://work.weixin.qq.com/'].map(async url => {
    const response = await fetcher(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return true;
  }));
  return results.some(result => result.status === 'fulfilled');
}
