import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  PiIntegrationTest, assistantMessage, text, toolCall,
  getToolExecution, getToolExecutionDetails,
} from "pi-coding-agent-test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const request = "Complete the planning milestone, compact, and continue implementation.";
const continuation = "\nPlanning is complete.\nNEXT: write result.txt containing done.  \n";
const isContinuation = (entry) => entry.type === "custom_message" && entry.customType === "compact-continuation";
const call = (id, name, args) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
const content = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");

async function run(t, name, conversation, { settings = {}, extensions = [] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compact-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1500, ...settings },
  }));
  await writeFile(join(cwd, "history.txt"), "Planning evidence: verified input and next implementation step.\n".repeat(500));
  const result = await new PiIntegrationTest({
    testName: name,
    cwd,
    artifactsDir: artifacts,
    extensions: [extension, ...JSON.parse(process.env.PI_COMPACT_TEST_EXTENSIONS ?? "[]"), ...extensions],
    tools: ["read", "write", "compact"],
    rawMode: process.env.PI_COMPACT_NATIVE_TUI !== "1",
    conversation,
    piCommand: process.env.PI_COMPACT_TEST_PI ?? "pi",
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    timeoutMs: 20000,
  }).run(request);
  return { result, cwd };
}

const readHistory = () => call("history", "read", { path: "history.txt" });
const compact = () => call("checkpoint", "compact", { message: continuation });

function sessionEntries(result) {
  return result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
}

test("native compaction preserves continuation provenance and resumes work", async (t) => {
  const { result, cwd } = await run(t, "native-handoff", [
    readHistory(), compact(),
    assistantMessage([text("Planning completed. Implement the next step.")]),
    call("result", "write", { path: "result.txt", content: "done" }),
    assistantMessage([text("Finished.")]),
  ]);
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
  const entries = await sessionEntries(result);
  const summaryIndex = entries.findIndex((entry) => entry.type === "compaction");
  assert.ok(summaryIndex >= 0, "Pi saved a native compaction entry");
  assert.notEqual(entries[summaryIndex].fromHook, true, "the native summarizer ran");
  const handoffIndex = entries.findIndex(isContinuation);
  assert.ok(handoffIndex > summaryIndex, "the continuation was journaled after compaction with its provenance");
  const handoffs = entries.filter(isContinuation);
  assert.equal(handoffs.length, 1);
  assert.equal(content(handoffs[0]), continuation);
  assert.equal(handoffs[0].display, true);
  const userMessages = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.deepEqual(userMessages.map((entry) => content(entry.message)), [request], "original-request exports and last-user consumers still see only the human request");
  assert.equal(result.providerRequests.length, 5, "no extra agent request ran before compaction");
});

test("a session with nothing to compact keeps running without sending the continuation", async (t) => {
  const { result } = await run(t, "nothing-to-compact", [compact(), assistantMessage([text("Continuing in the current context.")])], {
    settings: { keepRecentTokens: 1000000 },
  });
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  assert.equal(getToolExecutionDetails(getToolExecution(result, "checkpoint")).status, "scheduled");
  const entries = await sessionEntries(result);
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(entries.some(isContinuation), false);
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && content(entry.message) === continuation), false);
});

test("the availability check respects Pi's per-model retention setting", async (t) => {
  const { result } = await run(t, "model-retention", [readHistory(), compact(), assistantMessage([text("Keeping the current context.")])], {
    settings: { modelOverrides: { "scripted/scripted-model": { keepRecentTokens: 1000000 } } },
  });
  assert.equal(getToolExecutionDetails(getToolExecution(result, "checkpoint")).status, "scheduled");
  assert.equal((await sessionEntries(result)).filter((entry) => entry.type === "compaction").length, 0);
});

test("cancelled compaction reports failure without delivering the success continuation", async (t) => {
  const { result } = await run(t, "cancelled-compaction", [readHistory(), compact(), assistantMessage([text("Recovered in the current context.")])], {
    extensions: [fileURLToPath(new URL("./fixtures/cancel.ts", import.meta.url))],
  });
  const entries = await sessionEntries(result);
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(entries.some(isContinuation), false);
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && content(entry.message) === continuation), false);
  assert.equal(entries.some((entry) => entry.type === "custom_message" && entry.customType === "compact-error"), true);
});
