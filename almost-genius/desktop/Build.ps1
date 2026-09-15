$ErrorActionPreference = 'Stop'
$taskVersion = '1.0.4191.47'
$taskVendor = Join-Path $PSScriptRoot ('vendor\' + $taskVersion)
$taskOutput = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskCore = Join-Path $taskVendor 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$taskForms = Join-Path $taskVendor 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path -LiteralPath $taskCore)) { throw '缺少 Microsoft.Web.WebView2 SDK，请先下载固定版本的官方 NuGet 包。' }

# 图标使用程序绘制的圆形勾选标记，桌面与托盘保持一致。
Add-Type -AssemblyName System.Drawing
$taskBitmap = [Drawing.Bitmap]::new(64,64)
$taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskGraphics.Clear([Drawing.Color]::Transparent)
$taskBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(39,112,86))
$taskGraphics.FillEllipse($taskBrush,2,2,60,60)
$taskPen = [Drawing.Pen]::new([Drawing.Color]::White,6)
$taskPen.StartCap = $taskPen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$taskGraphics.DrawLines($taskPen,[Drawing.Point[]]@([Drawing.Point]::new(17,33),[Drawing.Point]::new(28,43),[Drawing.Point]::new(47,22)))
$taskIcon = [Drawing.Icon]::FromHandle($taskBitmap.GetHicon())
$taskIconPath = Join-Path $taskOutput 'AlmostGenius.ico'
$taskStream = [IO.File]::Create($taskIconPath)
$taskIcon.Save($taskStream)
$taskStream.Dispose(); $taskIcon.Dispose(); $taskPen.Dispose(); $taskBrush.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose()

$taskCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskExecutable = Join-Path $taskOutput 'AlmostGenius.exe'
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$taskExecutable" "/win32icon:$taskIconPath" "/win32manifest:$PSScriptRoot\app.manifest" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/reference:$taskCore" "/reference:$taskForms" (Join-Path $PSScriptRoot 'App.cs')
if ($LASTEXITCODE -ne 0) { throw '桌面应用编译失败。' }
Copy-Item -LiteralPath $taskCore,$taskForms -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $taskVendor 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'AlmostGenius.exe.config') -Destination $taskOutput -Force
Write-Output $taskExecutable
