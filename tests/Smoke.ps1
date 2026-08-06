[CmdletBinding()]
param()

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$toolRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = Join-Path $toolRoot 'artifacts\smoke-project'
$package = Join-Path $repositoryRoot 'entry\build\default\outputs\default\entry-default-signed.hap'
[void](New-Item -ItemType Directory -Path (Split-Path -Parent $package) -Force)
[void](New-Item -ItemType File -Path $package -Force)
$hvigorFixtureRoot = Join-Path $toolRoot 'artifacts\hvigor smoke'
[void](New-Item -ItemType Directory -Path $hvigorFixtureRoot -Force)
$defaultHvigorPath = Join-Path $hvigorFixtureRoot 'hvigorw.bat'
$explicitHvigorPath = Join-Path $hvigorFixtureRoot 'explicit-hvigorw.bat'
$javascriptHvigorPath = Join-Path $hvigorFixtureRoot `
  'DevEco Studio\tools\hvigor\bin\hvigorw.js'
$bundledNodePath = Join-Path $hvigorFixtureRoot 'DevEco Studio\tools\node\node.exe'
$explicitNodePath = Join-Path $hvigorFixtureRoot 'custom node\node.exe'
$unsupportedHvigorPath = Join-Path $hvigorFixtureRoot 'hvigorw.txt'
foreach ($fixturePath in @(
  $defaultHvigorPath,
  $explicitHvigorPath,
  $javascriptHvigorPath,
  $bundledNodePath,
  $explicitNodePath,
  $unsupportedHvigorPath
)) {
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $fixturePath) -Force)
  [void](New-Item -ItemType File -Path $fixturePath -Force)
}
$cli = Join-Path $toolRoot 'hdc-agent.cmd'
Import-Module (Join-Path $toolRoot 'HdcAgentTools.psm1') -Force -DisableNameChecking

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-CliJson {
  param(
    [string[]]$Arguments
  )

  $output = @(& $cli @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "CLI failed: $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
  }
  return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Invoke-CliFailure {
  param(
    [string[]]$Arguments
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $cli @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    exitCode = $exitCode
    output = $output -join [Environment]::NewLine
  }
}

$module = Get-Module HdcAgentTools
$currentPowerShell = (Get-Process -Id $PID).Path
$largeOutput = & $module {
  param($Executable)
  $running = Start-NativeCommand -FilePath $Executable `
    -ArgumentList @('-NoProfile', '-Command', '[Console]::Out.Write((''x'' * 200000))')
  Complete-NativeCommand -RunningCommand $running
} $currentPowerShell
Assert-True (
  $largeOutput.exitCode -eq 0 -and (($largeOutput.output -join '').Length -eq 200000)
) 'asynchronous native output draining failed for a large child-process payload.'

$tap = Invoke-CliJson @('tap', '-X', '100', '-Y', '200', '-DryRun')
Assert-True ($tap.action -eq 'tap' -and $tap.command.dryRun) 'tap dry-run failed.'

$normalizedTap = Invoke-CliJson @(
  'tap', '-XRatio', '0.5', '-YRatio', '0.5',
  '-DisplayWidth', '1320', '-DisplayHeight', '2856', '-DryRun'
)
Assert-True ($normalizedTap.x -eq 660 -and $normalizedTap.y -eq 1428) `
  'normalized tap conversion failed.'

$emulatorTap = Invoke-CliJson @(
  'tap', '-EmulatorName', 'Pura 90', '-X', '100', '-Y', '200', '-DryRun'
)
Assert-True ($emulatorTap.target -eq '<emulator:Pura 90>' -and $emulatorTap.command.dryRun) `
  'emulator-name dry-run selection failed.'

$fold = Invoke-CliJson @('fold', '-FoldState', 'expanded', '-EmulatorName', 'Mate X7', '-DryRun')
Assert-True ($fold.action -eq 'fold' -and $fold.state -eq 'expanded' -and $fold.command.dryRun) `
  'fold dry-run failed.'

$rotate = Invoke-CliJson @('rotate', '-Rotation', '90', '-EmulatorName', 'Mate X7', '-DryRun')
Assert-True ($rotate.action -eq 'rotate' -and $rotate.rotation -eq 90 -and $rotate.command.dryRun) `
  'rotate dry-run failed.'

