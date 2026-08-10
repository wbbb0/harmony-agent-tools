import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHarmonyServer } from "./server.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "harmony-mcp-contract-"));
const projectRoot = path.join(directory, "project");
await mkdir(path.join(projectRoot, "AppScope"), { recursive: true });
await mkdir(path.join(projectRoot, "entry", "src", "main"), { recursive: true });
await writeFile(path.join(projectRoot, "build-profile.json5"), `{ app: { products: [{ name: 'default' }] }, modules: [{ name: 'entry', srcPath: './entry' }] }`);
await writeFile(path.join(projectRoot, "AppScope", "app.json5"), `{ app: { bundleName: 'com.example.contract' } }`);
await writeFile(path.join(projectRoot, "entry", "src", "main", "module.json5"), `{ module: { mainElement: 'EntryAbility', abilities: [{ name: 'EntryAbility' }] } }`);
const escapingRoot = path.join(directory, "escaping-project");
await mkdir(escapingRoot, { recursive: true });
await writeFile(path.join(escapingRoot, "build-profile.json5"), `{ app: { products: [{ name: 'default' }] }, modules: [{ name: 'outside', srcPath: '..' }] }`);
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const calls = [];
const previousHdcPath = process.env.HDC_PATH;
process.env.HDC_PATH = "C:/fake/hdc.exe";
async function fakeInvoke(command, args) {
  calls.push({ command, args });
  if (command === "doctor") return { action: "doctor", healthy: true, checks: Array.from({ length: 40 }, (_, index) => ({ name: `check-${index}`, status: "pass", detail: "x".repeat(500) })) };
  if (command === "targets") return { target: "127.0.0.1:5555", state: "Connected", model: "Pura X Max" };
  if (command === "emulators") return { name: "Pura X Max", target: "127.0.0.1:5555", connected: true, hdcState: "Connected" };
  if (command === "packages") return { path: path.join(projectRoot, "entry-default-signed.hap"), module: "entry", test: false };
  if (command === "scenario") {
    const scenarioPath = args[args.indexOf("-ScenarioPath") + 1];
    const scenario = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(scenarioPath, "utf8")));
    if (scenario.steps[0]?.milliseconds === 9999) throw new Error("synthetic scenario failure");
    return { action: "scenario", events: [{ huge: "x".repeat(10000) }] };
  }
  if (command === "trace-scenario" || command === "gesture-capture") {
    const outputDirectory = args[args.indexOf("-OutputDirectory") + 1];
    const sheetPath = args[args.indexOf("-ContactSheetPath") + 1];
    const framePath = path.join(outputDirectory, "frame.jpeg");
    const manifestPath = path.join(outputDirectory, "frames.json");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(framePath, pixel);
    await writeFile(sheetPath, pixel);
    await writeFile(manifestPath, "{}");
    const frames = [{ path: framePath, phase: "during", actualStartMs: 4 }];
    return command === "gesture-capture"
      ? { action: "gestureCapture", captures: frames, droppedFrames: [{ requestedAtMs: 50 }], maxLatenessMs: 4, manifestPath, contactSheet: { path: sheetPath } }
      : { action: "interactionTrace", frames, droppedFrames: [{ requestedAtMs: 50 }], maxLatenessMs: 4, manifestPath, contactSheet: { path: sheetPath } };
  }
  if (command === "screenshot") {
    const outputPath = args[args.indexOf("-OutputPath") + 1];
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, pixel);
    return { action: "screenshot", path: outputPath };
  }
  if (command === "resize-image") {
    const source = args[args.indexOf("-ImagePath") + 1];
    const outputPath = args[args.indexOf("-OutputPath") + 1];
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await import("node:fs/promises").then((fs) => fs.readFile(source)));
    return { action: "resizeImage", path: outputPath, width: 1, height: 1 };
  }
  if (command === "build") return { action: "build", exitCode: 0, output: "x".repeat(10000) };
  if (command === "test-local") {
    if (args.some((value) => String(value).replaceAll("\\", "/").endsWith("/fake/failing-hvigorw.js"))) {
      const data = { action: "localTest", projectRoot, module: "entry", product: "default", passed: false, command: { exitCode: 0, durationMs: 20, output: "x".repeat(20000) }, summary: { testsRun: 2, passed: 1, failures: 1, errors: 0 } };
      throw Object.assign(new Error("Local Hypium tests did not pass."), { data });
    }
    return { action: "localTest", passed: true, exitCode: 0 };
  }
  if (command === "logs") return { action: "logs", lines: Array.from({ length: 100 }, (_, index) => `${index} ${"log".repeat(200)}`) };
  throw new Error(`Unexpected fake command: ${command}`);
}

