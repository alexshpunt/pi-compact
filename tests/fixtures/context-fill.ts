import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // The scripted provider reports zero usage, unlike a real provider. After a
  // compaction, Pi requires a nonzero response before estimating context again.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction")) {
      event.message.usage.input = 1;
      event.message.usage.totalTokens = 1;
    }
  });
  pi.registerTool({
    name: "fill_context", label: "Fill", description: "Produce test data.",
    parameters: Type.Object({ size: Type.Number() }),
    async execute(_id, { size }) {
      return { content: [{ type: "text", text: "x".repeat(size) }], details: {} };
    },
  });
}
