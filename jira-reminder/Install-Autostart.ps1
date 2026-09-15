$ErrorActionPreference = 'Stop'
$taskName = 'Aonor-Jira-Reminder'
$taskScript = Join-Path $PSScriptRoot 'Run-Background.ps1'
$taskShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskScript + '"'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and ($taskExisting.Actions.Arguments -notcontains $taskArguments)) {
    throw '存在同名且路径不同的任务，未覆盖。'
}
$taskAction = New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $PSScriptRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
try {
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description '本机 Jira 工时、临期及周计划提醒；不唤醒电脑。' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output '已安装登录自动启动：Aonor-Jira-Reminder；不唤醒电脑。'
} catch {
    # 部分标准用户不能注册计划任务，改用当前用户启动项，无需管理员权限。
    $taskRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $taskCommand = '"'+$taskShell+'" '+$taskArguments
    New-Item -Path $taskRunKey -Force | Out-Null
    Set-ItemProperty -LiteralPath $taskRunKey -Name $taskName -Value $taskCommand
    Start-Process -FilePath $taskShell -ArgumentList $taskArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
    Write-Output '已设置当前 Windows 用户登录自动启动。'
}
