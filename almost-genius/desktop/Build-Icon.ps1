param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskSource = Join-Path $PSScriptRoot '..\web\app-icon.png'
$taskOutput = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $PSScriptRoot 'bin\AlmostGenius.ico' }
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
            if ($taskSize -eq 256) {
                $taskBitmap.Save($taskBuffer,[Drawing.Imaging.ImageFormat]::Png)
                $taskFrames.Add($taskBuffer.ToArray())
            } else {
                # .NET Framework 的 DrawIcon 会误读小尺寸 PNG 图层；使用原生 DIB 图层。
                $taskMaskStride = [int]([Math]::Ceiling($taskSize / 32.0) * 4)
                $taskDib = [IO.BinaryWriter]::new($taskBuffer,[Text.Encoding]::UTF8,$true)
                try {
                    $taskDib.Write([uint32]40)
                    $taskDib.Write([int32]$taskSize)
                    $taskDib.Write([int32]($taskSize * 2))
                    $taskDib.Write([uint16]1)
                    $taskDib.Write([uint16]32)
                    $taskDib.Write([uint32]0)
                    $taskDib.Write([uint32](($taskSize * 4 + $taskMaskStride) * $taskSize))
                    foreach ($taskUnused in 1..4) { $taskDib.Write([uint32]0) }
                    $taskMasks = [Collections.Generic.List[byte[]]]::new()
                    $taskPixels = $taskBitmap.LockBits([Drawing.Rectangle]::new(0,0,$taskSize,$taskSize),[Drawing.Imaging.ImageLockMode]::ReadOnly,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
                    try {
                        # ICO 的颜色与透明掩码按从下到上的行顺序存储。
                        for ($taskRow = $taskSize - 1; $taskRow -ge 0; $taskRow--) {
                            $taskRowPixels = [byte[]]::new($taskSize * 4)
                            [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($taskPixels.Scan0,$taskRow * $taskPixels.Stride),$taskRowPixels,0,$taskRowPixels.Length)
                            $taskDib.Write($taskRowPixels)
                            $taskMask = [byte[]]::new($taskMaskStride)
                            for ($taskX = 0; $taskX -lt $taskSize; $taskX++) {
                                if ($taskRowPixels[$taskX * 4 + 3] -eq 0) {
                                    $taskMaskIndex = $taskX -shr 3
                                    $taskMask[$taskMaskIndex] = $taskMask[$taskMaskIndex] -bor (128 -shr ($taskX % 8))
                                }
                            }
                            $taskMasks.Add($taskMask)
                        }
                    } finally { $taskBitmap.UnlockBits($taskPixels) }
                    foreach ($taskMask in $taskMasks) { $taskDib.Write([byte[]]$taskMask) }
                    $taskDib.Flush()
                    $taskFrames.Add($taskBuffer.ToArray())
                } finally { $taskDib.Dispose() }
            }
        } finally {
            $taskBuffer.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose()
        }
    }
} finally { $taskImage.Dispose() }

# 16–128 像素使用兼容托盘的 DIB；256 像素使用供资源管理器显示的 PNG。
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