$waitDisplay = Invoke-CliJson @('wait-display', '-TimeoutMs', '2000', '-DryRun')
Assert-True ($waitDisplay.action -eq 'waitDisplay' -and $waitDisplay.dryRun) `
  'wait-display dry-run failed.'

$swipe = Invoke-CliJson @(
  'swipe', '-StartX', '100', '-StartY', '400', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '350', '-DryRun'
)
Assert-True ($swipe.action -eq 'swipe' -and $swipe.command.dryRun) 'swipe dry-run failed.'

$normalizedSwipe = Invoke-CliJson @(
  'swipe', '-StartXRatio', '0.25', '-StartYRatio', '0.75',
  '-EndXRatio', '0.75', '-EndYRatio', '0.25',
  '-DisplayWidth', '1320', '-DisplayHeight', '2856', '-DryRun'
)
Assert-True ($normalizedSwipe.start.x -eq 330 -and $normalizedSwipe.end.x -eq 989) `
  'normalized swipe conversion failed.'

$screenshot = Invoke-CliJson @(
  'screenshot', '-OutputPath', (Join-Path $toolRoot 'artifacts\smoke.jpeg'), '-DelayMs', '25',
  '-DryRun'
)
Assert-True ($screenshot.action -eq 'screenshot' -and $screenshot.dryRun) `
  'screenshot dry-run failed.'

$gesture = Invoke-CliJson @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-CaptureAtMs', '0,120,300',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\smoke'), '-DryRun'
)
Assert-True ($gesture.action -eq 'gestureCapture' -and $gesture.captures.Count -eq 3) `
  'gesture-capture CSV time-point parsing failed.'

$intervalGesture = Invoke-CliJson @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-CaptureIntervalMs', '125', '-RecordDurationMs', '500',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\interval-smoke'), '-DryRun'
)
Assert-True (
  $intervalGesture.schedule.mode -eq 'interval' -and $intervalGesture.captures.Count -eq 5
) 'gesture interval capture schedule failed.'

$countGesture = Invoke-CliJson @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-FrameCount', '4', '-RecordDurationMs', '600', '-CaptureBefore',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\count-smoke'), '-DryRun'
)
Assert-True (
  $countGesture.schedule.mode -eq 'frameCount' -and $countGesture.captures.Count -eq 5 -and
  $countGesture.captures[0].phase -eq 'before'
) 'gesture frame-count capture schedule failed.'

$oversizedSchedule = Invoke-CliFailure @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-CaptureIntervalMs', '50', '-RecordDurationMs', '1000', '-MaxFrames', '10',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\limit-smoke'), '-DryRun'
)
Assert-True ($oversizedSchedule.exitCode -ne 0 -and $oversizedSchedule.output -match 'MaxFrames') `
  'capture frame limit was not enforced.'

$deduplicatedGesture = Invoke-CliJson @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-CaptureAtMs', '0,0,100,100',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\dedupe-smoke'), '-DryRun'
)
Assert-True ($deduplicatedGesture.captures.Count -eq 2) 'duplicate capture times were not removed.'

$conflictingSchedule = Invoke-CliFailure @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-CaptureAtMs', '0,100', '-FrameCount', '3',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\conflict-smoke'), '-DryRun'
)
Assert-True ($conflictingSchedule.exitCode -ne 0 -and $conflictingSchedule.output -match 'exactly one capture schedule') `
  'conflicting capture schedules were not rejected.'

$postRollGesture = Invoke-CliJson @(
  'gesture-capture', '-StartX', '100', '-StartY', '500', '-EndX', '100', '-EndY', '200',
  '-DurationMs', '500', '-FrameCount', '3', '-PostRollMs', '200',
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\post-roll-smoke'), '-DryRun'
)
Assert-True ($postRollGesture.schedule.recordDurationMs -eq 700) 'gesture post-roll was not added.'

$build = Invoke-CliJson @(
  'build', '-ProjectRoot', $repositoryRoot, '-Product', 'default', '-BuildMode', 'debug',
  '-DryRun'
)
Assert-True ($build.action -eq 'build' -and $build.command.dryRun) 'build dry-run failed.'

