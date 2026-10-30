import { Schema } from "effect";

import { CONDITIONS, RunArtifactSchema } from "../src/domain";

import type { RunArtifact } from "../src/domain";

export const sampleRun = (): RunArtifact => {
  const cases = (
    [
      ["first-case", "en"],
      ["second-case", "de"],
    ] as const
  ).map(([id, language]) => ({
    checks: ["The waiting period and retry condition remain unchanged."],
    fixture: {
      id,
      request: "Make this email clearer.",
      source: "Grüße: please wait 24 hours before retrying.",
    },
    spec: {
      anchors: ["24 hours"],
      id,
      language,
      provenance: "synthetic-regression",
      reader_questions: ["How long should the reader wait?"],
      task: "email",
    },
  }));

  return Schema.decodeUnknownSync(RunArtifactSchema)({
    cases,
    manifest: {
      completed_at: "2026-10-28T12:01:00+00:00",
      concurrency: 1,
      conditions: [...CONDITIONS],
      file_hashes: { "private-file-identity": "abc123" },
      limitations: [],
      mode: "execute",
      package_versions: {},
      repetitions: 1,
      requested_model: "private-model-identity",
      run_id: "private-run-identity",
      schema_version: 2,
      seed: 42,
      skill_name: "private-skill-name",
      skill_version: "private-skill-version",
      started_at: "2026-10-28T12:00:00+00:00",
      suite: "private-suite-identity",
    },
    results: cases.flatMap((record) =>
      CONDITIONS.map((condition, index) => ({
        anchors_pass: true,
        case_id: record.fixture.id,
        condition,
        duration_seconds: 1,
        language: record.spec.language,
        output: `Grüße — ${["first", "second", "third"][index]}: wait 24 hours before retrying.\nThank you.`,
        repetition: 1,
        reported_model: "private-model-identity",
        split: "development",
        status: "success",
        task: record.spec.task,
      }))
    ),
  });
};
