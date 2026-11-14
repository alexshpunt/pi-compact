import { randomUUID } from "node:crypto";
import { estimateTokens, type ExtensionAPI, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { createNativeCompactionAdapter } from "./native-compaction.js";
import { Type } from "typebox";

function firstKeptEntryId(entries: ProjectedSessionEntry[], persistedIds: Set<string>, keepRecentTokens: number): string | null {
  // Only select persisted, visible message boundaries, never a tool result.
  const cutPoints = entries.flatMap((entry, index) =>
    persistedIds.has(entry.sourceEntry.id) && entry.sourceEntry.type !== "compaction" &&
    entry.messages.some((message) => ["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(message.role))
      ? [index] : [],
  );
  if (cutPoints.length === 0) return null;

  let tokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (size === 0) continue;
    tokens += size;
    if (tokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }
  return entries[cutIndex].sourceEntry.id;
}

export default function compactExtension(pi: ExtensionAPI) {
  let adapter: ReturnType<typeof createNativeCompactionAdapter> | undefined;
  let pending: {
    summary: string; fresh: boolean; sessionId: string; instructions: string;
    running: boolean; aborted: boolean; signal?: AbortSignal; unregister?: () => void;
  } | undefined;
  const clearPending = () => {
    pending?.unregister?.();
    pending = undefined;
  };
  let warnedThreshold = 0;
  let lastCompactionId: string | undefined;

  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed" || pending !== undefined) return;
    const compaction = ctx.sessionManager.getBranch().reverse().find((entry) => entry.type === "compaction");
    if (compaction?.id !== lastCompactionId) {
      warnedThreshold = 0;
      lastCompactionId = compaction?.id;
    }
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null || !Number.isFinite(percent)) return;
    const threshold = Math.floor(percent / 5) * 5;
    if (threshold < 80 || threshold <= warnedThreshold) return;
    warnedThreshold = threshold;
    const remaining = Math.max(0, Math.floor(100 - percent));
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: "context-warning", display: false,
        content: `Context is ${Math.floor(percent)}% full; approximately ${remaining}% remains. Compact immediately to avoid losing relevant information.`,
      }],
      continue: true,
    };
  });

  pi.registerTool({
    name: "compact",
    label: "Compact",
    description: "Compact older context using a summary you write, retain recent messages according to Pi's compaction settings, then continue the task. Pi does not make a separate summarization request. Call this tool directly, by itself, at a meaningful milestone.",
    promptSnippet: "Compact context using your own task summary and continue",
    promptGuidelines: [
      "Call compact at a meaningful milestone: after planning before implementation, after implementation before integration or testing, or after finishing one feature before starting the next.",
      "Write a concise summary of the current task: goal, progress, decisions, next actions, and important new task-specific facts that cannot be recovered. Preserve what is needed to continue; omit generic rules already available in AGENTS.md, skills, or other infrastructure.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      summary: Type.String({ description: "Write the context needed to continue the current task after compaction, including the next action." }),
      fresh: Type.Optional(Type.Boolean({ description: "true also drops the recent messages, so work continues from the summary alone. Use it when the next step needs a clean context, such as reviewing your own work with fresh eyes. Default: false." })),
    }),
    async execute(_id, { summary, fresh }, _signal, _onUpdate, ctx) {
      if (!summary.trim()) throw new Error("The summary must not be empty.");
      if (pending !== undefined) throw new Error("A compaction is already scheduled.");
      pending = {
        summary, fresh: fresh === true, sessionId: ctx.sessionManager.getSessionId(),
        instructions: `pi-compact:${randomUUID()}`, running: false, aborted: false,
      };
      return {
        content: [{ type: "text", text: "Compaction scheduled. This run will continue from your summary." }],
        details: { status: "scheduled" },
        terminate: true,
      };
    },
  });

  pi.on("agent_settled", (event, ctx) => {
    const operation = pending;
    if (!operation) return;
    if (event.aborted || ctx.sessionManager.getSessionId() !== operation.sessionId) {
      clearPending();
      return;
    }
    if (operation.running) return;
    operation.running = true;
    const isCurrent = () => pending === operation && ctx.sessionManager.getSessionId() === operation.sessionId;
    adapter ??= createNativeCompactionAdapter();
    operation.unregister = adapter.schedule(ctx.sessionManager, {
      instructions: operation.instructions,
      summary: operation.summary,
      isCurrent,
      prepare(session, tokensBefore, signal) {
        operation.signal = signal;
        let firstKept: string | null = null;
        if (!operation.fresh) {
          const settings = session.settingsManager.getCompactionSettings(session.model);
          const persistedIds = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
          firstKept = firstKeptEntryId(session.sessionManager.buildSessionProjection().entries, persistedIds, settings.keepRecentTokens);
        }
        // An inert custom entry is a supported string boundary with no model messages.
        // It lets native compaction retain no history without a nullable SDK result.
        firstKept ??= session.sessionManager.appendCustomEntry("compact-retain-none");
        return { summary: operation.summary, firstKeptEntryId: firstKept, tokensBefore };
      },
    });
    ctx.compact({
      customInstructions: operation.instructions,
      onComplete() {
        if (!isCurrent()) return;
        clearPending();
        if (operation.signal?.aborted) return;
        pi.sendMessage({
          customType: "compact-continuation", content: "Continue the unfinished task described in the summary.", display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      },
      onError(error) {
        if (!isCurrent()) return;
        clearPending();
        if (operation.aborted) return;
        pi.sendMessage({
          customType: "compact-error", content: `Compaction failed: ${error.message}. Check the current session state before continuing.`, display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });
  });

  // Enable native before-compaction dispatch. The scoped SDK adapter supplies the
  // authored result after every registered handler has had the chance to cancel.
  pi.on("session_before_compact", () => {});
  pi.on("session_compact_failed", (event) => {
    if (pending?.running) pending.aborted = event.aborted;
  });
  pi.on("session_shutdown", () => {
    clearPending();
    adapter?.dispose();
    adapter = undefined;
    warnedThreshold = 0;
    lastCompactionId = undefined;
  });
}
