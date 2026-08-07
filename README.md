# Harmony Agent Tools

`harmony-agent-tools` is a self-contained PowerShell 5.1-compatible wrapper around official HarmonyOS command-line
tools. It is designed for coding agents and intentionally avoids importing application source or build
configuration.

## Goals

- make device selection explicit and safe when several targets are connected;
- map running DevEco emulator names to their HDC targets;
- provide simple pixel or normalized touch, wait and screenshot commands;
- capture animation frames at specific offsets while a gesture is still running;
- return machine-readable JSON with absolute image paths, plus direct MCP image content;
- crop, compare and assert screenshots without application-specific test code;
- wrap build, install, normal launch and debug launch without automatically uninstalling applications;
- wrap local ArkTS tests and on-device ohosTest execution;
- expose bounded application logs and machine-readable environment diagnostics;
- control foldable display state and absolute rotation through DisplayManagerService debug commands;
- keep project-specific bundle names, abilities, artifact paths and coordinates outside the module.

## Entry point

When local PowerShell policy allows scripts:

```powershell
./hdc-agent.ps1 targets
```

On Windows, the command shim avoids changing the user or machine execution policy:

```powershell
./hdc-agent.cmd targets
```

Every successful command writes JSON to stdout. Errors go to stderr and produce a non-zero exit code.

## Device selection

```powershell
./hdc-agent.cmd targets
```

When more than one usable target is connected, all device-changing or capture commands require `-Target`:

```powershell
-Target 127.0.0.1:5555
```

The wrapper does not guess between connected devices.

On Windows, map running DevEco emulator names to HDC targets:

```powershell
./hdc-agent.cmd emulators
```

This removes the need to correlate `Emulator.exe` process arguments and listening ports manually.

All target-bound commands can select a running DevEco emulator by exact name instead of copying its dynamic port:

```powershell
./hdc-agent.cmd screenshot `
  -EmulatorName "Pura 90" `
  -OutputPath ./artifacts/pura-90.jpeg
```

`-Target` and `-EmulatorName` are mutually exclusive. Use `-Target` for physical devices or when emulator names are
duplicated.

Check the local SDK, commands, connected targets and optional project artifacts:

```powershell
./hdc-agent.cmd doctor -ProjectRoot .
```

Query the physical target display:

```powershell
./hdc-agent.cmd display -EmulatorName "Pura 90"
```

Wait until repeated display samples agree:

```powershell
./hdc-agent.cmd wait-display -EmulatorName "Mate X7" -TimeoutMs 5000
```

Control a foldable emulator and rotate a target:

```powershell
./hdc-agent.cmd fold -EmulatorName "Mate X7" -FoldState folded
./hdc-agent.cmd fold -EmulatorName "Mate X7" -FoldState expanded
./hdc-agent.cmd rotate -EmulatorName "Mate X7" -Rotation 90
```

Fold states are `folded`, `half`, `expanded`, and `dual-expanded` (the last state is intended for supported
tri-fold targets). Rotation accepts `0`, `90`, `180`, or `270` degrees clockwise. These commands use the platform
`DisplayManagerService` debug interface, return the resulting display dimensions, and support `-DryRun`.

## Touch

Tap:

```powershell
./hdc-agent.cmd tap `
  -Target 127.0.0.1:5555 -X 600 -Y 900
```

Smooth touch movement:

```powershell
./hdc-agent.cmd swipe `
  -Target 127.0.0.1:5555 `
  -StartX 600 -StartY 1000 -EndX 600 -EndY 300 -DurationMs 500
```

Coordinates are physical pixels from the top-left of the target display, matching the official `uinput` contract.

For reusable scenarios, use coordinates normalized to the range `0..1`:

```powershell
./hdc-agent.cmd tap `
  -EmulatorName "Pura 90" -XRatio 0.5 -YRatio 0.8

./hdc-agent.cmd swipe `
  -EmulatorName "Pura 90" `
  -StartXRatio 0.5 -StartYRatio 0.8 -EndXRatio 0.5 -EndYRatio 0.2
```

The command queries the target dimensions and converts ratios to physical pixels. For device-free dry runs, pass
`-DisplayWidth` and `-DisplayHeight` explicitly.

