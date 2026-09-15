$ErrorActionPreference = 'Stop'
$taskName = 'Aonor-Jira-Reminder'
$taskScript = Join-Path $PSScriptRoot 'Run-Background.ps1'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting) {
    if (-not ($taskExisting.Actions.Arguments | Where-Object { $_.Contains('"' + $taskScript + '"') })) { throw '同名任务不属于当前程序，未修改。' }
    Stop-ScheduledTask -TaskName $taskName
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$taskRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$taskRun = (Get-ItemProperty -LiteralPath $taskRunKey -ErrorAction SilentlyContinue).$taskName
if ($taskRun -and $taskRun.Contains('"'+$taskScript+'"')) { Remove-ItemProperty -LiteralPath $taskRunKey -Name $taskName }
Write-Output '已移除登录自动启动。可从托盘退出并暂停提醒。'
