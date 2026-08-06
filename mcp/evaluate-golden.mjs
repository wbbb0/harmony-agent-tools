import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(path.join(directory, "golden-prompts.json"), "utf8"));
const cues = [
  ["harmony_project_run", /\b(build|local tests?|device tests?|deploy)\b/i],
  ["harmony_device_run", /\b(taps?|swipe|interaction|sample .*frames?|visually after)\b/i],
  ["harmony_logs", /\b(logs?|failed immediately|diagnostic)\b/i],
  ["harmony_compare", /\b(compare|difference|diff)\b.*\b(images?|screenshots?)\b/i],
  ["harmony_capture", /\b(capture|take)\b.*\b(screen|screenshot)\b/i],
  ["harmony_inspect", /\b(inspect|discover|list)\b.*\b(HarmonyOS|emulator|target|project metadata)\b/i],
];
function selectTool(prompt) {
  if (/\b(explain|review)\b/i.test(prompt) && !/\b(device|project metadata|logs?|screenshot|build|test|deploy)\b/i.test(prompt)) return null;
  return cues.find(([, pattern]) => pattern.test(prompt))?.[0] || null;
}

for (const item of cases) assert.equal(selectTool(item.prompt), item.tool, `${item.kind} prompt routed incorrectly: ${item.prompt}`);
process.stdout.write(`${JSON.stringify({ result: "PASS", cases: cases.length })}\n`);
