import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import JSON5 from "json5";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(serverDirectory, "..");
const cliPath = path.join(toolRoot, "hdc-agent.ps1");
const artifactsRoot = path.join(toolRoot, "artifacts", "mcp");
const MOTION_CAPTURE_MIN_INTERVAL_MS = 800;
const MOTION_CAPTURE_RECOMMENDED_INTERVAL_MS = 1000;
const MOTION_CAPTURE_MIN_SWIPE_DURATION_MS = 2000;
export const serverInstructions = "Inspect unknown targets or projects first. Prefer one harmony_device_run scenario over repeated actions. Use capture.mode motion for one swipe with durationMs >= 2000 and cadence >= 800ms (1000ms recommended); use final for shorter swipes. Prefer contact sheets. Use harmony_project_run for build/test/deploy and harmony_logs for bounded diagnostics. Follow artifact paths only when needed.";

const artifactSchema = z.object({
  kind: z.string(),
  path: z.string(),
  role: z.string().optional(),
});
const outputSchema = {
  ok: z.boolean(),
  action: z.string(),
  summary: z.string(),
  runId: z.string(),
  warnings: z.array(z.string()),
  diagnosticsPath: z.string().nullable(),
  artifacts: z.array(artifactSchema),
  data: z.record(z.string(), z.unknown()),
};

