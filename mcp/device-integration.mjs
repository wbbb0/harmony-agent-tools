import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const emulatorName = process.argv[2] || "Pura 90";
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(directory, "server.mjs")],
  env: childEnvironment,
});
const client = new Client({
  name: "harmony-agent-tools-device-integration",
  version: "0.2.0",
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "harmony_capture",
    arguments: { emulatorName },
  });
  const image = result.content.find((item) => item.type === "image");
  assert.ok(
    image,
    `MCP response did not include image content: ${JSON.stringify(result)}`,
  );
  assert.equal(image.mimeType, "image/jpeg");
  assert.ok(image.data.length > 1000, "MCP image payload is unexpectedly small.");
  const tapResult = await client.callTool({
    name: "harmony_device_run",
    arguments: {
      emulatorName,
      steps: [{ action: "tap", xRatio: 0.5, yRatio: 0.5 }],
      capture: { mode: "final", presentation: "originals" },
    },
  });
  const tapImage = tapResult.content.find((item) => item.type === "image");
  assert.ok(
    tapImage,
    `Normalized tap response did not include image content: ${JSON.stringify(tapResult)}`,
  );
  assert.equal(tapImage.mimeType, "image/jpeg");
  const traceResult = await client.callTool({
    name: "harmony_device_run",
    arguments: {
      emulatorName,
      steps: [{ action: "wait", milliseconds: 600 }],
      durationMs: 900,
      capture: {
        mode: "interval",
        frameCount: 3,
        before: true,
        maxFrames: 4,
        presentation: "contact-sheet",
      },
    },
  });
  const traceImage = traceResult.content.find((item) => item.type === "image");
  assert.ok(
    traceImage,
    `MCP trace response did not include a contact sheet: ${JSON.stringify(traceResult)}`,
  );
  assert.equal(traceResult.structuredContent.data.captureMode, "interval");
  assert.ok(
    traceResult.structuredContent.artifacts.some((item) => item.role === "frames"),
    "MCP trace response did not retain a frame manifest.",
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "PASS",
      emulatorName,
      mimeType: image.mimeType,
      base64Bytes: image.data.length,
      normalizedTapImageBytes: tapImage.data.length,
      traceContactSheetBytes: traceImage.data.length,
      traceFrameCount: traceResult.structuredContent.data.frameCount,
      traceDroppedFrames: traceResult.structuredContent.data.droppedFrames,
    })}\n`,
  );
} finally {
  await transport.close();
}
