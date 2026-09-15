param([string]$InstallRoot, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskAppName = 'aonor-jira-reminder'
$taskExisting = Get-ScheduledTask -TaskName 'Aonor-Jira-Reminder' -ErrorAction SilentlyContinue
$taskRoots = @($InstallRoot)
if ($taskExisting) {
    $taskArguments = [string]$taskExisting.Actions[0].Arguments
    if ($taskArguments -match '-File "([^\"]+Run-Background\.ps1)"') {
        $taskPrevious = Split-Path $Matches[1] -Parent
        $taskPackage = Join-Path $taskPrevious 'package.json'
        if ((Test-Path -LiteralPath $taskPackage) -and (Get-Content -LiteralPath $taskPackage -Raw | ConvertFrom-Json).name -eq $taskAppName) {
            if (-not $Uninstall -or [IO.Path]::GetFullPath($taskPrevious) -eq [IO.Path]::GetFullPath($InstallRoot)) {
                $taskRoots += $taskPrevious
                Stop-ScheduledTask -TaskName 'Aonor-Jira-Reminder'
                Unregister-ScheduledTask -TaskName 'Aonor-Jira-Reminder' -Confirm:$false
            }
        } else { throw '已有同名启动任务不属于此应用，请先处理该任务。' }
    } else { throw '已有同名启动任务无法识别，请先处理该任务。' }
}
foreach ($taskRoot in ($taskRoots | Select-Object -Unique)) {
    if (-not $taskRoot -or -not (Test-Path -LiteralPath (Join-Path $taskRoot 'package.json'))) { continue }
    if ((Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).name -ne $taskAppName) { throw '目标目录属于其他程序。' }
    $taskResolved = (Resolve-Path -LiteralPath $taskRoot).Path.TrimEnd('\')
    # 只终止已核对路径的本应用进程，不按通用的 node/powershell 名称终止。
    Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -eq (Join-Path $taskResolved 'desktop\bin\JiraReminder.exe')) -or
        ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains('"'+(Join-Path $taskResolved 'Run-Background.ps1')+'"'))
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $taskRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $taskRun = (Get-ItemProperty -LiteralPath $taskRunKey -ErrorAction SilentlyContinue).'Aonor-Jira-Reminder'
    if ($taskRun -and $taskRun.Contains('"'+(Join-Path $taskResolved 'Run-Background.ps1')+'"')) { Remove-ItemProperty -LiteralPath $taskRunKey -Name 'Aonor-Jira-Reminder' }
    $taskData = if (Test-Path -LiteralPath (Join-Path $taskResolved 'installed.json')) { Join-Path $env:LOCALAPPDATA 'JiraWorkReminder' } else { Join-Path $taskResolved '.local' }
    $taskRuntimeFile = Join-Path $taskData 'runtime.json'
    if (Test-Path -LiteralPath $taskRuntimeFile) {
        $taskRuntime = Get-Content -LiteralPath $taskRuntimeFile -Raw | ConvertFrom-Json
        $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$taskRuntime.pid) -ErrorAction SilentlyContinue
        if ($taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine -match 'src[/\\]server\.mjs') {
            try {
                $taskHealth = Invoke-RestMethod 'http://127.0.0.1:60500/health' -TimeoutSec 3
                if ($taskHealth.app -eq 'aonor-jira-reminder-setup' -and $taskHealth.instance -eq $taskRuntime.instance -and $taskHealth.pid -eq $taskProcess.ProcessId) { Stop-Process -Id $taskProcess.ProcessId -Force }
            } catch {}
        }
    }
    # 同一电脑从开发版升级时沿用当前用户的加密数据；不覆盖安装版已有数据。
    $taskDestination = Join-Path $env:LOCALAPPDATA 'JiraWorkReminder'
    if (-not $Uninstall -and $taskData -ne $taskDestination -and -not (Test-Path -LiteralPath $taskDestination)) {
        $taskSource = $taskData
        $taskPointer = Join-Path $taskData 'active-data.json'
        if (Test-Path -LiteralPath $taskPointer) {
            $taskGeneration = (Get-Content -LiteralPath $taskPointer -Raw | ConvertFrom-Json).generation
            if ($taskGeneration -notmatch '^[a-f0-9-]{36}$') { throw '旧数据目录无效。' }
            $taskSource = Join-Path $taskData ('data\'+$taskGeneration)
        }
        New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
        foreach ($taskName in @('state.json','wecom.dpapi','jira.dpapi')) {
            $taskFile = Join-Path $taskSource $taskName
            if (Test-Path -LiteralPath $taskFile) { Copy-Item -LiteralPath $taskFile -Destination (Join-Path $taskDestination $taskName) }
        }
    }
}
