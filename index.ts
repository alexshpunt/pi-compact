import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function compactExtension(pi: ExtensionAPI) {
  let pending: string | undefined;

  pi.registerTool({
    name: "compact",
    label: "Compact",
    description: "Compact the current context using a summary you write, then continue the task. Your summary becomes the only retained conversation context; Pi does not make a separate summarization request. Call this tool directly, by itself, at a meaningful milestone.",
    promptSnippet: "Compact context using your own task summary and continue",
    promptGuidelines: [
      "Call compact at a meaningful milestone: after planning before implementation, after implementation before integration or testing, or after finishing one feature before starting the next.",
      "Write a concise summary of the current task: goal, progress, decisions, next actions, and important new task-specific facts that cannot be recovered. Preserve what is needed to continue; omit generic rules already available in AGENTS.md, skills, or other infrastructure.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      summary: Type.String({ description: "Write the context needed to continue the current task after compaction, including the next action." }),
    }),
    async execute(_id, { summary }) {
      if (!summary.trim()) throw new Error("The summary must not be empty.");
      if (pending !== undefined) throw new Error("A compaction is already scheduled.");
      pending = summary;
      return {
        content: [{ type: "text", text: "Compaction scheduled. This run will continue from your summary." }],
        details: { status: "scheduled" },
        terminate: true,
      };
    },
  });

  pi.on("agent_before_settle", (event) => {
    if (pending === undefined || event.outcome !== "completed") return;
    const summary = pending;
    pending = undefined;
    return {
      entries: [
        ...event.entries,
        { type: "compaction", summary, firstKeptEntryId: null },
        { type: "custom_message", customType: "compact-continuation", content: "Continue the unfinished task described in the summary.", display: false },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", () => { pending = undefined; });
  pi.on("session_shutdown", () => { pending = undefined; });
}
