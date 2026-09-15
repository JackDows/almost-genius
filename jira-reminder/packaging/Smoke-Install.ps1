$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$taskInstaller = Join-Path $taskRoot ('dist\JiraWorkReminder-'+$taskVersion+'-Setup-x64.exe')
$taskTarget = Join-Path $PSScriptRoot 'smoke-install'
$taskRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{EF02BFB3-FB9C-4148-95C5-CE72FDD35003}_is1'
if (Test-Path -LiteralPath $taskRegistry) { throw '当前用户已有安装记录，跳过隔离安装测试以免影响正式安装。' }
$taskData = Join-Path $taskRoot ('.local\install-smoke-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$env:JIRA_REMINDER_DATA = $taskData
$env:JIRA_REMINDER_PORT = '60501'
$taskServer = $null
try {
    foreach ($taskPass in @(1,2)) {
        $taskInstall = Start-Process -FilePath $taskInstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/TASKS=','/ISOLATED=1',('/DIR="'+$taskTarget+'"'),('/LOG="'+(Join-Path $taskData ('install-'+$taskPass+'.log'))+'"')) -WindowStyle Hidden -PassThru -Wait
        if ($taskInstall.ExitCode -ne 0) { throw '隔离安装失败。' }
        $taskNode = Join-Path $taskTarget 'runtime\node\node.exe'
        if ((& $taskNode --version) -ne 'v24.15.0') { throw '随包 Node 版本错误。' }
        if ((& (Join-Path $taskTarget 'runtime\codex\bin\codex.exe') --version) -notmatch '0.154.0') { throw '随包 Codex 不可用。' }
        $taskServer = Start-Process -FilePath $taskNode -ArgumentList 'src/server.mjs' -WorkingDirectory $taskTarget -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'stdout.log') -RedirectStandardError (Join-Path $taskData 'stderr.log')
        $taskHtml = $null
        for ($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++) {
            try { $taskHtml = (Invoke-WebRequest 'http://127.0.0.1:60501/' -UseBasicParsing -TimeoutSec 2).Content; break } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $taskHtml -or $taskHtml -notmatch 'name="setup-token" content="([a-f0-9]{64})"') { throw '安装版后台没有启动。' }
        $taskHeaders = @{'x-setup-token'=$Matches[1]}
        $taskState = Invoke-RestMethod 'http://127.0.0.1:60501/api/status' -Headers $taskHeaders
        if ($taskState.hasCredentials -or $taskState.jira.configured) { throw '空白安装意外带入账号。' }
        if ($taskPass -eq 1) {
            Invoke-RestMethod 'http://127.0.0.1:60501/api/work/complete' -Method Post -ContentType 'application/json' -Body '{}' -Headers $taskHeaders | Out-Null
        } elseif (-not $taskState.work.today.completed) { throw '升级丢失完成状态。' }
        $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = '+$taskServer.Id)
        if ($taskProcess.ExecutablePath -ne $taskNode) { throw '测试进程路径不匹配。' }
        Stop-Process -Id $taskServer.Id -Force
        $taskServer = $null
    }
    Write-Output '验证通过：安装、随包运行环境、无备份首次使用、升级保留完成状态。'
} finally {
    if ($taskServer -and -not $taskServer.HasExited) {
        $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = '+$taskServer.Id) -ErrorAction SilentlyContinue
        if ($taskProcess.ExecutablePath -eq (Join-Path $taskTarget 'runtime\node\node.exe')) { Stop-Process -Id $taskServer.Id -Force }
    }
    $taskUninstaller = Join-Path $taskTarget 'unins000.exe'
    if (Test-Path -LiteralPath $taskUninstaller) {
        $taskRemove = Start-Process -FilePath $taskUninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -PassThru -Wait
        if ($taskRemove.ExitCode -ne 0) { throw '隔离安装的卸载失败。' }
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskData 'state.json'))) { throw '卸载误删了个人数据。' }
Write-Output '验证通过：卸载保留个人数据。测试日志仅含虚构记录，保存在 .local。'
