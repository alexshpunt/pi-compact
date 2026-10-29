# pi-compact

One agent tool: `compact({ message })`.

Use it at a meaningful milestone, such as moving from planning to implementation, from implementation to integration or testing, or from one completed feature to the next.

The tool ends the current agent run and invokes Pi's native compaction, including Pi's own check for whether there is anything to compact. After success, it sends `message` verbatim as a `compact-continuation` custom message and starts the next run. The continuation is extension-authored and does not create a user-role message or change the user's request. Keep the message short: include the next action and any facts that need special attention. Pi summarizes the session during compaction, so do not repeat the session summary.

If Pi has nothing to compact, or compaction fails or is cancelled, the agent receives Pi's reason and continues with the existing context. The continuation message is sent only after successful compaction. An aborted agent run discards its scheduled compaction. Switching sessions invalidates pending work and callbacks.

There are no context thresholds, tool locks, custom summarizer, commands, skills, or footer. Pi's normal retention settings and per-model overrides apply. The tool is model-only so its end-of-run behavior cannot be lost inside a Codemode script; call it directly, by itself.

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

The tests run real Pi processes with scripted model responses. No provider credentials or paid inference are needed. Use a Pi version that supports model-only tools, `terminate`, and `agent_settled`.
