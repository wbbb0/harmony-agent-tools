Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if ($null -eq ('HarmonyAgentTools.ImageComparer' -as [type])) {
  Add-Type -ReferencedAssemblies @('System.Drawing', 'System') -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace HarmonyAgentTools
{
    public sealed class ImageComparisonResult
    {
        public int Width { get; set; }
        public int Height { get; set; }
        public long TotalPixels { get; set; }
        public long DifferentPixels { get; set; }
        public double DifferenceRatio { get; set; }
        public double MeanAbsoluteError { get; set; }
        public int MaxChannelDifference { get; set; }
    }

    public static class ImageComparer
    {
        private static Bitmap ToArgbBitmap(Image source)
        {
            Bitmap converted = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(converted))
            {
                graphics.DrawImageUnscaled(source, 0, 0);
            }
            return converted;
        }

        private static byte[] ReadBytes(Bitmap bitmap, out BitmapData data)
        {
            Rectangle rectangle = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            data = bitmap.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            byte[] bytes = new byte[Math.Abs(data.Stride) * bitmap.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            return bytes;
        }

        public static ImageComparisonResult Compare(
            string baselinePath,
            string actualPath,
            string differencePath,
            int pixelTolerance)
        {
            using (Image baselineSource = Image.FromFile(baselinePath))
            using (Image actualSource = Image.FromFile(actualPath))
            {
                if (baselineSource.Width != actualSource.Width ||
                    baselineSource.Height != actualSource.Height)
                {
                    throw new InvalidOperationException(String.Format(
                        "Image dimensions differ: baseline={0}x{1}, actual={2}x{3}.",
                        baselineSource.Width,
                        baselineSource.Height,
                        actualSource.Width,
                        actualSource.Height));
                }

                using (Bitmap baseline = ToArgbBitmap(baselineSource))
                using (Bitmap actual = ToArgbBitmap(actualSource))
                using (Bitmap difference = new Bitmap(
                    baseline.Width,
                    baseline.Height,
                    PixelFormat.Format32bppArgb))
                {
                    BitmapData baselineData;
                    BitmapData actualData;
                    byte[] baselineBytes = ReadBytes(baseline, out baselineData);
                    byte[] actualBytes = ReadBytes(actual, out actualData);
                    byte[] differenceBytes = new byte[baselineBytes.Length];
                    long differentPixels = 0;
                    long absoluteDifference = 0;
                    int maxChannelDifference = 0;

                    try
                    {
                        int stride = Math.Abs(baselineData.Stride);
                        for (int y = 0; y < baseline.Height; y++)
                        {
                            int row = y * stride;
                            for (int x = 0; x < baseline.Width; x++)
                            {
                                int offset = row + (x * 4);
                                int blue = Math.Abs(baselineBytes[offset] - actualBytes[offset]);
                                int green = Math.Abs(baselineBytes[offset + 1] - actualBytes[offset + 1]);
                                int red = Math.Abs(baselineBytes[offset + 2] - actualBytes[offset + 2]);
                                int pixelMaximum = Math.Max(blue, Math.Max(green, red));
                                absoluteDifference += blue + green + red;
                                maxChannelDifference = Math.Max(maxChannelDifference, pixelMaximum);

                                bool changed = pixelMaximum > pixelTolerance;
                                if (changed)
                                {
                                    differentPixels++;
                                    differenceBytes[offset] = 0;
                                    differenceBytes[offset + 1] = 0;
                                    differenceBytes[offset + 2] = (byte)Math.Max(64, pixelMaximum);
                                }
                                else
                                {
                                    byte context = (byte)(
                                        (actualBytes[offset] + actualBytes[offset + 1] +
                                         actualBytes[offset + 2]) / 15);
                                    differenceBytes[offset] = context;
                                    differenceBytes[offset + 1] = context;
                                    differenceBytes[offset + 2] = context;
                                }
                                differenceBytes[offset + 3] = 255;
                            }
                        }
                    }
                    finally
                    {
                        baseline.UnlockBits(baselineData);
                        actual.UnlockBits(actualData);
                    }

                    if (!String.IsNullOrEmpty(differencePath))
                    {
                        Rectangle rectangle = new Rectangle(0, 0, difference.Width, difference.Height);
                        BitmapData differenceData = difference.LockBits(
                            rectangle,
                            ImageLockMode.WriteOnly,
                            PixelFormat.Format32bppArgb);
                        try
                        {
                            Marshal.Copy(
                                differenceBytes,
                                0,
                                differenceData.Scan0,
                                differenceBytes.Length);
                        }
                        finally
                        {
                            difference.UnlockBits(differenceData);
                        }
                        string extension = Path.GetExtension(differencePath).ToLowerInvariant();
                        difference.Save(
                            differencePath,
                            extension == ".jpg" || extension == ".jpeg"
                                ? ImageFormat.Jpeg
                                : ImageFormat.Png);
                    }

                    long totalPixels = (long)baseline.Width * baseline.Height;
                    return new ImageComparisonResult
                    {
                        Width = baseline.Width,
                        Height = baseline.Height,
                        TotalPixels = totalPixels,
                        DifferentPixels = differentPixels,
                        DifferenceRatio = (double)differentPixels / totalPixels,
                        MeanAbsoluteError =
                            (double)absoluteDifference / (totalPixels * 3.0 * 255.0),
                        MaxChannelDifference = maxChannelDifference
                    };
                }
            }
        }
    }
}
'@
}