Use `-DryRun` to validate and inspect the generated command without injecting input.

## Screenshot

Capture immediately:

```powershell
./hdc-agent.cmd screenshot `
  -Target 127.0.0.1:5555 `
  -OutputPath ./artifacts/current.jpeg
```

Capture after a relative delay:

```powershell
./hdc-agent.cmd screenshot `
  -Target 127.0.0.1:5555 -DelayMs 250 `
  -OutputPath ./artifacts/after-250ms.jpeg
```

`snapshot_display` is used with its portable JPEG output. Screenshot paths must end in `.jpg` or `.jpeg`; omitting
the extension appends `.jpeg`.

The JSON result contains an absolute `path`. The included MCP adapter converts that file into direct image content.

## Gesture frame capture

This command starts `uinput` asynchronously, schedules `snapshot_display` commands from a monotonic clock, then
pulls every image after capture:

```powershell
./hdc-agent.cmd gesture-capture `
  -Target 127.0.0.1:5555 `
  -StartX 600 -StartY 1000 -EndX 600 -EndY 300 `
  -DurationMs 500 -CaptureAtMs 0,100,250,500 `
  -OutputDirectory ./artifacts/gesture `
  -Prefix swipe-up
```

Each returned artifact reports:

- requested time;
- actual snapshot command start time;
- scheduling lateness;
- absolute local path.

This makes timing drift visible instead of pretending frame capture is exact.

Capture schedules are mutually exclusive: use explicit `-CaptureAtMs`, periodic `-CaptureIntervalMs`, or a bounded
`-FrameCount`. Interval and frame-count modes use `-RecordDurationMs`; `-CaptureBefore` adds a pre-action frame,
`-PostRollMs` extends the window, and `-MaxFrames` (default 12) prevents unbounded capture. At most
`-MaxCaptureConcurrency` snapshot processes run at once; excess sampling points are reported as dropped frames.

To observe a complete multi-step scenario instead of one swipe, use the same coordinator through `trace-scenario`:

```powershell
./hdc-agent.cmd trace-scenario `
  -ScenarioPath ./examples/tap-and-capture.json `
  -Target 127.0.0.1:5555 `
  -FrameCount 8 -RecordDurationMs 3000 -CaptureBefore `
  -OutputDirectory ./artifacts/trace `
  -ContactSheetPath ./artifacts/trace/contact-sheet.jpg
```

Original frames and `frames.json` remain under the output directory. The optional labelled contact sheet is bounded
to a 4096-by-4096 image by default, so agents can inspect motion with one image while retaining source evidence.

## Self-test

The smoke test exercises portable command paths in dry-run mode, package discovery, scenario validation, CSV
time-point parsing and screenshot extension validation without requiring a device:

```powershell
./tests/Smoke.ps1
```

The MCP adapter has a device-free content test:

```powershell
npm run test:mcp
```

Run the complete portable verification suite with one command:

```powershell
./tests/Verify.ps1
```

Add `-EmulatorName "Pura 90"` to include direct MCP screenshot and normalized-touch integration.

## Scenarios

Scenarios combine display queries, fold/rotation changes, display-stability waits, touch input, relative waits,
screenshots and gesture capture:

```powershell
./hdc-agent.cmd scenario `
  -ScenarioPath ./examples/tap-and-capture.json `
  -Target 127.0.0.1:5555
```

Validate without touching a device:

```powershell
./hdc-agent.cmd scenario `
  -ScenarioPath ./examples/gesture-frames.json `
  -ValidateOnly
```

`atMs` schedules a step relative to scenario start. A `wait` step waits relative to the preceding step.
Scenarios may use pixel fields or normalized fields such as `xRatio`, `startXRatio` and `endYRatio`. When normalized
scenarios are dry-run, declare `displayWidth` and `displayHeight` in the scenario.

Form-factor steps use these shapes:

```json
{ "action": "display" }
{ "action": "fold", "state": "folded" }
{ "action": "rotate", "rotation": 90 }
{ "action": "waitDisplay", "timeoutMs": 5000 }
```

After a real fold, rotation, display, or display-wait step, the scenario replaces its cached display dimensions.
Subsequent normalized coordinates are therefore resolved against the current display instead of stale startup
dimensions. See `examples/form-factor-cycle.json` for a complete sequence.

