$ErrorActionPreference = 'Stop'
$taskLocal = Join-Path $PSScriptRoot '.local'
$taskRuntimePath = Join-Path $taskLocal 'runtime.json'
if (Test-Path -LiteralPath $taskRuntimePath) {
    try {
        $taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
        $taskUrl = [Uri]$taskRuntime.url
        if ($taskUrl.Scheme -eq 'http' -and $taskUrl.Host -eq '127.0.0.1') {
            $taskHealth = Invoke-RestMethod -Uri ($taskRuntime.url + 'health') -TimeoutSec 2
            if ($taskHealth.app -eq 'aonor-jira-reminder-setup' -and $taskHealth.instance -eq $taskRuntime.instance) {
                Write-Output $taskRuntime.url
                return
            }
        }
    } catch {}
}
$taskNode = (Get-Command node.exe).Source
New-Item -ItemType Directory -Path $taskLocal -Force | Out-Null
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('src/server.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLocal 'stdout.log') -RedirectStandardError (Join-Path $taskLocal 'stderr.log')
for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
    Start-Sleep -Milliseconds 250
    if ($taskProcess.HasExited) { throw '本机配置服务未能启动。' }
    if (Test-Path -LiteralPath $taskRuntimePath) {
        $taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
        if ($taskRuntime.pid -eq $taskProcess.Id) {
            Write-Output $taskRuntime.url
            return
        }
    }
}
throw '本机配置服务启动超时。'
