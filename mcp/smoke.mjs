import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { imageContent } from "./server.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "harmony-agent-tools-mcp-"));
const imagePath = path.join(directory, "one-pixel.png");
await writeFile(
  imagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const content = await imageContent(imagePath);
assert.equal(content.type, "image");
assert.equal(content.mimeType, "image/png");
assert.ok(content.data.length > 0);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(moduleDirectory, "server.mjs")],
});
const client = new Client({
  name: "harmony-agent-tools-smoke",
  version: "0.1.0",
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "harmony_display",
    "harmony_wait_display",
    "harmony_fold",
    "harmony_rotate",
  ]) {
    assert.ok(names.has(name), `MCP tool was not registered: ${name}`);
  }
} finally {
  await transport.close();
}

process.stdout.write(`${JSON.stringify({ result: "PASS", checks: 7 })}\n`);