$packages = @(Invoke-CliJson @('packages', '-ProjectRoot', $repositoryRoot))
Assert-True ($packages.Count -gt 0 -and $packages[0].path -match '\.hap$') `
  'package discovery failed.'

$install = Invoke-CliJson @('install', '-PackagePath', $package, '-DryRun')
Assert-True ($install.action -eq 'install' -and $install.command.dryRun) 'install dry-run failed.'

$start = Invoke-CliJson @(
  'start', '-Bundle', 'com.example.app', '-Ability', 'EntryAbility', '-DebugLaunch', '-DryRun'
)
Assert-True ($start.action -eq 'start' -and $start.debugLaunch -and $start.command.dryRun) `
  'debug start dry-run failed.'

$stop = Invoke-CliJson @('stop', '-Bundle', 'com.example.app', '-DryRun')
Assert-True ($stop.action -eq 'stop' -and $stop.command.dryRun) 'stop dry-run failed.'

$logs = Invoke-CliJson @(
  'logs', '-Bundle', 'com.example.app', '-Level', 'E', '-Tail', '20', '-DryRun'
)
Assert-True ($logs.action -eq 'logs' -and $logs.tail -eq 20 -and $logs.command.dryRun) `
  'logs dry-run failed.'

$deploy = Invoke-CliJson @(
  'deploy', '-ProjectRoot', $repositoryRoot, '-PackagePath', $package,
  '-Bundle', 'com.example.app', '-Ability', 'EntryAbility', '-SkipBuild', '-DryRun'
)
Assert-True ($deploy.action -eq 'deploy' -and $deploy.dryRun) 'deploy dry-run failed.'

$originalPath = $env:PATH
try {
  $env:PATH = "${hvigorFixtureRoot};${originalPath}"
  $localTest = Invoke-CliJson @('test-local', '-ProjectRoot', $repositoryRoot, '-DryRun')
} finally {
  $env:PATH = $originalPath
}
Assert-True (
  $localTest.action -eq 'localTest' -and
  $localTest.command.dryRun -and
  $localTest.command.command.StartsWith('"' + $defaultHvigorPath + '"')
) 'local test default Hvigor wrapper dry-run failed.'

$explicitWrapperLocalTest = Invoke-CliJson @(
  'test-local', '-ProjectRoot', $repositoryRoot,
  '-HvigorPath', $explicitHvigorPath, '-DryRun'
)
Assert-True ($explicitWrapperLocalTest.command.command.StartsWith('"' + $explicitHvigorPath + '"')) `
  'local test explicit Hvigor wrapper dry-run failed.'

$javascriptLocalTest = Invoke-CliJson @(
  'test-local', '-ProjectRoot', $repositoryRoot,
  '-HvigorPath', $javascriptHvigorPath, '-DryRun'
)
$expectedJavascriptPrefix = '"' + $bundledNodePath + '" "' + $javascriptHvigorPath + '" test'
Assert-True ($javascriptLocalTest.command.command.StartsWith($expectedJavascriptPrefix)) `
  'local test JavaScript Hvigor wrapper did not use the bundled Node executable.'

$explicitNodeLocalTest = Invoke-CliJson @(
  'test-local', '-ProjectRoot', $repositoryRoot,
  '-HvigorPath', $javascriptHvigorPath, '-HvigorNodePath', $explicitNodePath, '-DryRun'
)
Assert-True ($explicitNodeLocalTest.command.command.StartsWith(
  '"' + $explicitNodePath + '" "' + $javascriptHvigorPath + '" test'
)) 'local test JavaScript Hvigor wrapper did not honor -HvigorNodePath.'

$previousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $unsupportedHvigorOutput = @(
    & $cli test-local -ProjectRoot $repositoryRoot `
      -HvigorPath $unsupportedHvigorPath -DryRun 2>&1
  )
  $unsupportedHvigorExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
