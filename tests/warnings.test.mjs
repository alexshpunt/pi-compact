import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiIntegrationTest, assistantMessage, text, toolCall } from "pi-coding-agent-test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const artifactsDir = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const call = (id, name, args) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

test("context warnings cross thresholds once and rearm after compaction", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-warning-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 0 } }));
  const result = await new PiIntegrationTest({
    testName: "context-warnings", cwd, artifactsDir, extensions: [extension, fileURLToPath(new URL("./fixtures/context-fill.ts", import.meta.url))], tools: ["fill_context", "compact"],
    isolateUserResources: false, environment: { PI_CODING_AGENT_DIR: join(cwd, "agent") }, timeoutMs: 30000,
    conversation: [
      call("large", "fill_context", { size: 420000 }),
      call("small", "fill_context", { size: 65000 }),
      call("small-again", "fill_context", { size: 1 }),
      call("checkpoint", "compact", { summary: "Continue the task." }),
      call("large-again", "fill_context", { size: 420000 }),
      assistantMessage([text("Done.")]),
    ],
  }).run("Read the files and compact.");
  const entries = result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
  const warnings = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "context-warning");
  assert.equal(warnings.length, 3, "one warning per crossed level and one after compaction");
  const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
  assert.equal(entries.slice(0, compactionIndex).filter((entry) => warnings.includes(entry)).length, 2);
  assert.equal(entries.slice(compactionIndex + 1).filter((entry) => warnings.includes(entry)).length, 1);
  const numbers = warnings.map((entry) => [...entry.content.matchAll(/(\d+)%/g)].map((match) => Number(match[1])));
  assert.ok(numbers[0][0] >= 80 && numbers[0][0] < 85);
  assert.ok(numbers[1][0] >= 90 && numbers[1][0] < 100, "a skipped threshold reports the current level");
  for (const [used, remaining] of numbers) assert.ok(Math.abs(100 - used - remaining) <= 1);
  for (const warning of warnings) {
    assert.ok(result.providerRequests.some((request) => request.messages.some((message) =>
      (typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(warning.content)
    )), "warning reaches the model");
  }
});