function Resolve-AgentImagePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [switch]$MustExist
  )

  $absolutePath = [System.IO.Path]::GetFullPath($Path)
  $extension = [System.IO.Path]::GetExtension($absolutePath).ToLowerInvariant()
  if ($extension -notin @('.png', '.jpg', '.jpeg', '.bmp')) {
    throw "Unsupported image extension '${extension}'. Use PNG, JPEG or BMP."
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    throw "Image does not exist: ${absolutePath}"
  }
  return $absolutePath
}

function Get-AgentImageInfo {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath
  )

  $absolutePath = Resolve-AgentImagePath -Path $ImagePath -MustExist
  $image = [System.Drawing.Image]::FromFile($absolutePath)
  try {
    return [pscustomobject]@{
      action = 'imageInfo'
      path = $absolutePath
      width = $image.Width
      height = $image.Height
      pixelFormat = $image.PixelFormat.ToString()
      format = $image.RawFormat.ToString()
      sizeBytes = (Get-Item -LiteralPath $absolutePath).Length
    }
  } finally {
    $image.Dispose()
  }
}

function Crop-AgentImage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, 100000)]
    [int]$X,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, 100000)]
    [int]$Y,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 100000)]
    [int]$Width,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 100000)]
    [int]$Height
  )

  $absoluteInput = Resolve-AgentImagePath -Path $ImagePath -MustExist
  $absoluteOutput = Resolve-AgentImagePath -Path $OutputPath
  $source = [System.Drawing.Image]::FromFile($absoluteInput)
  try {
    if ($X + $Width -gt $source.Width -or $Y + $Height -gt $source.Height) {
      throw "Crop rectangle ${X},${Y},${Width},${Height} exceeds image size $($source.Width)x$($source.Height)."
    }
    $directory = Split-Path -Parent $absoluteOutput
    [void](New-Item -ItemType Directory -Path $directory -Force)
    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $sourceRectangle = New-Object System.Drawing.Rectangle($X, $Y, $Width, $Height)
        $destinationRectangle = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
        $graphics.DrawImage(
          $source,
          $destinationRectangle,
          $sourceRectangle,
          [System.Drawing.GraphicsUnit]::Pixel
        )
      } finally {
        $graphics.Dispose()
      }
      $extension = [System.IO.Path]::GetExtension($absoluteOutput).ToLowerInvariant()
      $format = if ($extension -in @('.jpg', '.jpeg')) {
        [System.Drawing.Imaging.ImageFormat]::Jpeg
      } elseif ($extension -eq '.bmp') {
        [System.Drawing.Imaging.ImageFormat]::Bmp
      } else {
        [System.Drawing.Imaging.ImageFormat]::Png
      }
      $bitmap.Save($absoluteOutput, $format)
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    $source.Dispose()
  }

  return [pscustomobject]@{
    action = 'cropImage'
    source = $absoluteInput
    path = $absoluteOutput
    rectangle = [pscustomobject]@{ x = $X; y = $Y; width = $Width; height = $Height }
  }
}

