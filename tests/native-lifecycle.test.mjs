import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiIntegrationTest, assistantMessage, text, toolCall, getToolExecution } from "pi-coding-agent-test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/native-lifecycle.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const request = "Complete the native lifecycle checkpoint and continue the task.";
const summary = "\nLifecycle checkpoint 1495: continue from this exact authored handoff.  \n";
const historyMarker = "old-lifecycle-evidence-728319";
const configuredSettings = {
  enabled: false,
  keepRecentTokens: 1000000,
  modelOverrides: { "scripted/scripted-model": { keepRecentTokens: 1000000 } },
};
const call = (id, name, args) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
const compact = (id = "checkpoint", fresh = false) => call(id, "compact", { summary, fresh });
const done = () => assistantMessage([text("The scripted task is complete.")]);
const content = (message) => typeof message.content === "string" ? message.content :
  (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
const entries = (result) => result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
const matching = (events, type) => events.filter((event) => event.type === type);

async function run(t, name, conversation, mode = "observe", settings = configuredSettings) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compact-native-lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: settings }));
  await writeFile(join(cwd, "history.txt"), `${historyMarker}\n`.repeat(500));
  const result = await new PiIntegrationTest({
    testName: name,
    cwd,
    artifactsDir: artifacts,
    extensions: [extension, fixture],
    tools: ["read", "write", "compact"],
    rawMode: false,
    conversation,
    piCommand: process.env.PI_COMPACT_TEST_PI ?? "pi",
    isolateUserResources: false,
    environment: {
      PI_CODING_AGENT_DIR: join(cwd, "agent"),
      PI_COMPACT_NATIVE_LIFECYCLE: mode,
    },
    timeoutMs: 30000,
  }).run(request);
  const events = (await readFile(join(cwd, "native-lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  await writeFile(join(result.artifacts.directory, "native-lifecycle.json"), JSON.stringify(events, null, 2));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8")).compaction, settings,
    "native preparation must not change persisted compaction settings");
  return { result, events, cwd };
}

function assertNativeSuccess(events, saved) {
  const starts = matching(events, "sdk-compaction_start");
  const before = matching(events, "before-compact");
  const hooks = matching(events, "compact-hook-start");
  const finishes = matching(events, "compact-hook-finished");
  const ends = matching(events, "sdk-compaction_end");
  for (const observed of [starts, before, hooks, finishes, ends]) assert.equal(observed.length, saved.length);
  assert.equal(matching(events, "compact-failed").length, 0);
  for (let i = 0; i < saved.length; i++) {
    const entry = saved[i];
    assert.ok(entry.id);
    assert.ok(entry.parentId);
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    assert.equal(entry.summary, summary);
    assert.equal(entry.fromHook, true);
    assert.ok(Number.isFinite(entry.tokensBefore) && entry.tokensBefore > 0);
    assert.ok(entry.firstKeptEntryId);
    assert.equal(entry.systemMessage?.role, "system");
    assert.equal(entry.usage, undefined, "the handoff must not invent separate summary-generation usage");
    assert.equal(hooks[i].entry.id, entry.id, "session_compact must identify this operation's saved entry");
    assert.equal(hooks[i].latestId, entry.id);
    assert.equal(finishes[i].compactionId, entry.id);
    assert.equal(hooks[i].fromExtension, true);
    assert.equal(hooks[i].reason, "manual");
    assert.equal(hooks[i].willRetry, false);
    assert.deepEqual(before[i].configuredSettings, configuredSettings);
    assert.deepEqual(hooks[i].configuredSettings, configuredSettings);
    assert.equal(starts[i].isCompacting, true);
    assert.equal(starts[i].resolvedSettings.keepRecentTokens, 1000000, "passive start observers must see the configured budget");
    assert.equal(ends[i].isCompacting, false, "completion listeners must observe idle compaction state");
    assert.equal(ends[i].resolvedSettings.keepRecentTokens, 1000000);
    assert.equal(ends[i].event.aborted, false);
    assert.equal(ends[i].event.reason, "manual");
    assert.equal(ends[i].event.willRetry, false);
    assert.equal(ends[i].event.result.summary, summary);
    assert.equal(ends[i].event.result.tokensBefore, entry.tokensBefore);
    assert.ok(Number.isFinite(ends[i].event.result.estimatedTokensAfter));
    const order = [starts[i], before[i], hooks[i], finishes[i], ends[i]].map((event) => events.indexOf(event));
    assert.ok(order.every((index, step) => step === 0 || index > order[step - 1]), "native lifecycle must preserve hook and completion order");
    const continued = events.find((event, index) => index > order.at(-1) && event.type === "turn-start");
    assert.ok(continued, "the task must resume after native completion");
    assert.ok(continued.completedIds.includes(entry.id), "asynchronous session_compact observers must finish before the next turn");
  }
}

