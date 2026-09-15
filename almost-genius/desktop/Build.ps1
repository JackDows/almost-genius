$ErrorActionPreference = 'Stop'
$taskVersion = '1.0.4191.47'
$taskVendor = Join-Path $PSScriptRoot ('vendor\' + $taskVersion)
$taskOutput = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskCore = Join-Path $taskVendor 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$taskForms = Join-Path $taskVendor 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path -LiteralPath $taskCore)) { throw '缺少 Microsoft.Web.WebView2 SDK，请先下载固定版本的官方 NuGet 包。' }

# 桌面、窗口、安装包与网页共用用户提供的品牌图标。
& (Join-Path $PSScriptRoot 'Build-Icon.ps1')
$taskIconPath = Join-Path $taskOutput 'AlmostGenius.ico'

$taskCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskExecutable = Join-Path $taskOutput 'AlmostGenius.exe'
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$taskExecutable" "/win32icon:$taskIconPath" "/win32manifest:$PSScriptRoot\app.manifest" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/reference:$taskCore" "/reference:$taskForms" (Join-Path $PSScriptRoot 'App.cs') (Join-Path $PSScriptRoot 'ContentPolicy.cs')
if ($LASTEXITCODE -ne 0) { throw '桌面应用编译失败。' }
Copy-Item -LiteralPath $taskCore,$taskForms -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $taskVendor 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'AlmostGenius.exe.config') -Destination $taskOutput -Force
Write-Output $taskExecutable
