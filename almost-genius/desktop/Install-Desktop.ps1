$ErrorActionPreference = 'Stop'
$taskExecutable = Join-Path $PSScriptRoot 'bin\AlmostGenius.exe'
$taskIcon = Join-Path $PSScriptRoot 'bin\AlmostGenius.ico'
if (-not (Test-Path -LiteralPath $taskExecutable)) { throw '请先编译桌面应用。' }
$taskShell = New-Object -ComObject WScript.Shell
foreach ($taskDirectory in @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs'))) {
    $taskShortcutPath = Join-Path $taskDirectory 'Almost Genius.lnk'
    $taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
    if ((Test-Path -LiteralPath $taskShortcutPath) -and $taskShortcut.TargetPath -ne $taskExecutable) { throw '存在同名且目标不同的快捷方式，未覆盖。' }
    $taskShortcut.TargetPath = $taskExecutable
    $taskShortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $taskShortcut.IconLocation = $taskIcon + ',0'
    $taskShortcut.Description = 'Jira 工时、临期任务与周计划提醒'
    $taskShortcut.Save()
}
Write-Output '已创建桌面及开始菜单快捷方式：Almost Genius。'
