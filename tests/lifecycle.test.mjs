import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiIntegrationTest, assistantMessage, text, toolCall } from "pi-coding-agent-test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/lifecycle.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const continuation = "This continuation belongs only to the outgoing run.";
const call = (id, name, args) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

async function run(t, mode, conversation) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compact-lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1500 },
  }));
  await writeFile(join(cwd, "history.txt"), "Planning evidence and implementation boundary.\n".repeat(700));
  let result, error;
  try {
    result = await new PiIntegrationTest({
      testName: `lifecycle-${mode}`,
      cwd,
      artifactsDir: artifacts,
      extensions: [extension, fixture],
      tools: ["read", "compact"],
      conversation,
      piCommand: process.env.PI_COMPACT_TEST_PI ?? "pi",
      isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_COMPACT_LIFECYCLE: mode },
      timeoutMs: 20000,
    }).run("Prepare a milestone and schedule compaction.");
  } catch (caught) {
    error = caught;
  }
  const events = (await readFile(join(cwd, "lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  await writeFile(join(artifacts, `lifecycle-${mode}`, "lifecycle.json"), JSON.stringify(events, null, 2));
  return { result, error, cwd, events };
}

test("an aborted compact run does not compact or resume", async (t) => {
  const { result, error, events } = await run(t, "abort", [
    call("history", "read", { path: "history.txt" }),
    call("checkpoint", "compact", { message: continuation }),
    assistantMessage([text("The independent follow-up completed.")]),
  ]);
  assert.ok(events.some((event) => event.type === "settled" && event.aborted === true), "the real run was aborted after scheduling");
  assert.equal(events.filter((event) => event.type === "compaction-attempt").length, 0, "aborting cancels the pending compaction");
  assert.ifError(error);
  assert.equal(result.providerRequests.length, 3);
  const entries = result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
  assert.equal(entries.some((entry) => entry.type === "compaction"), false);
  assert.equal(entries.some((entry) => entry.type === "custom_message" && ["compact-continuation", "compact-error"].includes(entry.customType)), false);
});

test("switching sessions clears the outgoing run's pending compaction", async (t) => {
  const { result, error, events } = await run(t, "switch", [
    call("history", "read", { path: "history.txt" }),
    call("checkpoint", "compact", { message: continuation }),
    assistantMessage([text("Destination probe completed.")]),
  ]);
  assert.ifError(error);
  const outgoing = events.find((event) => event.type === "switch-requested")?.sessionId;
  const destination = events.find((event) => event.type === "destination")?.sessionId;
  assert.ok(outgoing);
  assert.ok(destination);
  assert.notEqual(destination, outgoing);
  assert.ok(events.some((event) => event.type === "shutdown" && event.reason === "new" && event.sessionId === outgoing));
  assert.equal(result.state.sessionId, destination);
  const entries = result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
  assert.equal(entries.some((entry) => entry.type === "compaction"), false);
  assert.equal(entries.some((entry) => entry.type === "custom_message" && ["compact-continuation", "compact-error"].includes(entry.customType)), false);
  assert.equal(result.providerRequests.length, 3);
});

test("switching sessions during compaction does not deliver its callback to the destination", async (t) => {
  const { result, error, events } = await run(t, "switch-compacting", [
    call("history", "read", { path: "history.txt" }),
    call("checkpoint", "compact", { message: continuation }),
    assistantMessage([text("Destination probe completed.")]),
  ]);
  assert.ifError(error);
  const outgoing = events.find((event) => event.type === "switch-requested")?.sessionId;
  const destination = events.find((event) => event.type === "destination")?.sessionId;
  assert.ok(outgoing);
  assert.ok(destination);
  assert.notEqual(destination, outgoing);
  assert.ok(events.some((event) => event.type === "compaction-attempt" && event.sessionId === outgoing));
  assert.ok(events.some((event) => event.type === "shutdown" && event.reason === "new" && event.sessionId === outgoing));
  assert.equal(result.state.sessionId, destination);
  const entries = result.traceEvents.filter((event) => event.type === "session_snapshot").at(-1).branch;
  assert.equal(entries.some((entry) => entry.type === "custom_message" && ["compact-continuation", "compact-error"].includes(entry.customType)), false);
  assert.equal(result.providerRequests.length, 3);
});