Assert-True ($unsupportedHvigorExitCode -ne 0) 'Unsupported Hvigor file type should fail.'
Assert-True (($unsupportedHvigorOutput -join [Environment]::NewLine) -match 'Unsupported Hvigor') `
  'Unsupported Hvigor file type failure was not explained.'

$deviceTest = Invoke-CliJson @(
  'test-device', '-ProjectRoot', $repositoryRoot, '-Bundle', 'com.example.app',
  '-HvigorPath', $javascriptHvigorPath, '-DryRun'
)
Assert-True (
  $deviceTest.action -eq 'deviceTest' -and
  $deviceTest.build.command.command.StartsWith(
    '"' + $bundledNodePath + '" "' + $javascriptHvigorPath + '" onDeviceTest'
  ) -and
  $deviceTest.test.dryRun
) 'device test did not share JavaScript Hvigor command resolution.'

$example = Join-Path $toolRoot 'examples\tap-and-capture.json'
$validation = Invoke-CliJson @('scenario', '-ScenarioPath', $example, '-ValidateOnly')
Assert-True ($validation.valid -and $validation.stepCount -eq 4) 'scenario validation failed.'

$scenario = Invoke-CliJson @(
  'scenario', '-ScenarioPath', $example,
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\scenario-smoke'), '-DryRun'
)
Assert-True ($scenario.action -eq 'scenario' -and $scenario.events.Count -eq 4) `
  'scenario dry-run failed.'

$normalizedExample = Join-Path $toolRoot 'examples\normalized-coordinates.json'
$normalizedScenario = Invoke-CliJson @(
  'scenario', '-ScenarioPath', $normalizedExample,
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\normalized-smoke'), '-DryRun'
)
Assert-True (
  $normalizedScenario.events[0].result.x -eq 660 -and
  $normalizedScenario.events[1].result.end.x -eq 989
) 'normalized scenario dry-run failed.'

$formFactorExample = Join-Path $toolRoot 'examples\form-factor-cycle.json'
$formFactorValidation = Invoke-CliJson @('scenario', '-ScenarioPath', $formFactorExample, '-ValidateOnly')
Assert-True ($formFactorValidation.valid -and $formFactorValidation.stepCount -eq 10) `
  'form-factor scenario validation failed.'
$formFactorScenario = Invoke-CliJson @(
  'scenario', '-ScenarioPath', $formFactorExample,
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\form-factor-smoke'), '-DryRun'
)
Assert-True (
  $formFactorScenario.events.Count -eq 10 -and
  $formFactorScenario.events[0].result.action -eq 'fold' -and
  $formFactorScenario.events[5].result.action -eq 'waitDisplay'
) 'form-factor scenario dry-run failed.'

$tracedScenario = Invoke-CliJson @(
  'trace-scenario', '-ScenarioPath', $example,
  '-OutputDirectory', (Join-Path $toolRoot 'artifacts\trace-scenario-smoke'),
  '-FrameCount', '3', '-RecordDurationMs', '1000', '-CaptureBefore',
  '-ContactSheetPath', (Join-Path $toolRoot 'artifacts\trace-scenario-smoke\sheet.jpg'), '-DryRun'
)
Assert-True (
  $tracedScenario.action -eq 'interactionTrace' -and $tracedScenario.frames.Count -eq 4 -and
  $tracedScenario.actionCommand -match 'hdc-agent\.ps1 scenario' -and $tracedScenario.contactSheet.planned
) 'scenario interaction trace dry-run failed.'

$fakeHdc = Join-Path $toolRoot 'artifacts\fake-hdc.cmd'
@'
@echo off
if "%1"=="list" (
  echo fake-target TCP Connected fake-device
  exit /b 0
)
if "%3"=="install" (
  echo [Info]App install path:fake.hap msg:error: failed to install bundle. code:9568332
  exit /b 0
)
if "%4"=="aa" (
  echo error: failed to start ability.
  echo Error Code:10104001 Error Message:The specified ability does not exist
  exit /b 0
)
exit /b 0
'@ | Set-Content -LiteralPath $fakeHdc -Encoding Ascii
$semanticInstall = Invoke-CliFailure @(
  'install', '-Target', 'fake-target', '-HdcPath', $fakeHdc, '-PackagePath', $package
)
Assert-True (
  $semanticInstall.exitCode -ne 0 -and $semanticInstall.output -match 'semantic failure'
) 'install semantic failure was not detected.'
$semanticStart = Invoke-CliFailure @(
  'start', '-Target', 'fake-target', '-HdcPath', $fakeHdc,
  '-Bundle', 'com.example.missing', '-Ability', 'MissingAbility'
)
Assert-True (
  $semanticStart.exitCode -ne 0 -and $semanticStart.output -match 'semantic failure'
) 'ability-start semantic failure was not detected.'

Add-Type -AssemblyName System.Drawing
$imageDirectory = Join-Path $toolRoot 'artifacts\image-smoke'
[void](New-Item -ItemType Directory -Path $imageDirectory -Force)
$baselinePath = Join-Path $imageDirectory 'baseline.png'
$actualPath = Join-Path $imageDirectory 'actual.png'
$cropPath = Join-Path $imageDirectory 'crop.png'
$differencePath = Join-Path $imageDirectory 'difference.png'
$resizedPath = Join-Path $imageDirectory 'resized.jpg'
$contactSheetPath = Join-Path $imageDirectory 'contact-sheet.jpg'
$bitmap = New-Object System.Drawing.Bitmap(8, 8)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Black)
  } finally {
    $graphics.Dispose()
  }
  $bitmap.Save($baselinePath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Save($actualPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bitmap.Dispose()
}

$imageInfo = Invoke-CliJson @('image-info', '-ImagePath', $baselinePath)
Assert-True ($imageInfo.width -eq 8 -and $imageInfo.height -eq 8) 'image info failed.'

$crop = Invoke-CliJson @(
  'crop-image', '-ImagePath', $baselinePath, '-OutputPath', $cropPath,
  '-CropX', '2', '-CropY', '2', '-CropWidth', '4', '-CropHeight', '4'
)
Assert-True ($crop.rectangle.width -eq 4 -and (Test-Path -LiteralPath $crop.path)) `
  'image crop failed.'

