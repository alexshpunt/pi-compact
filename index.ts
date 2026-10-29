import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function compactExtension(pi: ExtensionAPI) {
  let pending: string | undefined;
  let generation = 0;

  pi.registerTool({
    name: "compact",
    label: "Compact",
    description: "Use compact to start the next stage of work with a smaller context and your own continuation message. Pi performs its normal compaction and then sends your message verbatim as an extension-authored continuation, starting another agent run without creating a user request. If there is nothing to compact, continue in the current context.",
    promptSnippet: "Compact context and resume from your next message",
    promptGuidelines: [
      "Call compact at a meaningful milestone: after planning before implementation, after implementation before integration or testing, or after finishing one feature before starting the next.",
      "Call compact directly, by itself, after finishing the current step. Continue only the unfinished work described in the next message.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      message: Type.String({ description: "Write a short message to yourself with the next action and any facts that need special attention. Pi summarizes the session during compaction; do not repeat the session summary." }),
    }),
    async execute(_id, { message }) {
      if (pending !== undefined) throw new Error("A compaction is already scheduled.");
      pending = message;
      return {
        content: [{ type: "text", text: "Compaction scheduled. This run ends here; your continuation will be sent after compaction succeeds." }],
        details: { status: "scheduled" },
        terminate: true,
      };
    },
  });

  // Native compaction aborts an active run, so start it only after this tool's run has settled.
  pi.on("agent_settled", (event, ctx) => {
    if (pending === undefined) return;
    const message = pending;
    pending = undefined;
    if (event.aborted) return;
    const epoch = generation;
    ctx.compact({
      onComplete: () => {
        if (epoch !== generation) return;
        pi.sendMessage({
          customType: "compact-continuation",
          content: message,
          display: true,
        }, { triggerTurn: true });
      },
      onError: (error) => {
        if (epoch !== generation) return;
        pi.sendMessage({
          customType: "compact-error",
          content: `Compaction failed: ${error.message}. The continuation message was not sent. Continue in the current context.`,
          display: true,
        }, { triggerTurn: true });
      },
    });
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    pending = undefined;
  });
}
