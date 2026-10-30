import type { ReasoningLevel } from "@tanstack/ai";
import type { CodexModel } from "@tanstack/ai-codex";

const profile = {
  concurrency: 2,
  logEvents: true,
  model: "gpt-6.1-terra" satisfies CodexModel,
  repetitions: 1,
  seed: 42,
  settings: {
    model_reasoning_effort: "medium" satisfies ReasoningLevel,
  },
  timeout: 300,
};

process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