function Compare-AgentImage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaselinePath,

    [Parameter(Mandatory = $true)]
    [string]$ActualPath,

    [string]$DifferencePath = '',

    [ValidateRange(0, 255)]
    [int]$PixelTolerance = 0,

    [ValidateRange(0.0, 1.0)]
    [double]$MaxDifferenceRatio = 0.0,

    [ValidateRange(0.0, 1.0)]
    [double]$MaxMeanError = 0.0
  )

  $absoluteBaseline = Resolve-AgentImagePath -Path $BaselinePath -MustExist
  $absoluteActual = Resolve-AgentImagePath -Path $ActualPath -MustExist
  $absoluteDifference = ''
  if ($DifferencePath.Length -gt 0) {
    $absoluteDifference = Resolve-AgentImagePath -Path $DifferencePath
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $absoluteDifference) -Force)
  }
  $metrics = [HarmonyAgentTools.ImageComparer]::Compare(
    $absoluteBaseline,
    $absoluteActual,
    $absoluteDifference,
    $PixelTolerance
  )
  $passed = $metrics.DifferenceRatio -le $MaxDifferenceRatio -and
    $metrics.MeanAbsoluteError -le $MaxMeanError
  return [pscustomobject]@{
    action = 'compareImages'
    passed = $passed
    baseline = $absoluteBaseline
    actual = $absoluteActual
    difference = if ($absoluteDifference.Length -gt 0) { $absoluteDifference } else { $null }
    thresholds = [pscustomobject]@{
      pixelTolerance = $PixelTolerance
      maxDifferenceRatio = $MaxDifferenceRatio
      maxMeanError = $MaxMeanError
    }
    metrics = [pscustomobject]@{
      width = $metrics.Width
      height = $metrics.Height
      totalPixels = $metrics.TotalPixels
      differentPixels = $metrics.DifferentPixels
      differenceRatio = $metrics.DifferenceRatio
      meanAbsoluteError = $metrics.MeanAbsoluteError
      maxChannelDifference = $metrics.MaxChannelDifference
    }
  }
}

function Assert-AgentImage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaselinePath,

    [Parameter(Mandatory = $true)]
    [string]$ActualPath,

    [string]$DifferencePath = '',

    [ValidateRange(0, 255)]
    [int]$PixelTolerance = 0,

    [ValidateRange(0.0, 1.0)]
    [double]$MaxDifferenceRatio = 0.0,

    [ValidateRange(0.0, 1.0)]
    [double]$MaxMeanError = 0.0
  )

  $comparison = Compare-AgentImage @PSBoundParameters
  if (-not $comparison.passed) {
    throw (
      'Image assertion failed: differenceRatio={0:P4} (max {1:P4}), ' +
      'meanAbsoluteError={2:P4} (max {3:P4}), diff={4}' -f
      $comparison.metrics.differenceRatio,
      $comparison.thresholds.maxDifferenceRatio,
      $comparison.metrics.meanAbsoluteError,
      $comparison.thresholds.maxMeanError,
      $comparison.difference
    )
  }
  $comparison.action = 'assertImage'
  return $comparison
}

