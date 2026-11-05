import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  PiIntegrationTest, assistantMessage, text, toolCall, getToolExecution,
} from "pi-coding-agent-test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const request = "Complete the planning milestone, compact, and continue implementation.";
const summary = "\nPlanning is complete.\nNEXT: write result.txt containing done.  \n";
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
  await writeFile(join(cwd, "recent.txt"), "Recent retained evidence: 83917\n");
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
const compact = (value = summary) => call("checkpoint", "compact", { summary: value });
const sessionEntries = (result) => result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;

test("agent-written summary is persisted unchanged and work resumes without a summarization request", async (t) => {
  const { result, cwd } = await run(t, "agent-summary-handoff", [
    readHistory(), compact(),
    call("result", "write", { path: "result.txt", content: "done" }),
    assistantMessage([text("Finished.")]),
  ]);
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
  const entries = sessionEntries(result);
  const compactions = entries.filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].summary, summary);
  assert.equal(compactions[0].fromHook, true);
  const userMessages = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.deepEqual(userMessages.map((entry) => content(entry.message)), [request]);
  assert.equal(result.providerRequests.length, 4, "only the four scripted agent responses were requested");
  const resumedMessages = result.providerRequests[2].messages;
  assert.ok(resumedMessages.some((message) => content(message).includes(summary)), "the next request receives the supplied summary");
  assert.ok(!resumedMessages.some((message) => content(message).includes("Planning evidence: verified input")), "the next request does not retain the old tool result");
});

test("explicit compaction works on a short session regardless of retention settings", async (t) => {
  const { result } = await run(t, "short-session", [
    compact(), assistantMessage([text("Continued.")]),
  ], { settings: { keepRecentTokens: 1000000, modelOverrides: { "scripted/scripted-model": { keepRecentTokens: 1000000 } } } });
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  const compactions = sessionEntries(result).filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].summary, summary);
  assert.equal(result.providerRequests.length, 2);
});

test("recent tool calls and results survive while older history is compacted", async (t) => {
  const { result } = await run(t, "retained-tail", [
    readHistory(),
    call("recent", "read", { path: "recent.txt" }),
    compact(),
    assistantMessage([text("Continued.")]),
  ], { settings: { keepRecentTokens: 200 } });
  const messages = result.providerRequests[3].messages;
  assert.ok(messages.some((message) => content(message).includes(summary)));
  assert.ok(!messages.some((message) => content(message).includes("Planning evidence: verified input")));
  const toolCallIndex = messages.findIndex((message) => message.role === "assistant" &&
    Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall" && block.id === "recent"));
  const resultIndex = messages.findIndex((message) => message.role === "toolResult" &&
    message.toolCallId === "recent" && content(message).includes("Recent retained evidence: 83917"));
  assert.ok(toolCallIndex >= 0, "recent tool call is retained");
  assert.ok(resultIndex > toolCallIndex, "the matching result follows its call");
});

test("model retention override keeps a short conversation and its tool result", async (t) => {
  const { result } = await run(t, "retention-model-override", [
    call("recent", "read", { path: "recent.txt" }), compact(), assistantMessage([text("Continued.")]),
  ], { settings: { keepRecentTokens: 0, modelOverrides: { "scripted/scripted-model": { keepRecentTokens: 1000000 } } } });
  const messages = result.providerRequests[2].messages;
  assert.ok(messages.some((message) => message.role === "user" && content(message) === request));
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolCallId === "recent" &&
    content(message).includes("Recent retained evidence: 83917")));
  assert.equal(result.providerRequests.length, 3);
});

test("repeated compaction retains the recent tail without restoring old messages", async (t) => {
  const secondSummary = "Second checkpoint: continue.";
  const { result } = await run(t, "repeated-retention", [
    readHistory(),
    call("recent", "read", { path: "recent.txt" }),
    compact(),
    call("checkpoint-2", "compact", { summary: secondSummary }),
    assistantMessage([text("Continued.")]),
  ], { settings: { keepRecentTokens: 200 } });
  const messages = result.providerRequests[4].messages;
  assert.ok(messages.some((message) => content(message).includes(secondSummary)));
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolCallId === "recent" &&
    content(message).includes("Recent retained evidence: 83917")));
  assert.ok(!messages.some((message) => content(message).includes("Planning evidence: verified input")));
  assert.equal(sessionEntries(result).filter((entry) => entry.type === "compaction").length, 2);
});

test("an empty summary is rejected without compacting", async (t) => {
  const { result } = await run(t, "empty-summary", [
    compact(""), assistantMessage([text("Continued without compaction.")]),
  ]);
  assert.equal(getToolExecution(result, "checkpoint").isError, true);
  assert.equal(sessionEntries(result).some((entry) => entry.type === "compaction"), false);
  assert.equal(result.providerRequests.length, 2);
});
