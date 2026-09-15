$ErrorActionPreference = 'Stop'
$taskName = 'Aonor-Jira-Reminder'
$taskScript = Join-Path $PSScriptRoot 'Run-Background.ps1'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting) {
    if (-not ($taskExisting.Actions.Arguments | Where-Object { $_.Contains('"' + $taskScript + '"') })) { throw '同名任务不属于当前程序，未修改。' }
    Stop-ScheduledTask -TaskName $taskName
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Output '已移除登录自动启动。当前提醒开关可在本机网页暂停。'
