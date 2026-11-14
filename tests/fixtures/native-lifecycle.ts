import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function nativeLifecycleProbe(pi: ExtensionAPI) {
  const mode = process.env.PI_COMPACT_NATIVE_LIFECYCLE;
  const completedIds: string[] = [];
  let currentSession: AgentSession | undefined;
  let ordinaryStarted = false;
  let observing = false;
  const independentFollowUp = () => pi.sendMessage({
    customType: "native-lifecycle-independent-follow-up", content: "The independent follow-up may now finish.", display: false,
  }, { triggerTurn: true, deliverAs: "followUp" });
  const recordAt = (cwd: string, event: object) => {
    appendFileSync(join(cwd, "native-lifecycle.jsonl"), JSON.stringify(event) + "\n");
  };
  const record = (ctx: ExtensionContext, event: object) => recordAt(ctx.cwd, {
    ...event, sessionId: ctx.sessionManager.getSessionId(),
  });

  // Subscribe to the real SDK stream before the native operation emits its first event.
  // This only observes the public operation; it does not generate lifecycle events.
  const originalCompact = AgentSession.prototype.compact;
  const observeCompact: AgentSession["compact"] = async function (this: AgentSession, ...args) {
    currentSession = this;
    const ownsSubscription = !observing;
    observing = true;
    const unsubscribe = ownsSubscription ? this.subscribe((event) => {
      if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
      recordAt(this.sessionManager.getCwd(), {
        type: `sdk-${event.type}`,
        event,
        isCompacting: this.isCompacting,
        resolvedSettings: this.settingsManager.getCompactionSettings(this.model),
        sessionId: this.sessionManager.getSessionId(),
      });
      if (mode === "cancel-then-manual" && event.type === "compaction_end" && !ordinaryStarted) {
        ordinaryStarted = true;
        void this.compact("ordinary-manual-1495").then(independentFollowUp, (error: Error) => {
          recordAt(this.sessionManager.getCwd(), { type: "ordinary-error", error: error.message });
          independentFollowUp();
        });
      }
    }) : () => {};
    try {
      return await originalCompact.apply(this, args);
    } finally {
      unsubscribe();
      if (ownsSubscription) observing = false;
    }
  };
  AgentSession.prototype.compact = observeCompact;

  pi.on("session_before_compact", (event, ctx) => {
    record(ctx, {
      type: "before-compact", reason: event.reason, willRetry: event.willRetry,
      configuredSettings: pi.getSettings().compaction,
    });
    if (mode === "cancel" || mode === "cancel-then-manual" && event.customInstructions !== "ordinary-manual-1495") return { cancel: true };
    if (event.customInstructions === "ordinary-manual-1495") return {
      compaction: {
        summary: "ordinary-summary-1495",
        firstKeptEntryId: event.branchEntries.find(entry => entry.type === "message")!.id,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  pi.on("session_compact", async (event, ctx) => {
    const latest = ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
    record(ctx, {
      type: "compact-hook-start", entry: event.compactionEntry, latestId: latest?.id,
      fromExtension: event.fromExtension, reason: event.reason, willRetry: event.willRetry,
      configuredSettings: pi.getSettings().compaction,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    completedIds.push(event.compactionEntry.id);
    record(ctx, { type: "compact-hook-finished", compactionId: event.compactionEntry.id });
    if (mode === "abort-after-commit") {
      currentSession!.abortCompaction();
      independentFollowUp();
    }
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    record(ctx, { type: "compact-failed", event, configuredSettings: pi.getSettings().compaction });
    if (mode === "cancel-then-manual") await new Promise<void>(resolve => setTimeout(resolve, 100));
    if (mode === "cancel") {
      independentFollowUp();
    }
  });
  pi.on("turn_start", (_event, ctx) => {
    record(ctx, { type: "turn-start", completedIds: [...completedIds] });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    record(ctx, { type: "shutdown", configuredSettings: pi.getSettings().compaction });
    if (AgentSession.prototype.compact === observeCompact) {
      AgentSession.prototype.compact = originalCompact;
    }
  });
}
