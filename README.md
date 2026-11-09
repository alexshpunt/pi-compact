# pi-compact

One agent tool: `compact({ summary })`.

At a meaningful milestone, the working agent writes a summary of what is needed to continue the current task and calls the tool directly. Pi saves that text as a compaction entry and continues from it, without a separate summarization request. The summary should include the goal, current state, next actions, decisions and important task-specific facts that cannot be recovered; it should leave out generic instructions already available in project files, skills or other infrastructure.

The compaction replaces older conversation context with the supplied summary and retains a recent tail. The tail uses Pi's `compaction.keepRecentTokens` setting, including model-specific overrides, and keeps tool calls with their results. Retention is approximate and may keep less than the configured budget at a safe message boundary. Session history remains in the session file. The next request receives an extension-authored continuation, not a new human request. An aborted run or a session switch discards pending work.

This tool does not change Pi's automatic compaction settings. Native automatic compaction remains available as an overflow fallback when enabled. Unlike native manual compaction, this tool does not check whether the context is large enough. The tool is model-only; call it directly, by itself.

Pi warns the agent when estimated context usage reaches 80%, and again at each further 5% threshold. Each warning reports the current usage and remaining space and asks the agent to compact immediately. Warnings are not shown as user messages. After compaction, thresholds are rearmed; session switches clear the warning state. Usage is an estimate and can be unavailable until the provider reports token usage after compaction.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-compact
```

Reload Pi after installation. For a single invocation:

```bash
pi -e /absolute/path/to/pi-compact
```

## Development

```bash
npm install --ignore-scripts --legacy-peer-deps
npm rebuild node-pty
npm test
```

The tests run real Pi processes with scripted model responses. No provider credentials or paid inference are needed. Use a Pi version that supports model-only tools, `terminate`, and `agent_before_settle` compaction entries.