function New-AgentContactSheet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$ImagePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string[]]$Label = @(),

    [ValidateRange(0, 12)]
    [int]$Columns = 0,

    [ValidateRange(64, 1024)]
    [int]$MaxCellWidth = 360,

    [ValidateRange(64, 2048)]
    [int]$MaxCellHeight = 720,

    [ValidateRange(512, 8192)]
    [int]$MaxSheetWidth = 4096,

    [ValidateRange(512, 8192)]
    [int]$MaxSheetHeight = 4096
  )

  $paths = @($ImagePath)
  if ($paths.Count -eq 0) {
    throw 'Contact sheet requires at least one image.'
  }
  if ($paths.Count -gt 60) {
    throw "Contact sheet supports at most 60 images. Received: $($paths.Count)."
  }
  if ($Label.Count -gt 0 -and $Label.Count -ne $paths.Count) {
    throw 'Contact sheet labels must be empty or match the image count.'
  }

  $absolutePaths = @($paths | ForEach-Object {
    Resolve-AgentImagePath -Path $_ -MustExist
  })
  $absoluteOutput = Resolve-AgentImagePath -Path $OutputPath
  if ([System.IO.Path]::GetExtension($absoluteOutput).ToLowerInvariant() -notin @('.jpg', '.jpeg')) {
    throw "Contact sheet output must use .jpg or .jpeg: ${absoluteOutput}"
  }
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $absoluteOutput) -Force)

  $images = @()
  try {
    foreach ($path in $absolutePaths) {
      $images += [System.Drawing.Image]::FromFile($path)
    }
    $resolvedColumns = if ($Columns -gt 0) {
      [Math]::Min($Columns, $images.Count)
    } else {
      [Math]::Min(4, [Math]::Max(1, [int][Math]::Ceiling([Math]::Sqrt($images.Count))))
    }
    $rows = [int][Math]::Ceiling($images.Count / [double]$resolvedColumns)
    $padding = 8
    $labelHeight = 28
    $widthBudget = [Math]::Max(1, [int][Math]::Floor(($MaxSheetWidth - $padding) / [double]$resolvedColumns) - $padding)
    $heightBudget = [Math]::Max(1, [int][Math]::Floor(($MaxSheetHeight - $padding) / [double]$rows) - $labelHeight - $padding)
    $cellWidth = [Math]::Min($widthBudget, [Math]::Min($MaxCellWidth, [int]($images | Measure-Object Width -Maximum).Maximum))
    $cellHeight = [Math]::Min($heightBudget, [Math]::Min($MaxCellHeight, [int]($images | Measure-Object Height -Maximum).Maximum))
    $sheetWidth = $padding + ($resolvedColumns * ($cellWidth + $padding))
    $sheetHeight = $padding + ($rows * ($cellHeight + $labelHeight + $padding))

    $sheet = New-Object System.Drawing.Bitmap($sheetWidth, $sheetHeight)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($sheet)
      try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(24, 24, 24))
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $font = [System.Drawing.SystemFonts]::DefaultFont
        $labelBrush = [System.Drawing.Brushes]::White
        $cellBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 40, 40))
        try {
          for ($index = 0; $index -lt $images.Count; $index += 1) {
            $column = $index % $resolvedColumns
            $row = [int][Math]::Floor($index / [double]$resolvedColumns)
            $cellX = $padding + ($column * ($cellWidth + $padding))
            $cellY = $padding + ($row * ($cellHeight + $labelHeight + $padding))
            $graphics.FillRectangle($cellBrush, $cellX, $cellY, $cellWidth, $cellHeight)

            $image = $images[$index]
            $scale = [Math]::Min($cellWidth / [double]$image.Width, $cellHeight / [double]$image.Height)
            $drawWidth = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
            $drawHeight = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
            $drawX = $cellX + [int](($cellWidth - $drawWidth) / 2)
            $drawY = $cellY + [int](($cellHeight - $drawHeight) / 2)
            $graphics.DrawImage($image, $drawX, $drawY, $drawWidth, $drawHeight)

            $text = if ($Label.Count -gt 0) { $Label[$index] } else { "frame $index" }
            $graphics.DrawString($text, $font, $labelBrush, $cellX, $cellY + $cellHeight + 6)
          }
        } finally {
          $cellBrush.Dispose()
        }
      } finally {
        $graphics.Dispose()
      }
      $sheet.Save($absoluteOutput, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    } finally {
      $sheet.Dispose()
    }
  } finally {
    foreach ($image in $images) {
      $image.Dispose()
    }
  }

  return [pscustomobject]@{
    action = 'contactSheet'
    path = $absoluteOutput
    sourceCount = $absolutePaths.Count
    columns = $resolvedColumns
    rows = $rows
    width = $sheetWidth
    height = $sheetHeight
  }
}

function Resize-AgentImage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [ValidateRange(64, 4096)]
    [int]$MaxWidth = 960,

    [ValidateRange(64, 4096)]
    [int]$MaxHeight = 1600
  )

  $absoluteInput = Resolve-AgentImagePath -Path $ImagePath -MustExist
  $absoluteOutput = Resolve-AgentImagePath -Path $OutputPath
  if ([System.IO.Path]::GetExtension($absoluteOutput).ToLowerInvariant() -notin @('.jpg', '.jpeg', '.png')) {
    throw "Resized image output must use .jpg, .jpeg, or .png: ${absoluteOutput}"
  }
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $absoluteOutput) -Force)

  $source = [System.Drawing.Image]::FromFile($absoluteInput)
  try {
    $scale = [Math]::Min(1.0, [Math]::Min($MaxWidth / [double]$source.Width, $MaxHeight / [double]$source.Height))
    $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, $width, $height)
      } finally {
        $graphics.Dispose()
      }
      if ([System.IO.Path]::GetExtension($absoluteOutput).ToLowerInvariant() -eq '.png') {
        $bitmap.Save($absoluteOutput, [System.Drawing.Imaging.ImageFormat]::Png)
      } else {
        $bitmap.Save($absoluteOutput, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      }
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    $source.Dispose()
  }

  return [pscustomobject]@{
    action = 'resizeImage'
    source = $absoluteInput
    path = $absoluteOutput
    width = $width
    height = $height
    maxWidth = $MaxWidth
    maxHeight = $MaxHeight
  }
}

Export-ModuleMember -Function @(
  'Get-AgentImageInfo',
  'Crop-AgentImage',
  'Compare-AgentImage',
  'Assert-AgentImage',
  'New-AgentContactSheet',
  'Resize-AgentImage'
)