function runId() {
  return `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}

function deviceArguments(input) {
  if (input.target && input.emulatorName) throw new Error("Specify either target or emulatorName, not both.");
  const args = [];
  if (process.env.HDC_PATH) args.push("-HdcPath", process.env.HDC_PATH);
  if (input.target) args.push("-Target", input.target);
  if (input.emulatorName) args.push("-EmulatorName", input.emulatorName);
  return args;
}

function configuredHdcArguments() {
  return process.env.HDC_PATH ? ["-HdcPath", process.env.HDC_PATH] : [];
}

function tailText(value, max = 6000) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export async function invokeCli(command, args = [], options = {}) {
  const id = options.runId || runId();
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cliPath, command, ...args,
    ], {
      cwd: toolRoot,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD" },
    });
    if (stderr.trim()) throw Object.assign(new Error(stderr.trim()), { stderr, stdout });
    return JSON.parse(stdout);
  } catch (error) {
    const directory = path.join(artifactsRoot, "runs", id);
    await mkdir(directory, { recursive: true });
    const diagnosticsPath = path.join(directory, "error.log");
    const detail = tailText(error.stderr || error.stdout || error.message);
    await writeFile(diagnosticsPath, `${command} failed\n${detail}\n`, "utf8");
    const wrapped = new Error(`${command} failed: ${detail}`);
    wrapped.diagnosticsPath = diagnosticsPath;
    throw wrapped;
  }
}

function uniqueArtifact(id, name) {
  return path.join(artifactsRoot, "runs", id, name);
}

function imageMimeType(imagePath) {
  return path.extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

export async function imageContent(imagePath) {
  const absolutePath = path.resolve(imagePath);
  const data = await readFile(absolutePath);
  return { type: "image", data: data.toString("base64"), mimeType: imageMimeType(absolutePath) };
}

function baseResult(action, summary, id, data = {}, artifacts = [], warnings = []) {
  return { ok: true, action, summary, runId: id, warnings, diagnosticsPath: null, artifacts, data };
}

function compactArray(values, limit, project = (value) => value) {
  const source = Array.isArray(values) ? values : [];
  return { values: source.slice(0, limit).map(project), truncated: source.length > limit };
}

async function createPreview(invoke, id, sourcePath, name = "preview.jpeg") {
  const previewPath = uniqueArtifact(id, name);
  return invoke("resize-image", ["-ImagePath", sourcePath, "-OutputPath", previewPath, "-MaxWidth", "960", "-MaxHeight", "1600"], { runId: id });
}

async function toolResponse(result, imagePaths = []) {
  const content = [{ type: "text", text: result.summary }];
  for (const imagePath of imagePaths) content.push(await imageContent(imagePath));
  return { structuredContent: result, content };
}

function register(server, name, definition, handler) {
  server.registerTool(name, { ...definition, outputSchema }, async (input) => {
    const id = runId();
    try {
      return await handler(input, id);
    } catch (error) {
      const result = {
        ok: false,
        action: name,
        summary: tailText(error.message, 700),
        runId: id,
        warnings: [],
        diagnosticsPath: error.diagnosticsPath || null,
        artifacts: error.artifacts || [],
        data: error.data || {},
      };
      const content = [{ type: "text", text: result.summary }];
      for (const imagePath of error.imagePaths || []) content.push(await imageContent(imagePath));
      return { isError: true, structuredContent: result, content };
    }
  });
}

const targetSchema = {
  target: z.string().min(1).optional(),
  emulatorName: z.string().min(1).optional(),
};

async function readJson5(filePath) {
  return JSON5.parse(await readFile(filePath, "utf8"));
}

async function discoverProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const profilePath = path.join(root, "build-profile.json5");
  if (!existsSync(profilePath)) throw new Error(`Not a HarmonyOS project: ${profilePath} is missing.`);
  const profile = await readJson5(profilePath);
  const products = (profile.app?.products || []).map((item) => item.name).filter(Boolean);
  const modules = (profile.modules || []).map((item) => ({ name: item.name, srcPath: item.srcPath })).filter((item) => item.name);
  let bundle = "";
  const appConfig = path.join(root, "AppScope", "app.json5");
  if (existsSync(appConfig)) bundle = (await readJson5(appConfig)).app?.bundleName || "";
  const abilities = [];
  for (const module of modules) {
    const moduleRoot = path.resolve(root, module.srcPath || module.name);
    const relativeModuleRoot = path.relative(root, moduleRoot);
    if (relativeModuleRoot.startsWith("..") || path.isAbsolute(relativeModuleRoot)) throw new Error(`Module srcPath escapes projectRoot: ${module.srcPath || module.name}`);
    const moduleConfig = path.join(moduleRoot, "src", "main", "module.json5");
    if (!existsSync(moduleConfig)) continue;
    const config = (await readJson5(moduleConfig)).module || {};
    for (const ability of config.abilities || []) abilities.push({ module: module.name, name: ability.name });
    if (config.mainElement && !abilities.some((item) => item.module === module.name && item.name === config.mainElement)) {
      abilities.push({ module: module.name, name: config.mainElement });
    }
  }
  return { root, products, modules, bundle, abilities };
}

function scenarioStep(step) {
  const result = { action: step.action };
  for (const key of ["x", "y", "xRatio", "yRatio", "pressMs", "startX", "startY", "endX", "endY", "startXRatio", "startYRatio", "endXRatio", "endYRatio", "durationMs", "keepMs", "milliseconds", "delayMs", "state", "rotation", "timeoutMs", "atMs"]) {
    if (step[key] !== undefined) result[key] = step[key];
  }
  return result;
}

function scenarioTiming(steps) {
  let cursorMs = 0;
  const swipeWindows = [];
  for (const step of steps) {
    if (step.atMs !== undefined) cursorMs = Math.max(cursorMs, step.atMs);
    const startMs = cursorMs;
    if (step.action === "wait") cursorMs += step.milliseconds || 0;
    else if (step.action === "tap") cursorMs += step.pressMs || 100;
    else if (step.action === "swipe") cursorMs += (step.durationMs || 300) + (step.keepMs || 0);
    else if (step.action === "waitDisplay") cursorMs += step.timeoutMs || 5000;
    else if (step.action === "fold" || step.action === "rotate") cursorMs += 10000;
    if (step.action === "swipe") swipeWindows.push({ startMs, endMs: startMs + (step.durationMs || 300), durationMs: (step.durationMs || 300) });
  }
  return { estimatedDurationMs: cursorMs, swipeWindows };
}

function resolveMotionCaptureTimes(input, minimumDurationMs) {
  if (input.capture.mode !== "motion") return null;
  if (input.capture.atMs.length > 0) throw new Error("capture.atMs is not used with capture.mode='motion'; use intervalMs or frameCount.");
  if (input.capture.frameCount !== undefined && input.capture.intervalMs !== undefined) throw new Error("capture.frameCount and capture.intervalMs are mutually exclusive.");
  const timing = scenarioTiming(input.steps);
  if (input.steps.length !== 1 || timing.swipeWindows.length !== 1) throw new Error("capture.mode='motion' requires the scenario to contain exactly one swipe step; use interval or checkpoints for a whole flow.");
  if (input.steps[0].atMs !== undefined) throw new Error("capture.mode='motion' does not accept step.atMs; the direct swipe starts when the trace begins.");
  const window = timing.swipeWindows[0];
  if (window.durationMs < MOTION_CAPTURE_MIN_SWIPE_DURATION_MS) {
    throw new Error(`Swipe motion capture requires durationMs >= ${MOTION_CAPTURE_MIN_SWIPE_DURATION_MS}; use capture.mode='final' for a normal short swipe.`);
  }
  if (input.durationMs !== undefined && input.durationMs < minimumDurationMs) {
    throw new Error(`Swipe motion capture durationMs must cover the full scenario (${minimumDurationMs}ms including startup allowance).`);
  }
  let times;
  if (input.capture.frameCount !== undefined) {
    if (input.capture.frameCount < 2) throw new Error("Swipe motion capture requires at least two sampled frames.");
    const spacingMs = window.durationMs / input.capture.frameCount;
    if (spacingMs < MOTION_CAPTURE_MIN_INTERVAL_MS) {
      throw new Error(`Swipe motion capture frameCount is too dense; keep at least ${MOTION_CAPTURE_MIN_INTERVAL_MS}ms between samples (${MOTION_CAPTURE_RECOMMENDED_INTERVAL_MS}ms recommended).`);
    }
    times = Array.from({ length: input.capture.frameCount }, (_, index) => window.startMs + Math.round(window.durationMs * (index + 1) / input.capture.frameCount));
  } else {
    const intervalMs = input.capture.intervalMs || MOTION_CAPTURE_RECOMMENDED_INTERVAL_MS;
    if (intervalMs < MOTION_CAPTURE_MIN_INTERVAL_MS) {
      throw new Error(`Swipe motion capture intervalMs must be at least ${MOTION_CAPTURE_MIN_INTERVAL_MS} (${MOTION_CAPTURE_RECOMMENDED_INTERVAL_MS} recommended).`);
    }
    times = [];
    for (let time = window.startMs + intervalMs; time <= window.endMs; time += intervalMs) times.push(time);
  }
  if (times.length < 2) throw new Error("Swipe motion capture settings produce fewer than two frames inside the swipe window; reduce intervalMs or increase durationMs.");
  const totalFrames = times.length + (input.capture.before ? 1 : 0);
  if (totalFrames > input.capture.maxFrames) throw new Error(`Swipe motion capture requests ${totalFrames} frames, exceeding maxFrames=${input.capture.maxFrames}.`);
  return times;
}

function captureArguments(capture, durationMs, outputDirectory, sheetPath, motionTimes = null) {
  const args = ["-OutputDirectory", outputDirectory, "-RecordDurationMs", String(durationMs), "-MaxFrames", String(capture.maxFrames), "-MaxCaptureConcurrency", String(capture.maxConcurrency)];
  if (capture.before) args.push("-CaptureBefore");
  if (capture.mode === "motion") {
    args.push("-CaptureAtMs", motionTimes.join(","));
  } else if (capture.mode === "interval") {
    if (capture.frameCount) args.push("-FrameCount", String(capture.frameCount));
    else args.push("-CaptureIntervalMs", String(capture.intervalMs || 500));
  } else {
    args.push("-CaptureAtMs", capture.atMs.join(","));
  }
  if (sheetPath) args.push("-ContactSheetPath", sheetPath, "-ContactSheetColumns", String(capture.columns || 0));
  return args;
}

function gestureArguments(step) {
  const args = [];
  const pixelKeys = ["startX", "startY", "endX", "endY"];
  const ratioKeys = ["startXRatio", "startYRatio", "endXRatio", "endYRatio"];
  const pixelCount = pixelKeys.filter((key) => step[key] !== undefined).length;
  const ratioCount = ratioKeys.filter((key) => step[key] !== undefined).length;
  if (pixelCount === pixelKeys.length && ratioCount === 0) {
    for (const key of pixelKeys) args.push(`-${key[0].toUpperCase()}${key.slice(1)}`, String(step[key]));
  } else if (ratioCount === ratioKeys.length && pixelCount === 0) {
    for (const key of ratioKeys) args.push(`-${key[0].toUpperCase()}${key.slice(1)}`, String(step[key]));
  } else {
    throw new Error("Swipe must provide exactly one complete pixel or normalized start/end coordinate set; do not mix coordinate families.");
  }
  args.push("-DurationMs", String(step.durationMs || 300), "-KeepMs", String(step.keepMs || 0));
  return args;
}

export function createHarmonyServer({ invoke = invokeCli } = {}) {
  const server = new McpServer({ name: "harmony-agent-tools", version: "0.2.0" }, { instructions: serverInstructions });

  register(server, "harmony_inspect", {
    description: "Use this to discover HarmonyOS tools, targets, display, project package candidates, or safe project metadata before acting. Do not use it for logs or mutations.",
    inputSchema: { ...targetSchema, scope: z.enum(["environment", "device", "project", "all"]).default("environment"), projectRoot: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, id) => {
    const data = {};
    const warnings = [];
    if (["environment", "all"].includes(input.scope)) {
      const healthArguments = [];
      if (input.projectRoot) healthArguments.push("-ProjectRoot", path.resolve(input.projectRoot));
      if (process.env.HDC_PATH) healthArguments.push("-HdcPath", process.env.HDC_PATH);
      const health = await invoke("doctor", healthArguments, { runId: id });
      const checks = compactArray(health.checks, 8, (item) => ({ name: item.name, status: item.status, detail: tailText(item.detail || item.message, 80) }));
      data.health = { healthy: health.healthy ?? null, checks: checks.values };
      if (checks.truncated) warnings.push("Environment checks were truncated to 8 entries.");
    }
    if (["device", "all"].includes(input.scope)) {
      const targets = compactArray(await invoke("targets", configuredHdcArguments(), { runId: id }), 8, (item) => ({ target: item.target || item.id, state: item.state, model: item.model }));
      const emulators = compactArray(await invoke("emulators", configuredHdcArguments(), { runId: id }), 8, (item) => ({ name: item.name, target: item.target, state: item.state }));
      data.targets = targets.values;
      data.emulators = emulators.values;
      if (targets.truncated || emulators.truncated) warnings.push("Device candidates were truncated to 8 entries.");
      if (input.target || input.emulatorName) {
        data.display = await invoke("display", deviceArguments(input), { runId: id });
      }
    }
    if (["project", "all"].includes(input.scope)) {
      if (!input.projectRoot) throw new Error("projectRoot is required for project or all inspection.");
      const project = await discoverProject(input.projectRoot);
      const modules = compactArray(project.modules, 8, (item) => ({ name: item.name, srcPath: item.srcPath }));
      const abilities = compactArray(project.abilities, 8);
      const products = compactArray(project.products, 8);
      const packages = compactArray(await invoke("packages", ["-ProjectRoot", project.root, "-IncludeTests"], { runId: id }), 6, (item) => ({ path: item.path, module: item.module, test: item.test }));
      data.project = { root: project.root, bundle: project.bundle, products: products.values, modules: modules.values, abilities: abilities.values, packages: packages.values };
      if (packages.truncated || modules.truncated || abilities.truncated || products.truncated) warnings.push("Project candidates were truncated to preserve the result budget.");
    }
    return toolResponse(baseResult("inspect", `Inspected ${input.scope} context.`, id, data, [], warnings));
  });

  const stepSchema = z.object({
    action: z.enum(["tap", "swipe", "wait", "fold", "rotate", "waitDisplay"]),
    x: z.number().int().optional(), y: z.number().int().optional(), xRatio: z.number().min(0).max(1).optional(), yRatio: z.number().min(0).max(1).optional(),
    pressMs: z.number().int().min(1).max(450).optional(),
    startX: z.number().int().optional(), startY: z.number().int().optional(), endX: z.number().int().optional(), endY: z.number().int().optional(),
    startXRatio: z.number().min(0).max(1).optional(), startYRatio: z.number().min(0).max(1).optional(), endXRatio: z.number().min(0).max(1).optional(), endYRatio: z.number().min(0).max(1).optional(),
    durationMs: z.number().int().min(1).max(15000).optional(), keepMs: z.number().int().min(0).max(60000).optional(), milliseconds: z.number().int().min(0).max(3600000).optional(),
    state: z.enum(["folded", "half", "expanded", "dual-expanded"]).optional(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), timeoutMs: z.number().int().optional(), atMs: z.number().int().nonnegative().optional(),
  });
  const captureSchema = z.object({
    mode: z.enum(["none", "final", "motion", "interval", "checkpoints", "on-error"]).default("final"),
    intervalMs: z.number().int().min(50).max(60000).optional().describe("Sampling interval; motion mode requires at least 800ms and 1000ms is recommended."), frameCount: z.number().int().min(1).max(60).optional(), atMs: z.array(z.number().int().nonnegative()).default([]),
    before: z.boolean().default(false), postRollMs: z.number().int().min(0).max(60000).default(0), maxFrames: z.number().int().min(1).max(60).default(12), maxConcurrency: z.number().int().min(1).max(4).default(2),
    presentation: z.enum(["contact-sheet", "originals", "both", "manifest-only"]).default("contact-sheet"), columns: z.number().int().min(0).max(12).default(0), maxReturnedImages: z.number().int().min(0).max(8).default(4),
  }).default({});

  register(server, "harmony_device_run", {
    description: "Use this to execute an ordered HarmonyOS interaction as one scenario. Use capture mode motion for exactly one swipe with durationMs >= 2000 and samples at least 800ms apart (1000ms recommended); use final for shorter swipes, or interval/checkpoints for whole-flow sampling. Prefer contact sheets.",
    inputSchema: { ...targetSchema, steps: z.array(stepSchema).min(1).max(100), capture: captureSchema, durationMs: z.number().int().min(1).max(3600000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, id) => {
    const directory = path.join(artifactsRoot, "runs", id);
    const scenarioPath = path.join(directory, "scenario.json");
    const timing = scenarioTiming(input.steps);
    const estimatedDurationMs = timing.estimatedDurationMs;
    const minimumDurationMs = Math.max(1000, estimatedDurationMs + 500);
    let baseDurationMs = input.durationMs || minimumDurationMs;
    if (input.capture.mode === "checkpoints" && input.capture.atMs.length > 0) baseDurationMs = Math.max(baseDurationMs, Math.max(...input.capture.atMs));
    const durationMs = baseDurationMs + input.capture.postRollMs;
    if (durationMs > 3600000) throw new Error("The capture duration plus post-roll must not exceed 3600000ms.");
    const motionTimes = resolveMotionCaptureTimes(input, minimumDurationMs);
    await mkdir(directory, { recursive: true });
    await writeFile(scenarioPath, JSON.stringify({ steps: input.steps.map(scenarioStep) }, null, 2));
    const scenarioArgs = ["-ScenarioPath", scenarioPath, ...deviceArguments(input)];
    let raw;
    let imagePaths = [];
    const artifacts = [{ kind: "manifest", path: scenarioPath, role: "scenario" }];
    try {
      if (["motion", "interval", "checkpoints"].includes(input.capture.mode)) {
        if (input.capture.frameCount !== undefined && input.capture.intervalMs !== undefined) throw new Error("capture.frameCount and capture.intervalMs are mutually exclusive.");
        if (input.capture.mode === "checkpoints" && input.capture.atMs.length === 0) throw new Error("capture.atMs requires at least one checkpoint.");
        const sheetPath = ["contact-sheet", "both"].includes(input.capture.presentation) ? path.join(directory, "trace-contact-sheet.jpg") : "";
        if (input.capture.mode === "motion") {
          raw = await invoke("gesture-capture", [...gestureArguments(input.steps[0]), ...deviceArguments(input), ...captureArguments(input.capture, durationMs, path.join(directory, "frames"), sheetPath, motionTimes)], { runId: id });
        } else {
          raw = await invoke("trace-scenario", [...scenarioArgs, ...captureArguments(input.capture, durationMs, path.join(directory, "frames"), sheetPath)], { runId: id });
        }
        const frames = raw.frames || raw.captures || [];
        if (raw.manifestPath) artifacts.push({ kind: "manifest", path: raw.manifestPath, role: "frames" });
        if (frames.length > 0) artifacts.push({ kind: "directory", path: path.dirname(frames[0].path), role: "original-frames" });
        if (raw.contactSheet?.path) {
          artifacts.push({ kind: "image", path: raw.contactSheet.path, role: "contact-sheet" });
          imagePaths.push(raw.contactSheet.path);
        }
        if (["originals", "both"].includes(input.capture.presentation)) imagePaths.push(...frames.slice(0, input.capture.maxReturnedImages).map((frame) => frame.path));
      } else {
        raw = await invoke("scenario", [...scenarioArgs, "-OutputDirectory", path.join(directory, "scenario")], { runId: id });
        if (input.capture.mode === "final") {
          const screenPath = path.join(directory, "final.jpeg");
          const screen = await invoke("screenshot", [...deviceArguments(input), "-OutputPath", screenPath], { runId: id });
          artifacts.push({ kind: "image", path: screen.path, role: "final" });
          if (input.capture.presentation !== "manifest-only") {
            const preview = await createPreview(invoke, id, screen.path, "final-preview.jpeg");
            artifacts.push({ kind: "image", path: preview.path, role: "preview" });
            imagePaths.push(preview.path);
          }
        }
      }
    } catch (error) {
      if (input.capture.mode === "on-error") {
        const screenPath = path.join(directory, "error.jpeg");
        try {
          const screen = await invoke("screenshot", [...deviceArguments(input), "-OutputPath", screenPath], { runId: id });
          const preview = await createPreview(invoke, id, screen.path, "error-preview.jpeg");
          error.artifacts = [{ kind: "image", path: screen.path, role: "on-error" }, { kind: "image", path: preview.path, role: "preview" }];
          error.imagePaths = [preview.path];
          error.data = { captureMode: "on-error" };
        } catch { /* retain original failure */ }
      }
      throw error;
    }
    const resultFrames = raw.frames || raw.captures || [];
    const actualStarts = resultFrames.filter((frame) => frame.phase !== "before" && frame.actualStartMs !== null && frame.actualStartMs !== undefined).map((frame) => frame.actualStartMs);
    const effectiveIntervalMs = actualStarts.length > 1 ? Math.round((actualStarts.at(-1) - actualStarts[0]) / (actualStarts.length - 1)) : null;
    const data = { stepCount: input.steps.length, captureMode: input.capture.mode, frameCount: resultFrames.length || (imagePaths.length ? 1 : 0), droppedFrames: raw.droppedFrames?.length || 0, maxLatenessMs: raw.maxLatenessMs || 0, effectiveIntervalMs };
    const warnings = data.droppedFrames > 0 ? [`Dropped ${data.droppedFrames} frame(s) because snapshot concurrency was saturated${effectiveIntervalMs === null ? "." : `; effective captured interval was about ${effectiveIntervalMs}ms.`}`] : [];
    return toolResponse(baseResult("deviceRun", `Executed ${input.steps.length} device steps; captured ${data.frameCount} frame(s).`, id, data, artifacts, warnings), imagePaths);
  });

  register(server, "harmony_project_run", {
    description: "Use this for HarmonyOS build, local test, device test, or deploy. It safely discovers project defaults when unique; provide overrides when ambiguous.",
    inputSchema: { ...targetSchema, operation: z.enum(["build", "test-local", "test-device", "deploy"]), projectRoot: z.string().min(1), product: z.string().min(1).optional(), module: z.string().min(1).optional(), testModule: z.string().min(1).optional(), bundle: z.string().min(1).optional(), ability: z.string().min(1).optional(), packagePath: z.string().min(1).optional(), hvigorPath: z.string().min(1).optional().describe("Hvigor wrapper for test-local/test-device only."), hvigorNodePath: z.string().min(1).optional().describe("Node executable for a JavaScript Hvigor wrapper in test-local/test-device."), skipBuild: z.boolean().default(false), captureAfterStart: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, id) => {
    const project = await discoverProject(input.projectRoot);
    if (!input.product && project.products.length !== 1) throw new Error(project.products.length === 0 ? "No product was discovered; provide product." : `Multiple products found (${project.products.join(", ")}); provide product.`);
    if (!input.module && project.modules.length !== 1) throw new Error(project.modules.length === 0 ? "No module was discovered; provide module." : `Multiple modules found (${project.modules.map((item) => item.name).join(", ")}); provide module.`);
    const product = input.product || project.products[0];
    const moduleName = input.module || project.modules[0].name;
    const bundle = input.bundle || project.bundle;
    const moduleAbilities = project.abilities.filter((item) => item.module === moduleName);
    if (input.operation === "deploy" && !input.ability && moduleAbilities.length > 1) throw new Error(`Multiple abilities found (${moduleAbilities.map((item) => item.name).join(", ")}); provide ability.`);
    const abilityEntry = input.ability ? { name: input.ability, module: moduleName } : moduleAbilities[0];
    const args = ["-ProjectRoot", project.root, "-Product", product];
    if (input.operation === "build") args.push("-Modules", moduleName);
    else args.push("-Module", moduleName);
    if (["test-local", "test-device"].includes(input.operation)) {
      if (input.hvigorPath) args.push("-HvigorPath", path.resolve(input.hvigorPath));
      if (input.hvigorNodePath) args.push("-HvigorNodePath", path.resolve(input.hvigorNodePath));
    }
    if (input.target || input.emulatorName) args.push(...deviceArguments(input));
    if (input.skipBuild) args.push("-SkipBuild");
    if (input.operation === "test-device") {
      if (!bundle) throw new Error("Unable to discover bundle; provide bundle.");
      args.push("-Bundle", bundle, "-TestModule", input.testModule || "entry_test");
    }
    if (input.operation === "deploy") {
      if (!bundle || !abilityEntry?.name) throw new Error("Unable to discover bundle/ability; provide overrides.");
      let packagePath = input.packagePath;
      if (!input.skipBuild) {
        await invoke("build", ["-ProjectRoot", project.root, "-Product", product, "-Modules", moduleName], { runId: id });
        if (!args.includes("-SkipBuild")) args.push("-SkipBuild");
      }
      if (!packagePath) {
        if (input.skipBuild) throw new Error("packagePath is required for deploy when skipBuild is true.");
        const packages = await invoke("packages", ["-ProjectRoot", project.root], { runId: id });
        if (packages.length !== 1) throw new Error(`Expected one deployable package, found ${packages.length}; provide packagePath.`);
        packagePath = packages[0].path;
      }
      args.push("-PackagePath", path.resolve(packagePath), "-Bundle", bundle, "-Ability", abilityEntry.name);
    }
    const raw = await invoke(input.operation, args, { runId: id });
    const artifacts = [];
    const data = { operation: input.operation, product, module: moduleName, bundle: bundle || null, passed: raw.passed ?? null, exitCode: raw.exitCode ?? raw.build?.exitCode ?? null };
    const imagePaths = [];
    if (input.operation === "deploy" && input.captureAfterStart) {
      const screenPath = uniqueArtifact(id, "started.jpeg");
      const screen = await invoke("screenshot", [...deviceArguments(input), "-OutputPath", screenPath], { runId: id });
      artifacts.push({ kind: "image", path: screen.path, role: "after-start" });
      const preview = await createPreview(invoke, id, screen.path, "started-preview.jpeg");
      artifacts.push({ kind: "image", path: preview.path, role: "preview" });
      imagePaths.push(preview.path);
    }
    return toolResponse(baseResult("projectRun", `${input.operation} completed${data.passed === null ? "" : data.passed ? " and passed" : " but did not pass"}.`, id, data, artifacts), imagePaths);
  });

  register(server, "harmony_capture", {
    description: "Use this for a single HarmonyOS screenshot. Request preview to return a smaller image while preserving the original artifact path.",
    inputSchema: { ...targetSchema, outputPath: z.string().min(1).optional(), delayMs: z.number().int().min(0).max(3600000).default(0), crop: z.object({ xRatio: z.number().min(0).max(1), yRatio: z.number().min(0).max(1), widthRatio: z.number().gt(0).max(1), heightRatio: z.number().gt(0).max(1) }).optional(), preview: z.boolean().default(true), previewMaxWidth: z.number().int().min(64).max(4096).default(960), previewMaxHeight: z.number().int().min(64).max(4096).default(1600) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, id) => {
    const outputPath = path.resolve(input.outputPath || uniqueArtifact(id, "screen.jpeg"));
    const raw = await invoke("screenshot", [...deviceArguments(input), "-OutputPath", outputPath, "-DelayMs", String(input.delayMs)], { runId: id });
    const artifacts = [{ kind: "image", path: raw.path, role: "original" }];
    let returnedPath = raw.path;
    if (input.crop) {
      if (input.crop.xRatio + input.crop.widthRatio > 1 || input.crop.yRatio + input.crop.heightRatio > 1) throw new Error("Normalized crop must remain within the inclusive 0..1 image bounds.");
      const info = await invoke("image-info", ["-ImagePath", raw.path], { runId: id });
      const x = Math.min(info.width - 1, Math.round(input.crop.xRatio * (info.width - 1)));
      const y = Math.min(info.height - 1, Math.round(input.crop.yRatio * (info.height - 1)));
      const width = Math.max(1, Math.min(info.width - x, Math.round(input.crop.widthRatio * info.width)));
      const height = Math.max(1, Math.min(info.height - y, Math.round(input.crop.heightRatio * info.height)));
      const cropPath = uniqueArtifact(id, "crop.png");
      const crop = await invoke("crop-image", ["-ImagePath", raw.path, "-OutputPath", cropPath, "-CropX", String(x), "-CropY", String(y), "-CropWidth", String(width), "-CropHeight", String(height)], { runId: id });
      returnedPath = crop.path;
      artifacts.push({ kind: "image", path: crop.path, role: "crop" });
    }
    if (input.preview) {
      const previewPath = uniqueArtifact(id, "preview.jpeg");
      const preview = await invoke("resize-image", ["-ImagePath", returnedPath, "-OutputPath", previewPath, "-MaxWidth", String(input.previewMaxWidth), "-MaxHeight", String(input.previewMaxHeight)], { runId: id });
      artifacts.push({ kind: "image", path: preview.path, role: "preview" });
      returnedPath = preview.path;
    }
    return toolResponse(baseResult("capture", "Captured the HarmonyOS display.", id, { returned: input.preview ? "preview" : "original" }, artifacts), [returnedPath]);
  });

  register(server, "harmony_compare", {
    description: "Use this to compare two local images with bounded thresholds. A difference image is returned only on failure by default.",
    inputSchema: { baselinePath: z.string().min(1), actualPath: z.string().min(1), pixelTolerance: z.number().int().min(0).max(255).default(0), maxDifferenceRatio: z.number().min(0).max(1).default(0), maxMeanError: z.number().min(0).max(1).default(0), returnDifference: z.enum(["on-failure", "always", "never"]).default("on-failure") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, id) => {
    const differencePath = uniqueArtifact(id, "difference.png");
    const raw = await invoke("compare-images", ["-BaselinePath", path.resolve(input.baselinePath), "-ActualPath", path.resolve(input.actualPath), "-DifferencePath", differencePath, "-PixelTolerance", String(input.pixelTolerance), "-MaxDifferenceRatio", String(input.maxDifferenceRatio), "-MaxMeanError", String(input.maxMeanError)], { runId: id });
    const shouldReturn = input.returnDifference === "always" || (input.returnDifference === "on-failure" && !raw.passed);
    const artifacts = raw.difference ? [{ kind: "image", path: raw.difference, role: "difference" }] : [];
    return toolResponse(baseResult("compare", raw.passed ? "Images match configured thresholds." : "Images differ beyond configured thresholds.", id, { passed: raw.passed, metrics: raw.metrics, thresholds: raw.thresholds }, artifacts), shouldReturn && raw.difference ? [raw.difference] : []);
  });

  register(server, "harmony_logs", {
    description: "Use this for bounded HarmonyOS log diagnostics after a failure. Keep tail small and filter by bundle, level, keyword, or time range.",
    inputSchema: { ...targetSchema, bundle: z.string().min(1).optional(), tail: z.number().int().min(1).max(500).default(120), level: z.string().optional(), keyword: z.string().optional(), from: z.string().optional(), to: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, id) => {
    const args = [...deviceArguments(input), "-Tail", String(input.tail)];
    for (const [key, flag] of [["bundle", "-Bundle"], ["level", "-Level"], ["keyword", "-Keyword"], ["from", "-From"], ["to", "-To"]]) if (input[key]) args.push(flag, input[key]);
    const raw = await invoke("logs", args, { runId: id });
    const sourceLines = Array.isArray(raw) ? raw : raw.lines || raw.output || [];
    const lines = [];
    let characters = 0;
    for (const line of sourceLines.slice().reverse()) {
      const compact = tailText(line, 300);
      if (lines.length >= 30 || characters + compact.length > 1400) break;
      lines.unshift(compact);
      characters += compact.length;
    }
    const warnings = lines.length < sourceLines.length ? [`Returned ${lines.length} of ${sourceLines.length} matching lines to preserve the result budget.`] : [];
    return toolResponse(baseResult("logs", `Read ${lines.length} bounded filtered log line(s).`, id, { lines }, [], warnings));
  });

  return server;
}

export const server = createHarmonyServer();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(artifactsRoot, { recursive: true });
  await server.connect(new StdioServerTransport());
}