const server = createHarmonyServer({ invoke: fakeInvoke });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "contract", version: "0.2.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);
let checks = 0;
try {
  const inspect = await client.callTool({ name: "harmony_inspect", arguments: { scope: "project", projectRoot } });
  assert.equal(inspect.structuredContent.data.project.bundle, "com.example.contract"); checks += 1;
  assert.equal(inspect.structuredContent.data.project.packages.length, 1); checks += 1;
  const environment = await client.callTool({ name: "harmony_inspect", arguments: { scope: "environment" } });
  assert.ok(JSON.stringify(environment.structuredContent).length < 2000); checks += 1;
  assert.ok(calls.find((item) => item.command === "doctor").args.includes("-HdcPath")); checks += 1;
  const devices = await client.callTool({ name: "harmony_inspect", arguments: { scope: "device" } });
  assert.equal(devices.isError, undefined); checks += 1;
  assert.deepEqual(devices.structuredContent.data.targets, [{ target: "127.0.0.1:5555", state: "Connected", model: "Pura X Max" }]); checks += 1;
  assert.deepEqual(devices.structuredContent.data.emulators, [{ name: "Pura X Max", target: "127.0.0.1:5555", state: "Connected" }]); checks += 1;
  assert.ok(calls.find((item) => item.command === "targets").args.includes("-HdcPath")); checks += 1;
  assert.ok(calls.find((item) => item.command === "emulators").args.includes("-HdcPath")); checks += 1;
  const escaped = await client.callTool({ name: "harmony_inspect", arguments: { scope: "project", projectRoot: escapingRoot } });
  assert.equal(escaped.isError, true); checks += 1;
  const build = await client.callTool({ name: "harmony_project_run", arguments: { operation: "build", projectRoot } });
  assert.equal(build.structuredContent.ok, true); checks += 1;
  assert.ok(JSON.stringify(build.structuredContent).length < 2000); checks += 1;
  assert.ok(calls.find((item) => item.command === "build").args.includes("-Modules")); checks += 1;
  const localTest = await client.callTool({ name: "harmony_project_run", arguments: { operation: "test-local", projectRoot, hvigorPath: "C:/fake/hvigorw.js", hvigorNodePath: "C:/fake/node.exe" } });
  assert.equal(localTest.structuredContent.data.passed, true); checks += 1;
  const localTestCall = calls.find((item) => item.command === "test-local");
  assert.ok(localTestCall.args.includes("-HvigorPath") && localTestCall.args.includes("-HvigorNodePath")); checks += 1;
  const failedLocalTest = await client.callTool({ name: "harmony_project_run", arguments: { operation: "test-local", projectRoot, hvigorPath: "C:/fake/failing-hvigorw.js" } });
  assert.equal(failedLocalTest.isError, true); checks += 1;
  assert.equal(failedLocalTest.structuredContent.ok, false); checks += 1;
  assert.equal(failedLocalTest.structuredContent.data.summary.failures, 1); checks += 1;
  assert.equal(failedLocalTest.structuredContent.data.command.output, undefined); checks += 1;
  assert.ok(JSON.stringify(failedLocalTest).length < 2000); checks += 1;
  const run = await client.callTool({
    name: "harmony_device_run",
    arguments: { steps: [{ action: "tap", xRatio: 0.5, yRatio: 0.5 }], capture: { mode: "final", presentation: "originals" } },
  });
  assert.equal(run.content.filter((item) => item.type === "image").length, 1); checks += 1;
  assert.ok(JSON.stringify(run.structuredContent).length < 2000); checks += 1;
  assert.deepEqual(calls.filter((item) => item.command === "scenario").length, 1); checks += 1;
  const trace = await client.callTool({
    name: "harmony_device_run",
    arguments: { steps: [{ action: "swipe", startXRatio: 0.5, startYRatio: 0.8, endXRatio: 0.5, endYRatio: 0.2, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2, presentation: "contact-sheet" } },
  });
  assert.equal(trace.isError, undefined); checks += 1;
  assert.equal(trace.content.filter((item) => item.type === "image").length, 1); checks += 1;
  assert.ok(JSON.stringify(trace.structuredContent).length < 2000); checks += 1;
  assert.equal(trace.structuredContent.warnings.length, 1); checks += 1;
  const traceCall = calls.find((item) => item.command === "gesture-capture");
  assert.equal(traceCall.args.filter((item) => item === "-OutputDirectory").length, 1); checks += 1;
  assert.equal(traceCall.args.filter((item) => item === "-RecordDurationMs").length, 1); checks += 1;
  assert.ok(traceCall.args.includes("-StartXRatio") && traceCall.args.includes("-EndYRatio")); checks += 1;
  assert.equal(traceCall.args[traceCall.args.indexOf("-RecordDurationMs") + 1], "2500"); checks += 1;
  assert.equal(traceCall.args.includes("-FrameCount"), false); checks += 1;
  const motionTimes = traceCall.args[traceCall.args.indexOf("-CaptureAtMs") + 1].split(",").map(Number);
  assert.deepEqual(motionTimes, [1000, 2000]); checks += 1;
  assert.ok(motionTimes[0] >= 800 && motionTimes.every((time, index) => index === 0 || time - motionTimes[index - 1] >= 800)); checks += 1;
  const conflictingCapture = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "wait", milliseconds: 1 }], capture: { mode: "interval", frameCount: 2, intervalMs: 100 } } });
  assert.equal(conflictingCapture.isError, true); checks += 1;
  const gestureCallsBeforeRejectedMotion = calls.filter((item) => item.command === "gesture-capture").length;
  const shortMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 1500 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(shortMotion.isError, true); checks += 1;
  const fastMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }], capture: { mode: "motion", intervalMs: 700 } } });
  assert.equal(fastMotion.isError, true); checks += 1;
  const denseMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }], durationMs: 2500, capture: { mode: "motion", frameCount: 4 } } });
  assert.equal(denseMotion.isError, true); checks += 1;
  const sparseMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }], capture: { mode: "motion", intervalMs: 1500 } } });
  assert.equal(sparseMotion.isError, true); checks += 1;
  const overBudgetMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 12000 }], capture: { mode: "motion", intervalMs: 1000, before: true, maxFrames: 12 } } });
  assert.equal(overBudgetMotion.isError, true); checks += 1;
  const multipleSwipeMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }, { action: "swipe", startX: 3, startY: 4, endX: 1, endY: 2, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(multipleSwipeMotion.isError, true); checks += 1;
  const delayedMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "wait", milliseconds: 1000 }, { action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(delayedMotion.isError, true); checks += 1;
  const scheduledMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000, atMs: 5000 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(scheduledMotion.isError, true); checks += 1;
  const mixedCoordinates = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, startXRatio: 0.5, startYRatio: 0.8, endXRatio: 0.5, endYRatio: 0.2, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(mixedCoordinates.isError, true); checks += 1;
  const partialMixedCoordinates = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startXRatio: 0.5, startYRatio: 0.8, endXRatio: 0.5, endYRatio: 0.2, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2 } } });
  assert.equal(partialMixedCoordinates.isError, true); checks += 1;
  const excessiveDuration = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 16000 }], capture: { mode: "final" } } });
  assert.equal(excessiveDuration.isError, true); checks += 1;
  const keptMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000, keepMs: 4000 }], capture: { mode: "motion", intervalMs: 3000 } } });
  assert.equal(keptMotion.isError, true); checks += 1;
  assert.equal(calls.filter((item) => item.command === "gesture-capture").length, gestureCallsBeforeRejectedMotion); checks += 1;
  const postRollMotion = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 2000 }], capture: { mode: "motion", frameCount: 2, postRollMs: 5000, presentation: "contact-sheet" } } });
  assert.equal(postRollMotion.isError, undefined); checks += 1;
  const postRollCall = calls.filter((item) => item.command === "gesture-capture").at(-1);
  assert.equal(postRollCall.args[postRollCall.args.indexOf("-CaptureAtMs") + 1], "1000,2000"); checks += 1;
  const wholeFlowShortSwipe = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 300 }, { action: "wait", milliseconds: 1000 }], capture: { mode: "checkpoints", atMs: [200] } } });
  assert.equal(wholeFlowShortSwipe.isError, undefined); checks += 1;
  const foldTrace = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "fold", state: "expanded" }], capture: { mode: "interval", frameCount: 2, presentation: "contact-sheet" } } });
  assert.equal(foldTrace.isError, undefined); checks += 1;
  const foldTraceCall = calls.filter((item) => item.command === "trace-scenario").at(-1);
  assert.equal(foldTraceCall.args[foldTraceCall.args.indexOf("-RecordDurationMs") + 1], "10500"); checks += 1;
  const checkpoints = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "wait", milliseconds: 1 }], capture: { mode: "checkpoints", atMs: [2000], presentation: "contact-sheet" } } });
  assert.equal(checkpoints.isError, undefined); checks += 1;
  const checkpointCall = calls.filter((item) => item.command === "trace-scenario").at(-1);
  assert.equal(checkpointCall.args[checkpointCall.args.indexOf("-RecordDurationMs") + 1], "2000"); checks += 1;
  const overflow = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "wait", milliseconds: 1 }], durationMs: 3600000, capture: { mode: "interval", frameCount: 1, postRollMs: 1 } } });
  assert.equal(overflow.isError, true); checks += 1;
  const onError = await client.callTool({ name: "harmony_device_run", arguments: { steps: [{ action: "wait", milliseconds: 9999 }], capture: { mode: "on-error" } } });
  assert.equal(onError.isError, true); checks += 1;
  assert.equal(onError.content.filter((item) => item.type === "image").length, 1); checks += 1;
  assert.ok(onError.structuredContent.artifacts.some((item) => item.role === "preview")); checks += 1;
  const logs = await client.callTool({ name: "harmony_logs", arguments: { tail: 500 } });
  assert.ok(JSON.stringify(logs.structuredContent).length < 2000); checks += 1;
} finally {
  await client.close();
  await server.close();
  if (previousHdcPath === undefined) delete process.env.HDC_PATH;
  else process.env.HDC_PATH = previousHdcPath;
}
process.stdout.write(`${JSON.stringify({ result: "PASS", checks })}\n`);
