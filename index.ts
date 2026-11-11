import { estimateTokens, SettingsManager, type ExtensionAPI, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function firstKeptEntryId(entries: ProjectedSessionEntry[], persistedIds: Set<string>, keepRecentTokens: number): string | null {
  // The preview can contain draft entries whose IDs will change when committed.
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
  let pending: { summary: string; fresh: boolean } | undefined;
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
    async execute(_id, { summary, fresh }) {
      if (!summary.trim()) throw new Error("The summary must not be empty.");
      if (pending !== undefined) throw new Error("A compaction is already scheduled.");
      pending = { summary, fresh: fresh === true };
      return {
        content: [{ type: "text", text: "Compaction scheduled. This run will continue from your summary." }],
        details: { status: "scheduled" },
        terminate: true,
      };
    },
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (pending === undefined || event.outcome !== "completed") return;
    const { summary, fresh } = pending;
    pending = undefined;
    // Pi treats a missing first kept entry as retain-none.
    let firstKept: string | null = null;
    if (!fresh) {
      const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings(ctx.model);
      const persistedIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
      firstKept = firstKeptEntryId(event.context.contextEntries, persistedIds, settings.keepRecentTokens);
    }
    return {
      entries: [
        ...event.entries,
        { type: "compaction", summary, firstKeptEntryId: firstKept },
        { type: "custom_message", customType: "compact-continuation", content: "Continue the unfinished task described in the summary.", display: false },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", () => { pending = undefined; });
  pi.on("session_shutdown", () => {
    pending = undefined;
    warnedThreshold = 0;
    lastCompactionId = undefined;
  });
}
