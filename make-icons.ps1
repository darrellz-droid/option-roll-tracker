Add-Type -AssemblyName System.Drawing

function New-Icon {
    param(
        [int]$Size,
        [string]$OutPath,
        [double]$Padding = 0.10   # fraction of canvas kept as empty margin (bigger = more room for maskable safe-zone)
    )

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $bgColor = [System.Drawing.Color]::FromArgb(255, 11, 13, 18)
    $g.Clear($bgColor)

    $pad = $Size * $Padding
    $usableW = $Size - 2 * $pad

    # ---- Layout: chart area on top ~58%, wordmark band below ----
    $chartTop = $pad
    $chartH = $usableW * 0.62
    $chartBottom = $chartTop + $chartH

    $textTop = $chartBottom + ($usableW * 0.06)
    $textH = ($Size - $pad) - $textTop

    # ---- Ascending bar chart in tier colors (green -> amber -> red) ----
    $colors = @(
        [System.Drawing.Color]::FromArgb(255, 34, 197, 94),
        [System.Drawing.Color]::FromArgb(255, 234, 179, 8),
        [System.Drawing.Color]::FromArgb(255, 245, 158, 11),
        [System.Drawing.Color]::FromArgb(255, 249, 115, 22),
        [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
    )
    $heightRatios = @(0.26, 0.42, 0.58, 0.78, 1.0)
    $barCount = $colors.Count
    $gapRatio = 0.32
    $barWidth = $usableW / ($barCount + ($barCount - 1) * $gapRatio)
    $gap = $barWidth * $gapRatio
    $corner = $barWidth * 0.28

    $topPoints = New-Object System.Collections.Generic.List[System.Drawing.PointF]

    for ($i = 0; $i -lt $barCount; $i++) {
        $x = $pad + $i * ($barWidth + $gap)
        $h = $chartH * $heightRatios[$i]
        $y = $chartBottom - $h

        $brush = New-Object System.Drawing.SolidBrush($colors[$i])
        $rect = New-Object -TypeName System.Drawing.RectangleF -ArgumentList @($x, $y, $barWidth, $h)

        # rounded-top rectangle path
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = [Math]::Min($corner, $rect.Width / 2)
        $path.AddArc($rect.X, $rect.Y, $d * 2, $d * 2, 180, 90)
        $path.AddArc($rect.X + $rect.Width - $d * 2, $rect.Y, $d * 2, $d * 2, 270, 90)
        $path.AddLine(($rect.X + $rect.Width), ($rect.Y + $d), ($rect.X + $rect.Width), ($rect.Y + $rect.Height))
        $path.AddLine(($rect.X + $rect.Width), ($rect.Y + $rect.Height), $rect.X, ($rect.Y + $rect.Height))
        $path.CloseFigure()

        $g.FillPath($brush, $path)
        $brush.Dispose()
        $path.Dispose()

        $topPoints.Add((New-Object System.Drawing.PointF(($x + $barWidth / 2), ($y - $barWidth * 0.22))))
    }

    # ---- Bullish uptrend arrow line across the bar tops ----
    $trendPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 230, 233, 239), ($barWidth * 0.16))
    $trendPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trendPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trendPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($trendPen, $topPoints.ToArray())

    # arrowhead at the end of the trend line
    $p1 = $topPoints[$topPoints.Count - 2]
    $p2 = $topPoints[$topPoints.Count - 1]
    $angle = [Math]::Atan2(($p2.Y - $p1.Y), ($p2.X - $p1.X))
    $arrowLen = $barWidth * 0.55
    $arrowWide = $barWidth * 0.32
    $tipX = $p2.X + [Math]::Cos($angle) * ($barWidth * 0.15)
    $tipY = $p2.Y + [Math]::Sin($angle) * ($barWidth * 0.15)
    $backX = $tipX - [Math]::Cos($angle) * $arrowLen
    $backY = $tipY - [Math]::Sin($angle) * $arrowLen
    $leftX = $backX + [Math]::Cos($angle + [Math]::PI / 2) * $arrowWide
    $leftY = $backY + [Math]::Sin($angle + [Math]::PI / 2) * $arrowWide
    $rightX = $backX + [Math]::Cos($angle - [Math]::PI / 2) * $arrowWide
    $rightY = $backY + [Math]::Sin($angle - [Math]::PI / 2) * $arrowWide

    $arrowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 230, 233, 239))
    $arrowPts = @(
        (New-Object System.Drawing.PointF($tipX, $tipY)),
        (New-Object System.Drawing.PointF($leftX, $leftY)),
        (New-Object System.Drawing.PointF($rightX, $rightY))
    )
    $g.FillPolygon($arrowBrush, $arrowPts)

    # ---- Wordmark: "LSO" ----
    $fontSize = [float]($textH * 0.92)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 230, 233, 239))
    $strFormat = New-Object System.Drawing.StringFormat
    $strFormat.Alignment = [System.Drawing.StringAlignment]::Center
    $strFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object -TypeName System.Drawing.RectangleF -ArgumentList @($pad, $textTop, $usableW, $textH)
    $g.DrawString("LSO", $font, $textBrush, $textRect, $strFormat)

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose(); $bmp.Dispose()
    $trendPen.Dispose(); $arrowBrush.Dispose(); $font.Dispose(); $textBrush.Dispose()
}

$dir = Join-Path $PSScriptRoot "icons"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

New-Icon -Size 192 -OutPath (Join-Path $dir "icon-192.png") -Padding 0.08
New-Icon -Size 512 -OutPath (Join-Path $dir "icon-512.png") -Padding 0.08
New-Icon -Size 192 -OutPath (Join-Path $dir "icon-192-maskable.png") -Padding 0.20
New-Icon -Size 512 -OutPath (Join-Path $dir "icon-512-maskable.png") -Padding 0.20

Write-Host "Icons generated in $dir"
