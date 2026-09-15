param([string]$Compiler)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskVendor = Join-Path $PSScriptRoot 'vendor'
$taskStage = Join-Path $PSScriptRoot 'stage'
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
New-Item -ItemType Directory -Path $taskVendor -Force | Out-Null
function Get-VerifiedFile([string]$Url, [string]$Destination, [string]$Hash) {
    if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Hash) { return }
    $taskDownload = $Destination + '.download'
    Invoke-WebRequest -Uri $Url -OutFile $taskDownload -UseBasicParsing
    if ((Get-FileHash -LiteralPath $taskDownload -Algorithm SHA256).Hash -ne $Hash) { throw ('下载校验失败：'+$Url) }
    Move-Item -LiteralPath $taskDownload -Destination $Destination -Force
}
Get-VerifiedFile 'https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip' (Join-Path $taskVendor 'node.zip') 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
Get-VerifiedFile 'https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-package-x86_64-pc-windows-msvc.tar.gz' (Join-Path $taskVendor 'codex.tar.gz') '94cc5b3632769504c809f6c0364b693c0dfddc5c30c8361095d2263a07ac45a4'
$taskSdkZip = Join-Path $taskVendor 'webview-sdk.zip'
Get-VerifiedFile 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4191.47/microsoft.web.webview2.1.0.4191.47.nupkg' $taskSdkZip 'f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0'
Expand-Archive -LiteralPath $taskSdkZip -DestinationPath (Join-Path $taskRoot 'desktop\vendor\1.0.4191.47') -Force
$taskWebView = Join-Path $taskVendor 'WebView2Setup.exe'
if (-not (Test-Path -LiteralPath $taskWebView)) { Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $taskWebView -UseBasicParsing }
$taskSignature = Get-AuthenticodeSignature -LiteralPath $taskWebView
if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 安装程序签名无效。' }
if (-not $Compiler) {
    $Compiler = Join-Path $taskVendor 'inno\ISCC.exe'
    if (-not (Test-Path -LiteralPath $Compiler)) {
        $taskInno = Join-Path $taskVendor 'inno.exe'
        Get-VerifiedFile 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe' $taskInno '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'
        $taskProcess = Start-Process -FilePath $taskInno -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER','/NOICONS',('/DIR="'+(Join-Path $taskVendor 'inno')+'"')) -WindowStyle Hidden -Wait -PassThru
        if ($taskProcess.ExitCode -ne 0) { throw '安装包编译器安装失败。' }
    }
}
Push-Location $taskRoot
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '测试失败，停止构建。' }
    & (Join-Path $taskRoot 'desktop\Build.ps1')
    if (Test-Path -LiteralPath $taskStage) {
        $taskResolved = (Resolve-Path -LiteralPath $taskStage).Path
        if ($taskResolved -ne [IO.Path]::GetFullPath((Join-Path $taskRoot 'packaging\stage')) -or (Get-Item -LiteralPath $taskStage).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw '构建暂存目录不安全。' }
        Remove-Item -LiteralPath $taskResolved -Recurse -Force
    }
    New-Item -ItemType Directory -Path $taskStage,(Join-Path $taskStage 'runtime\node'),(Join-Path $taskStage 'runtime\codex'),(Join-Path $taskStage 'desktop'),(Join-Path $taskStage 'packaging'),(Join-Path $taskStage 'licenses') -Force | Out-Null
    # 明确列出发行内容，个人目录、日志、测试材料和备份永远不参与打包。
    foreach ($taskName in @('src','web','node_modules','templates')) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskName) -Destination $taskStage -Recurse }
    foreach ($taskName in @('package.json','package-lock.json','README.md','THIRD_PARTY.md','Paths.ps1','Start.ps1','Run-Background.ps1','Install-Autostart.ps1','Remove-Autostart.ps1')) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskName) -Destination $taskStage }
    Copy-Item -Path (Join-Path $taskRoot 'licenses\*.txt') -Destination (Join-Path $taskStage 'licenses')
    Copy-Item -LiteralPath (Join-Path $taskRoot 'desktop\bin') -Destination (Join-Path $taskStage 'desktop') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Prepare-Install.ps1') -Destination (Join-Path $taskStage 'packaging')
    Set-Content -LiteralPath (Join-Path $taskStage 'installed.json') -Value '{"installed":true}' -Encoding UTF8
    Expand-Archive -LiteralPath (Join-Path $taskVendor 'node.zip') -DestinationPath (Join-Path $taskVendor 'node') -Force
    $taskNodeRoot = Join-Path $taskVendor 'node\node-v24.15.0-win-x64'
    Copy-Item -LiteralPath (Join-Path $taskNodeRoot 'node.exe') -Destination (Join-Path $taskStage 'runtime\node')
    Copy-Item -LiteralPath (Join-Path $taskNodeRoot 'LICENSE') -Destination (Join-Path $taskStage 'licenses\Node-LICENSE.txt')
    & tar.exe -xzf (Join-Path $taskVendor 'codex.tar.gz') -C (Join-Path $taskStage 'runtime\codex')
    if ($LASTEXITCODE -ne 0) { throw 'Codex 解包失败。' }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'desktop\vendor\1.0.4191.47\LICENSE.txt') -Destination (Join-Path $taskStage 'licenses\WebView2-LICENSE.txt')
    Invoke-WebRequest 'https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/LICENSE' -OutFile (Join-Path $taskStage 'licenses\Codex-LICENSE.txt') -UseBasicParsing
    Invoke-WebRequest 'https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/NOTICE' -OutFile (Join-Path $taskStage 'licenses\Codex-NOTICE.txt') -UseBasicParsing
    & $Compiler ('/DAppVersion='+$taskVersion) (Join-Path $PSScriptRoot 'installer.iss')
    if ($LASTEXITCODE -ne 0) { throw '安装包构建失败。' }
    $taskArtifact = Join-Path $taskRoot ('dist\AlmostGenius-'+$taskVersion+'-Setup-x64.exe')
    $taskHash = (Get-FileHash -LiteralPath $taskArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $taskRoot 'dist\SHA256SUMS.txt') -Value ($taskHash+'  '+[IO.Path]::GetFileName($taskArtifact)) -Encoding ASCII
    Write-Output ('安装包：'+$taskArtifact)
} finally { Pop-Location }