## Image inspection and visual assertions

Inspect, crop, resize, or combine images:

```powershell
./hdc-agent.cmd image-info -ImagePath ./actual.jpeg

./hdc-agent.cmd crop-image `
  -ImagePath ./actual.jpeg -OutputPath ./crop.png `
  -CropX 100 -CropY 200 -CropWidth 600 -CropHeight 400
```

```powershell
./hdc-agent.cmd resize-image `
  -ImagePath ./actual.jpeg -OutputPath ./preview.jpeg `
  -MaxWidth 960 -MaxHeight 1600

./hdc-agent.cmd contact-sheet `
  -ImagePaths './frame-1.jpeg,./frame-2.jpeg' `
  -Labels 'before,after' -OutputPath ./contact-sheet.jpg
```

Compare screenshots and emit a red-highlighted difference image:

```powershell
./hdc-agent.cmd compare-images `
  -BaselinePath ./baseline.png -ActualPath ./actual.png `
  -DifferencePath ./difference.png `
  -PixelTolerance 8 -MaxDifferenceRatio 0.01 -MaxMeanError 0.005
```

`assert-image` accepts the same thresholds and exits non-zero when they are exceeded. Images must have matching
dimensions; crop responsive regions first when the full display size is expected to differ.

## Tests

Run ArkTS local tests through Hvigor:

```powershell
./hdc-agent.cmd test-local -ProjectRoot . -Module entry
```

`-HvigorPath` accepts an Hvigor `.bat`, `.cmd`, `.exe`, extensionless executable, or the JavaScript
`hvigorw.js` wrapper. JavaScript wrappers are never launched through Windows file association: the tool resolves a
Node executable and runs `node.exe <hvigorw.js> <arguments>`. Resolution prefers DevEco Studio's bundled
`tools\node\node.exe` next to the Hvigor installation, then `NODE_HOME`, then `node.exe`/`node` on `PATH`. Use
`-HvigorNodePath <node.exe>` to select Node explicitly. Other Hvigor file types are rejected before launch.

For example, a versioned DevEco Studio installation can be selected directly:

```powershell
./hdc-agent.cmd test-local `
  -ProjectRoot . `
  -HvigorPath 'C:\Program Files\Huawei\DevEco Studio 24\tools\hvigor\bin\hvigorw.js'
```

`-DryRun` performs the same resolution and reports the actual process and complete argument list without starting
Hvigor, so a JavaScript wrapper is shown as `node.exe "...\hvigorw.js" test ...`.

Build, install and execute the `ohosTest` package:

```powershell
./hdc-agent.cmd test-device `
  -ProjectRoot . -EmulatorName "Pura 90" `
  -Bundle com.example.music -Module entry -TestModule entry_test
```

`test-device` installs with replacement and never uninstalls. Use `-SkipBuild` to run existing signed HAPs, or pass
`-MainPackagePath` and `-TestPackagePath` when artifact names differ from the standard layout.
Its build phase uses the same `-HvigorPath` and `-HvigorNodePath` resolution rules as `test-local`.

## Build, install and launch

Build:

```powershell
./hdc-agent.cmd build `
  -ProjectRoot . -Product default -BuildMode debug
```

List build products before choosing what to install:

```powershell
./hdc-agent.cmd packages -ProjectRoot .
```

Device-test HAPs are excluded by default. Pass `-IncludeTests` when they are needed.

Install without uninstalling:

```powershell
./hdc-agent.cmd install `
  -Target 127.0.0.1:5555 `
  -PackagePath ./entry/build/default/outputs/default/entry-default-signed.hap
```

Normal launch:

```powershell
./hdc-agent.cmd start `
  -Target 127.0.0.1:5555 `
  -Bundle com.example.music -Ability EntryAbility
```

Debug-mode launch:

```powershell
./hdc-agent.cmd start `
  -Target 127.0.0.1:5555 `
  -Bundle com.example.music -Ability EntryAbility -DebugLaunch
```

`-DebugLaunch` maps to the documented `aa start -D` flag. Debug mode requires a debuggable application and
developer-mode target.