test("short agent compaction delivers native lifecycle despite a large model retention override", async (t) => {
  const { result, events, cwd } = await run(t, "native-short-high-retention", [
    compact(),
    call("continued-write", "write", { path: "continued.txt", content: "continuation-1495" }),
    done(),
  ]);
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  assert.equal(await readFile(join(cwd, "continued.txt"), "utf8"), "continuation-1495");
  const saved = entries(result).filter((entry) => entry.type === "compaction");
  assert.equal(saved.length, 1);
  assertNativeSuccess(events, saved);
  assert.equal(result.providerRequests.length, 3, "only the scripted working-agent responses may be requested");
});

test("fresh compaction retains native notifications but drops every old model-visible message", async (t) => {
  const { result, events } = await run(t, "native-fresh-lifecycle", [
    call("old-history", "read", { path: "history.txt" }), compact("checkpoint", true), done(),
  ]);
  const saved = entries(result).filter((entry) => entry.type === "compaction");
  assert.equal(saved.length, 1);
  assertNativeSuccess(events, saved);
  assert.equal(result.providerRequests.length, 3);
  const resumed = result.providerRequests[2].messages;
  assert.ok(resumed.some((message) => content(message).includes(summary)));
  assert.ok(!resumed.some((message) => content(message).includes(historyMarker)));
  assert.ok(!resumed.some((message) => message.role === "user" && content(message) === request));
  assert.ok(!resumed.some((message) => message.role === "toolResult" && message.toolCallId === "old-history"));
});

test("identical repeated handoffs notify the exact new compaction once each", async (t) => {
  const { result, events } = await run(t, "native-identical-summary-lifecycle", [
    compact(), compact("checkpoint-2"), done(),
  ]);
  const saved = entries(result).filter((entry) => entry.type === "compaction");
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  assertNativeSuccess(events, saved);
  assert.equal(result.providerRequests.length, 3);
});

test("a native hook cancellation reports aborted completion without saving a checkpoint", async (t) => {
  const { result, events } = await run(t, "native-cancelled-lifecycle", [compact(), done()], "cancel");
  assert.equal(getToolExecution(result, "checkpoint").isError, false);
  assert.equal(entries(result).filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(matching(events, "before-compact").length, 1);
  assert.equal(matching(events, "compact-hook-start").length, 0);
  assert.equal(matching(events, "compact-hook-finished").length, 0);
  assert.equal(matching(events, "sdk-compaction_start").length, 1);
  const ends = matching(events, "sdk-compaction_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].event.aborted, true);
  assert.equal(ends[0].event.result, undefined);
  assert.equal(ends[0].isCompacting, false);
  assert.equal(ends[0].resolvedSettings.keepRecentTokens, 1000000);
  const failures = matching(events, "compact-failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event.aborted, true);
  assert.deepEqual(failures[0].configuredSettings, configuredSettings);
  assert.equal(entries(result).some((entry) => entry.type === "custom_message" && entry.customType === "compact-continuation"), false);
  assert.ok(entries(result).some((entry) => entry.type === "custom_message" && entry.customType === "native-lifecycle-independent-follow-up"));
  assert.equal(result.providerRequests.length, 2, "only the independent follow-up may run after cancellation");
});

test("Escape during an awaited post-save hook suppresses the authored continuation", async (t) => {
  const { result, events } = await run(t, "native-abort-after-commit", [compact(), done()], "abort-after-commit", { enabled: false, keepRecentTokens: 0 });
  assert.equal(entries(result).filter(entry => entry.type === "compaction").length, 1);
  assert.equal(matching(events, "compact-hook-finished").length, 1);
  assert.equal(matching(events, "sdk-compaction_end").length, 1);
  assert.equal(entries(result).some(entry => entry.type === "custom_message" && entry.customType === "compact-continuation"), false);
  assert.ok(entries(result).some(entry => entry.type === "custom_message" && entry.customType === "native-lifecycle-independent-follow-up"));
  assert.equal(result.providerRequests.length, 2);
});

test("a failed authored compaction releases its SDK scope before another ordinary compaction", async (t) => {
  const settings = { enabled: false, keepRecentTokens: 0 };
  const { result, events } = await run(t, "native-failure-then-ordinary", [compact(), done()], "cancel-then-manual", settings);
  const saved = entries(result).filter(entry => entry.type === "compaction");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].summary, "ordinary-summary-1495");
  assert.equal(matching(events, "ordinary-error").length, 0);
  assert.equal(matching(events, "sdk-compaction_start").length, 2);
  assert.equal(matching(events, "compact-hook-finished").length, 1);
  assert.equal(entries(result).some(entry => entry.type === "custom_message" && entry.customType === "compact-continuation"), false);
  assert.equal(result.providerRequests.length, 2);
});