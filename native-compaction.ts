import {
  AgentSession,
  type CompactionResult,
  type ExtensionRunner,
  type ExtensionContext,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
interface AuthoredCompaction {
  instructions: string;
  summary: string;
  isCurrent(): boolean;
  prepare(session: AgentSession, tokensBefore: number, signal: AbortSignal): CompactionResult;
}

interface AdapterState {
  users: Set<symbol>;
  requests: WeakMap<ReadonlySessionManager, AuthoredCompaction>;
  original: AgentSession["compact"];
  wrapped: AgentSession["compact"];
}

const adapterKey = Symbol.for("@alexshp/pi-compact/native-compaction");
const prototype = AgentSession.prototype as AgentSession & { [adapterKey]?: AdapterState };

// Restore the original descriptor, including inherited methods. Never undo a later wrapper.
function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  target[key] = value;
  return () => {
    if (target[key] !== value) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
}

async function compactWithHandoff(session: AgentSession, request: AuthoredCompaction, run: () => ReturnType<AgentSession["compact"]>) {
  const manager = session.sessionManager;
  const runner = session.extensionRunner;
  if (!runner) throw new Error("The compaction extension runner is unavailable.");
  const assertCurrent = () => {
    if (!request.isCurrent()) throw new Error("The session changed before compaction could finish.");
  };
  assertCurrent();
  let savedId: string | undefined;
  let restoreSettings = () => {};
  let restoreSubscribe = () => {};
  let restoreAppend = () => {};
  let restoreEmit = () => {};
  let unsubscribe = () => {};
  const cleanup = () => {
    unsubscribe();
    restoreSubscribe();
    restoreSettings();
    restoreEmit();
    restoreAppend();
  };
  const subscribe = session.subscribe;
  // Native preparation rejects short sessions before dispatching the extension hook.
  // Change only its planning budget, synchronously after the real start event. The
  // actual retained boundary is computed later from the unchanged resolved settings.
  const observe: Parameters<AgentSession["subscribe"]>[0] = (event) => {
    if (event.type === "compaction_end" && event.reason === "manual") {
      cleanup();
      return;
    }
    if (event.type !== "compaction_start" || event.reason !== "manual") return;
    const getSettings = session.settingsManager.getCompactionSettings;
    restoreSettings = override(session.settingsManager, "getCompactionSettings", function (this: AgentSession["settingsManager"], ...args) {
      restoreSettings();
      return { ...getSettings.apply(this, args), keepRecentTokens: 0 };
    });
  };
  const listen = () => subscribe.call(session, observe);
  unsubscribe = listen();
  // Wrappers entered by the native call may add observers after us. Keep planning
  // last so every passive start listener reads the original settings.
  restoreSubscribe = override(session, "subscribe", function (this: AgentSession, listener) {
    unsubscribe();
    const remove = subscribe.call(this, listener);
    unsubscribe = listen();
    return remove;
  });
  const append = manager.appendCompaction;
  restoreAppend = override(manager, "appendCompaction", function (this: AgentSession["sessionManager"], ...args) {
    assertCurrent();
    if (args[0] !== request.summary) throw new Error("Compaction changed the authored summary.");
    savedId = append.apply(this, args);
    return savedId;
  });
  const emit = runner.emit.bind(runner);
  type Event = Parameters<ExtensionRunner["emit"]>[0];
  const dispatch: ExtensionRunner["emit"] = async function <T extends Event>(this: ExtensionRunner, event: T) {
    if (event.type === "session_compact" && savedId) {
      const entry = manager.getEntry(savedId);
      if (!entry || entry.type !== "compaction") throw new Error("The saved compaction entry is unavailable.");
      // Native versions which look up by summary can select an earlier identical handoff.
      event = { ...event, compactionEntry: entry };
    }
    const result = await emit(event);
    if (event.type !== "session_before_compact" || event.customInstructions !== request.instructions) {
      return result;
    }
    restoreSettings();
    if ((result as SessionBeforeCompactResult | undefined)?.cancel) {
      return result;
    }
    assertCurrent();
    if (event.signal.aborted) throw new Error("Compaction was cancelled.");
    const supplied: SessionBeforeCompactResult = {
      compaction: request.prepare(session, event.preparation.tokensBefore, event.signal),
    };
    // The generic runner return type is conditional on the event discriminant above.
    return supplied as Awaited<ReturnType<typeof emit<T>>>;
  };
  restoreEmit = override(runner, "emit", dispatch);
  try {
    return await run();
  } finally {
    cleanup();
  }
}

/** Extension-owned adapter around public SDK methods; all lifecycle dispatch stays native. */
export function createNativeCompactionAdapter() {
  let state = prototype[adapterKey];
  if (!state) {
    const original = prototype.compact;
    state = { users: new Set(), requests: new WeakMap(), original, wrapped: original };
    const shared = state;
    shared.wrapped = function (this: AgentSession, ...args) {
      const request = shared.requests.get(this.sessionManager);
      if (!request || args[0] !== request.instructions) return original.apply(this, args);
      return compactWithHandoff(this, request, () => original.apply(this, args));
    };
    prototype[adapterKey] = state;
    prototype.compact = shared.wrapped;
  }
  const owner = Symbol();
  state.users.add(owner);
  const shared = state;
  let unregister = () => {};
  return {
    schedule(manager: ReadonlySessionManager, request: AuthoredCompaction) {
      unregister();
      shared.requests.set(manager, request);
      unregister = () => {
        if (shared.requests.get(manager) === request) shared.requests.delete(manager);
      };
      return unregister;
    },
    dispose() {
      unregister();
      shared.users.delete(owner);
      if (shared.users.size !== 0) return;
      if (prototype.compact === shared.wrapped) prototype.compact = shared.original;
      if (prototype[adapterKey] === shared) delete prototype[adapterKey];
    },
  };
}
