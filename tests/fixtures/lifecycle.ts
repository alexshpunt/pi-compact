import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const mode = process.env.PI_COMPACT_LIFECYCLE;
  const record = (ctx: ExtensionContext, event: object) => {
    appendFileSync(join(ctx.cwd, "lifecycle.jsonl"), JSON.stringify(event) + "\n");
  };

  pi.registerCommand("compact-lifecycle-switch", {
    description: "Switch the test run to a fresh session",
    handler: async (_args, ctx) => {
      await ctx.newSession({
        withSession: async (next) => {
          record(next, { type: "destination", sessionId: next.sessionManager.getSessionId() });
          next.sendUserMessage("Run the destination probe.");
        },
      });
    },
  });

  pi.on("session_start", (event, ctx) => {
    record(ctx, { type: "start", reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
  });
  pi.on("session_shutdown", (event, ctx) => {
    record(ctx, { type: "shutdown", reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "compact") return;
    if (mode === "abort") ctx.abort();
    if (mode === "switch" && !existsSync(join(ctx.cwd, "switch-requested"))) {
      writeFileSync(join(ctx.cwd, "switch-requested"), "");
      record(ctx, { type: "switch-requested", sessionId: ctx.sessionManager.getSessionId() });
      pi.sendUserMessage("/compact-lifecycle-switch", { expandPromptTemplates: true });
    }
  });
  pi.on("agent_settled", (event, ctx) => {
    record(ctx, { type: "settled", aborted: event.aborted, sessionId: ctx.sessionManager.getSessionId() });
    if (mode === "abort" && event.aborted) {
      pi.sendMessage({ customType: "lifecycle-probe", content: "Start an independent follow-up run.", display: false }, { triggerTurn: true });
    }
  });
  pi.on("session_before_compact", (_event, ctx) => {
    record(ctx, { type: "compaction-attempt", sessionId: ctx.sessionManager.getSessionId() });
    if (mode === "abort") return { cancel: true };
    if (mode === "switch-compacting") {
      record(ctx, { type: "switch-requested", sessionId: ctx.sessionManager.getSessionId() });
      pi.sendUserMessage("/compact-lifecycle-switch", { expandPromptTemplates: true });
      return { cancel: true };
    }
  });
}