For 2-in-1 window checks, `start` also accepts `-WindowLeft`, `-WindowTop`, `-WindowWidth` and `-WindowHeight`.

Stop an application after debug-mode or isolated launch testing:

```powershell
./hdc-agent.cmd stop `
  -Target 127.0.0.1:5555 -Bundle com.example.music
```

Read a bounded application log snapshot:

```powershell
./hdc-agent.cmd logs `
  -Target 127.0.0.1:5555 -Bundle com.example.music -Level E -Tail 200
```

`logs` uses `devecocli log` and is bounded by default. It also accepts `-Keyword`, `-From` and `-To`; it intentionally
does not expose an unbounded follow mode.

Build, install and launch in sequence:

```powershell
./hdc-agent.cmd deploy `
  -ProjectRoot . `
  -PackagePath ./entry/build/default/outputs/default/entry-default-signed.hap `
  -Target 127.0.0.1:5555 `
  -Bundle com.example.music -Ability EntryAbility -DebugLaunch
```

`deploy` stops after the first failed command. It never uninstalls the existing application.
The install and Ability-start wrappers also inspect HarmonyOS command output because some platform tools return exit
code 0 while reporting an application-level failure in stdout.

## Codex plugin and MCP image return

The directory is also a valid Codex plugin. Its MCP server intentionally exposes six workflow-level tools:

- `harmony_inspect` for environment, device, and safe project discovery;
- `harmony_device_run` for an ordered inline scenario with final, interval, checkpoint, or failure capture;
- `harmony_project_run` for build, local/device test, and deploy workflows;
- `harmony_capture` for one screenshot with a bounded preview by default;
- `harmony_compare` for metrics and failure-only diff images by default;
- `harmony_logs` for bounded filtered diagnostics.

All tools return a common compact `structuredContent` envelope with an output schema, short text summary, artifact
paths, warnings, and an optional diagnostics path. Native command transcripts are not duplicated into successful MCP
responses. `harmony_device_run` preserves original trace frames locally and returns one contact sheet by default;
requesting original frames is an explicit diagnostic choice. Project discovery parses only the non-secret fields
needed for product/module/bundle/ability selection and refuses ambiguous candidates.

For screenshots sampled during one swipe-only scenario, use `capture.mode: "motion"`. The MCP adapter resolves
normalized coordinates before starting the trace, then dispatches the touch command directly so capture time zero
does not include a child scenario process or display lookup. It enforces swipe `durationMs`
of at least `2000` and at least `800ms` between samples; `1000ms` is recommended for physical devices. It schedules
frames inside the swipe time window, rejects plans that produce fewer than two frames or exceed `maxFrames`, and
avoids a zero-time snapshot. Use `capture.mode: "final"` for an ordinary short swipe. The lower-level `interval` and
`checkpoints` modes remain available for whole-scenario sampling and do not imply that frames land inside a swipe.

Install Node dependencies once with `npm install`; validate the adapter with:

```powershell
npm run check
npm run test:mcp
npm run test:mcp:device -- "Pura 90"
```

The repository does not modify a personal Codex marketplace or globally install the plugin. That remains an
explicit consumer choice when this directory is extracted or distributed.

## Use as a Git submodule

Pin the toolkit in another repository:

```powershell
git submodule add https://github.com/wbbb0/harmony-agent-tools.git tools/harmony-agent-tools
git submodule update --init --recursive
```

From the consumer repository root, invoke it through the submodule path, for example:

```powershell
./tools/harmony-agent-tools/hdc-agent.cmd doctor -ProjectRoot .
```

## Portability boundary

Portable core:

- `HdcAgentTools.psm1`
- `ImageAgentTools.psm1`
- `TestAgentTools.psm1`
- `hdc-agent.ps1`
- `hdc-agent.cmd`
- `.codex-plugin/plugin.json`, `.mcp.json` and `mcp/`
- `AGENTS.md`
- `scenario.schema.json`
- generic examples

Possible future distribution work:

- add fully mocked process tests in addition to the current smoke and opt-in device integration checks;
- define support across HDC/OS versions;
- package the module or publish a signed release artifact;
- decide whether future releases also ship as a PowerShell module or npm package.
