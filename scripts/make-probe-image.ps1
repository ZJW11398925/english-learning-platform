# scripts/make-probe-image.ps1
#
# 造一张用于**实弹探针**的 JPEG：白色马克杯放在木桌上（合成图，512×512）。
#
# 为什么用 System.Drawing（Windows 自带）而不是自己写编码器：
# 我先手写了一个基线 JPEG 编码器（约 300 行），并配了一个"独立解码器"当护栏。
# 结果**编码器和解码器同时有缺陷**（量化表索引、位序、以自身验证自身），产出的"看起来
# 正常"的 JPEG 实际是彩色雪花——期间还白跑了一次真实 API 调用（探针里候选为 0 条）。
# 教训：不要用一次性自写图像编码器当"能识别"的前提，用系统里已有的、被无数工具验过的编码器。
# 详细复盘见 `.superpowers/sdd/task-7-report.md` §"我不该自己写 JPEG 编码器"。
#
# 用法：powershell -File scripts/make-probe-image.ps1 [-Out tmp/probe-mug.jpg] [-Size 512]

param(
  [string]$Out = "tmp/probe-mug.jpg",
  [int]$Size = 512
)

Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$bmp = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$s = [double]$Size
$cx = $s * 0.50           # 杯子中心 x
$top = $s * 0.26          # 杯口 y
$bottom = $s * 0.82       # 杯底 y
$halfW = $s * 0.165       # 杯身半宽
$wallBottom = [int]($s * 0.22)

# ── 背景：上半浅灰墙，下半木桌（木纹用几条半透明横线示意）──────────────────────
$wall = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238, 238, 235))
$g.FillRectangle($wall, 0, 0, $Size, $wallBottom)

$tableRect = New-Object System.Drawing.Rectangle 0, $wallBottom, $Size, ($Size - $wallBottom)
$tableBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $tableRect,
  [System.Drawing.Color]::FromArgb(150, 104, 62),
  [System.Drawing.Color]::FromArgb(104, 68, 38),
  [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillRectangle($tableBrush, $tableRect)
$grain = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(28, 90, 58, 30)), 1
for ($i = 0; $i -lt 26; $i++) {
  $y = $wallBottom + 8 + $i * 12
  $g.DrawLine($grain, 0, $y, $Size, $y + 3)
}

# ── 杯身：圆柱（水平渐变做出明暗）+ 底部椭圆封口 ──────────────────────────────
$bodyRect = New-Object System.Drawing.RectangleF ([float]($cx - $halfW)), ([float]$top), ([float]($halfW * 2)), ([float]($bottom - $top))
$bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $bodyRect,
  [System.Drawing.Color]::FromArgb(252, 252, 250),
  [System.Drawing.Color]::FromArgb(150, 150, 148),
  [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.FillRectangle($bodyBrush, $bodyRect)

# 杯底椭圆（让圆柱有个底）
$bottomEllipse = New-Object System.Drawing.RectangleF ([float]($cx - $halfW)), ([float]($bottom - $halfW * 0.32)), ([float]($halfW * 2)), ([float]($halfW * 0.64))
$g.FillEllipse($bodyBrush, $bottomEllipse)

# ── 把手：右侧一个圆环 ────────────────────────────────────────────────────────
$handleRect = New-Object System.Drawing.RectangleF ([float]($cx + $halfW * 0.35)), ([float]($top + ($bottom - $top) * 0.18)), ([float]($halfW * 1.7)), ([float](($bottom - $top) * 0.55))
$handlePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(232, 232, 230)), ([float]($halfW * 0.42))
$handlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$handlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($handlePen, $handleRect, -80, 190)

# ── 杯口：白瓷环 + 深色咖啡液面 ───────────────────────────────────────────────
$rimRect = New-Object System.Drawing.RectangleF ([float]($cx - $halfW)), ([float]($top - $halfW * 0.22)), ([float]($halfW * 2)), ([float]($halfW * 0.44))
$rimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(253, 253, 251))
$g.FillEllipse($rimBrush, $rimRect)

$coffeeRect = New-Object System.Drawing.RectangleF ([float]($cx - $halfW * 0.82)), ([float]($top - $halfW * 0.16)), ([float]($halfW * 1.64)), ([float]($halfW * 0.32))
$coffeeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(78, 48, 30))
$g.FillEllipse($coffeeBrush, $coffeeRect)

# ── 投影：底部一个深色椭圆（半透明）──────────────────────────────────────────
$shadowRect = New-Object System.Drawing.RectangleF ([float]($cx - $halfW * 1.8)), ([float]($bottom - $halfW * 0.25)), ([float]($halfW * 3.6)), ([float]($halfW * 0.8))
$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 40, 24, 12))
$g.FillEllipse($shadowBrush, $shadowRect)

$g.Dispose()

# ── 保存 JPEG（质量 85）───────────────────────────────────────────────────────
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
$bmp.Save((Resolve-Path -LiteralPath (Split-Path -Parent $Out) | ForEach-Object { Join-Path $_ (Split-Path -Leaf $Out) }), $codec, $ep)
$bmp.Dispose()

$len = (Get-Item $Out).Length
Write-Output "wrote $Out ($len bytes, ${Size}x${Size})"
