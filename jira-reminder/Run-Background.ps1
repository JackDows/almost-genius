$ErrorActionPreference = 'Stop'
# 仅守护这个本机程序，暂停业务提醒请使用网页里的“暂停提醒”。
$taskDesktop = Join-Path $PSScriptRoot 'desktop\bin\JiraReminder.exe'
if (Test-Path -LiteralPath $taskDesktop) {
    try { Start-Process -FilePath $taskDesktop -ArgumentList '--background' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null } catch {}
}
while ($true) {
    try { & (Join-Path $PSScriptRoot 'Start.ps1') | Out-Null } catch {}
    Start-Sleep -Seconds 15
}