$resized = Invoke-CliJson @(
  'resize-image', '-ImagePath', $baselinePath, '-OutputPath', $resizedPath,
  '-MaxWidth', '64', '-MaxHeight', '64'
)
Assert-True ($resized.width -eq 8 -and (Test-Path -LiteralPath $resized.path)) `
  'image resize failed.'

$sheet = Invoke-CliJson @(
  'contact-sheet', '-ImagePaths', "${baselinePath},${actualPath}",
  '-Labels', 'before,after', '-OutputPath', $contactSheetPath, '-ContactSheetColumns', '2'
)
Assert-True ($sheet.sourceCount -eq 2 -and $sheet.columns -eq 2 -and (Test-Path -LiteralPath $sheet.path)) `
  'contact sheet generation failed.'

$comparison = Invoke-CliJson @(
  'compare-images', '-BaselinePath', $baselinePath, '-ActualPath', $actualPath,
  '-DifferencePath', $differencePath
)
Assert-True ($comparison.passed -and $comparison.metrics.differentPixels -eq 0) `
  'identical image comparison failed.'

$assertion = Invoke-CliJson @(
  'assert-image', '-BaselinePath', $baselinePath, '-ActualPath', $actualPath
)
Assert-True ($assertion.passed -and $assertion.action -eq 'assertImage') `
  'image assertion failed.'

$changedBitmap = New-Object System.Drawing.Bitmap(8, 8)
try {
  $changedGraphics = [System.Drawing.Graphics]::FromImage($changedBitmap)
  try {
    $changedGraphics.Clear([System.Drawing.Color]::Black)
  } finally {
    $changedGraphics.Dispose()
  }
  $changedBitmap.SetPixel(3, 3, [System.Drawing.Color]::White)
  $changedBitmap.Save($actualPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $changedBitmap.Dispose()
}
$changedComparison = Invoke-CliJson @(
  'compare-images', '-BaselinePath', $baselinePath, '-ActualPath', $actualPath,
  '-DifferencePath', $differencePath
)
Assert-True (
  -not $changedComparison.passed -and
  $changedComparison.metrics.differentPixels -eq 1 -and
  (Test-Path -LiteralPath $changedComparison.difference)
) 'changed pixel comparison failed.'

$previousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $invalidOutput = @(
    & $cli screenshot -OutputPath (Join-Path $toolRoot 'artifacts\invalid.png') -DryRun 2>&1
  )
  $invalidExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
Assert-True ($invalidExitCode -ne 0) 'PNG output should have been rejected.'
Assert-True (($invalidOutput -join [Environment]::NewLine) -match '\.jpg or \.jpeg') `
  'PNG rejection did not explain the supported extensions.'

[pscustomobject]@{
  result = 'PASS'
  checks = 48
  deviceRequired = $false
} | ConvertTo-Json
