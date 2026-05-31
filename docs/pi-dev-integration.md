# Pi Dev Integration

The package is a Pi extension registered through `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

It intentionally registers only one visible command:

```text
/analyst-worker
```

No prompt-template or skill slash commands are registered, so autocomplete stays clean.

## Models and thinking levels

The setup chooses and saves:

- Analyst model;
- Analyst thinking level;
- Worker model;
- Worker thinking level;
- Analyst compaction threshold;
- Worker compaction threshold.

Settings are stored in both:

```text
.pi/analyst-worker.json
~/.pi/agent/analyst-worker.json
```

Local project settings override global settings.

## OpenAI Codex analyst turns

For `openai-codex/*` Analyst models, the extension can run Analyst turns through a short child `pi` process with proxy environment enabled. Worker turns stay in the main Pi session so tools work normally.
