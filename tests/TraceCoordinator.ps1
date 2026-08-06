[CmdletBinding()]
param()

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$toolRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $toolRoot 'artifacts\trace-coordinator-test'
[void](New-Item -ItemType Directory -Path $artifactRoot -Force)
$fakeHdc = Join-Path $artifactRoot 'fake-hdc.exe'
$fakeLog = Join-Path $artifactRoot 'fake-hdc.log'
if (Test-Path -LiteralPath $fakeHdc) { Remove-Item -LiteralPath $fakeHdc -Force }
if (Test-Path -LiteralPath $fakeLog) { Remove-Item -LiteralPath $fakeLog -Force }

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Threading;
public static class FakeHdc
{
    public static int Main(string[] args)
    {
        string joined = String.Join(" ", args);
        string log = Environment.GetEnvironmentVariable("HARMONY_FAKE_HDC_LOG");
        if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, joined + Environment.NewLine);
        if (joined.Contains("list targets -v"))
        {
            Console.WriteLine("fake-target TCP Connected fake-device");
            return 0;
        }
        if (joined.Contains("snapshot_display"))
        {
            int delay;
            if (Int32.TryParse(Environment.GetEnvironmentVariable("HARMONY_FAKE_HDC_DELAY_MS"), out delay)) Thread.Sleep(delay);
            return Environment.GetEnvironmentVariable("HARMONY_FAKE_HDC_FAIL") == "1" ? 7 : 0;
        }
        if (joined.Contains("file recv"))
        {
            string destination = args[args.Length - 1];
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.WriteAllBytes(destination, new byte[] { 1, 2, 3 });
        }
        return 0;
    }
}
'@ -OutputAssembly $fakeHdc -OutputType ConsoleApplication

Import-Module (Join-Path $toolRoot 'HdcAgentTools.psm1') -Force -DisableNameChecking
$currentPowerShell = (Get-Process -Id $PID).Path
$previousLog = $env:HARMONY_FAKE_HDC_LOG
$previousDelay = $env:HARMONY_FAKE_HDC_DELAY_MS
$previousFail = $env:HARMONY_FAKE_HDC_FAIL
try {
  $env:HARMONY_FAKE_HDC_LOG = $fakeLog
  $env:HARMONY_FAKE_HDC_DELAY_MS = '250'
  $env:HARMONY_FAKE_HDC_FAIL = '0'
  $trace = Invoke-HarmonyInteractionTrace `
    -ActionFilePath $currentPowerShell `
    -ActionArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400') `
    -CaptureIntervalMs 50 -RecordDurationMs 200 -MaxFrames 5 -MaxConcurrency 1 `
    -OutputDirectory (Join-Path $artifactRoot 'bounded') -Target 'fake-target' -HdcPath $fakeHdc
  if ($trace.frames.Count -ne 1 -or $trace.droppedFrames.Count -ne 4) {
    throw "Expected one captured and four dropped frames; got $($trace.frames.Count)/$($trace.droppedFrames.Count)."
  }
  if (-not (Test-Path -LiteralPath $trace.manifestPath)) { throw 'Trace manifest was not written.' }
  if ($trace.frames[0].latenessMs -lt 0) { throw 'Trace lateness must not be negative.' }
  if ((Get-Content -LiteralPath $fakeLog -Raw) -notmatch 'shell rm -f /data/local/tmp/hdc-agent-') {
    throw 'Successful trace did not clean its exact remote frame.'
  }

  [System.IO.File]::WriteAllText($fakeLog, '')
  $env:HARMONY_FAKE_HDC_DELAY_MS = '0'
  $env:HARMONY_FAKE_HDC_FAIL = '1'
  $failed = $false
  try {
    [void](Invoke-HarmonyInteractionTrace `
      -ActionFilePath $currentPowerShell -ActionArgumentList @('-NoProfile', '-Command', 'exit 0') `
      -FrameCount 1 -RecordDurationMs 0 -MaxFrames 1 -MaxConcurrency 1 `
      -OutputDirectory (Join-Path $artifactRoot 'failure') -Target 'fake-target' -HdcPath $fakeHdc)
  } catch {
    $failed = $true
  }
  if (-not $failed) { throw 'A failed snapshot process did not fail the trace.' }
  if ((Get-Content -LiteralPath $fakeLog -Raw) -notmatch 'shell rm -f /data/local/tmp/hdc-agent-') {
    throw 'Failed trace did not clean its exact remote frame.'
  }
} finally {
  $env:HARMONY_FAKE_HDC_LOG = $previousLog
  $env:HARMONY_FAKE_HDC_DELAY_MS = $previousDelay
  $env:HARMONY_FAKE_HDC_FAIL = $previousFail
}

[pscustomobject]@{ result = 'PASS'; checks = 6 } | ConvertTo-Json
