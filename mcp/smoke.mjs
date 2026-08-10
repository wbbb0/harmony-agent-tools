import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { imageContent, serverInstructions, validateMcpEnvironment } from "./server.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "harmony-agent-tools-mcp-"));
const imagePath = path.join(directory, "one-pixel.png");
await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const hdcPath = path.join(directory, "hdc.exe");
const sdkHome = path.join(directory, "sdk");
await writeFile(hdcPath, "test fixture");
await mkdir(sdkHome);
const content = await imageContent(imagePath);
assert.equal(content.type, "image");
assert.equal(content.mimeType, "image/png");
assert.ok(content.data.length > 0);
assert.ok(serverInstructions.length <= 512);
assert.match(serverInstructions, /contact sheet/i);
assert.throws(() => validateMcpEnvironment({}), /HDC_PATH is required[\s\S]*DEVECO_SDK_HOME is required/);
assert.throws(() => validateMcpEnvironment({ HDC_PATH: "hdc", DEVECO_SDK_HOME: sdkHome }), /HDC_PATH must be absolute/);
assert.deepEqual(validateMcpEnvironment({ HDC_PATH: hdcPath, DEVECO_SDK_HOME: sdkHome }), { HDC_PATH: hdcPath, DEVECO_SDK_HOME: sdkHome });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(moduleDirectory, "server.mjs")],
  env: { ...process.env, HDC_PATH: hdcPath, DEVECO_SDK_HOME: sdkHome },
});
const client = new Client({ name: "harmony-agent-tools-smoke", version: "0.2.0" });
let checks = 8;
let metadataChars = 0;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const expected = ["harmony_inspect", "harmony_device_run", "harmony_project_run", "harmony_capture", "harmony_compare", "harmony_logs"];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expected.sort());
  checks += 1;
  for (const tool of tools) {
    assert.ok(tool.outputSchema, `${tool.name} lacks outputSchema`);
    assert.ok(tool.annotations, `${tool.name} lacks annotations`);
    assert.match(tool.description, /Use this/i);
    checks += 3;
  }
  for (const name of ["harmony_device_run", "harmony_project_run"]) {
    assert.equal(tools.find((tool) => tool.name === name).annotations.destructiveHint, true);
    checks += 1;
  }
  const serialized = JSON.stringify(tools);
  metadataChars = serialized.length;
  assert.ok(serialized.length < 18000, `MCP metadata is too large: ${serialized.length}`);
  checks += 1;
  const goldenPrompts = JSON.parse(await readFile(path.join(moduleDirectory, "golden-prompts.json"), "utf8"));
  assert.deepEqual(new Set(goldenPrompts.map((item) => item.kind)), new Set(["direct", "indirect", "negative"]));
  assert.ok(goldenPrompts.every((item) => item.tool === null || expected.includes(item.tool)));
  checks += 2;

  const comparison = await client.callTool({
    name: "harmony_compare",
    arguments: { baselinePath: imagePath, actualPath: imagePath, returnDifference: "never" },
  });
  assert.equal(comparison.isError, undefined);
  assert.equal(comparison.structuredContent.ok, true);
  assert.equal(comparison.structuredContent.data.passed, true);
  assert.equal(comparison.content.filter((item) => item.type === "text").length, 1);
  assert.ok(comparison.content[0].text.length < 200);
  checks += 5;
} finally {
  await transport.close();
}

process.stdout.write(`${JSON.stringify({ result: "PASS", checks, toolCount: 6, metadataChars })}\n`);
