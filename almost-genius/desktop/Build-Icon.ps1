$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskSource = Join-Path $PSScriptRoot '..\web\app-icon.png'
$taskOutput = Join-Path $PSScriptRoot 'bin\AlmostGenius.ico'
$taskSizes = @(16,20,24,32,40,48,64,96,128,256)
$taskFrames = [Collections.Generic.List[byte[]]]::new()
$taskImage = [Drawing.Image]::FromFile($taskSource)
try {
    if ($taskImage.Width -ne $taskImage.Height) { throw '应用图标源图必须为正方形。' }
    foreach ($taskSize in $taskSizes) {
        $taskBitmap = [Drawing.Bitmap]::new($taskSize,$taskSize,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
        $taskBuffer = [IO.MemoryStream]::new()
        try {
            $taskGraphics.Clear([Drawing.Color]::Transparent)
            $taskGraphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $taskGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $taskGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $taskGraphics.DrawImage($taskImage,[Drawing.Rectangle]::new(0,0,$taskSize,$taskSize))
            $taskBitmap.Save($taskBuffer,[Drawing.Imaging.ImageFormat]::Png)
            $taskFrames.Add($taskBuffer.ToArray())
        } finally {
            $taskBuffer.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose()
        }
    }
} finally { $taskImage.Dispose() }

# Windows 10/11 支持 PNG 图层，保留透明度并适配桌面、托盘与高 DPI 显示。
New-Item -ItemType Directory -Path (Split-Path $taskOutput -Parent) -Force | Out-Null
$taskWriter = [IO.BinaryWriter]::new([IO.File]::Create($taskOutput))
try {
    $taskWriter.Write([uint16]0)
    $taskWriter.Write([uint16]1)
    $taskWriter.Write([uint16]$taskSizes.Count)
    $taskOffset = 6 + 16 * $taskSizes.Count
    for ($taskIndex = 0; $taskIndex -lt $taskSizes.Count; $taskIndex++) {
        $taskDimension = [byte]($taskSizes[$taskIndex] % 256)
        $taskWriter.Write($taskDimension)
        $taskWriter.Write($taskDimension)
        $taskWriter.Write([byte]0)
        $taskWriter.Write([byte]0)
        $taskWriter.Write([uint16]1)
        $taskWriter.Write([uint16]32)
        $taskWriter.Write([uint32]$taskFrames[$taskIndex].Length)
        $taskWriter.Write([uint32]$taskOffset)
        $taskOffset += $taskFrames[$taskIndex].Length
    }
    foreach ($taskFrame in $taskFrames) { $taskWriter.Write([byte[]]$taskFrame) }
} finally { $taskWriter.Dispose() }
Write-Output $taskOutput
