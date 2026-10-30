import { Effect, FileSystem, Path, Predicate, Schema } from "effect";

import { RunArtifactSchema, sampleKey } from "../domain";
import { HarnessError } from "../errors";

import type { CaseRecord, Result, RunArtifact } from "../domain";

const validateResult = (result: Result, record: CaseRecord): void => {
  if (
    result.language !== record.spec.language ||
    result.task !== record.spec.task ||
    result.split !== record.spec.split
  ) {
    throw new Error("Result metadata differs from the case metadata");
  }

  const hasOutput = result.output !== null && result.output.trim().length > 0;
  const hasError = result.error !== null && result.error.trim().length > 0;

  if (
    result.status === "success" &&
    (!hasOutput || result.error !== null || result.error_stage !== null)
  ) {
    throw new Error("Successful result must contain output and no error");
  }

  if (result.status !== "error") {
    return;
  }

  const validErrorOutput =
    result.error_stage === "evaluation"
      ? hasOutput
      : result.error_stage === "execution" && result.output === null;

  if (
    !hasError ||
    !validErrorOutput ||
    result.anchors_pass !== null ||
    result.missing_anchors.length !== 0
  ) {
    throw new Error(
      "Failed result must identify its error; only evaluation failures retain output without an anchor verdict"
    );
  }
};

export interface RunView {
  readonly artifact: RunArtifact;
  readonly cases: ReadonlyMap<string, CaseRecord>;
  readonly results: ReadonlyMap<string, Result>;
}

export const inspectRun = (run: RunArtifact): RunView => {
  const { conditions } = run.manifest;

  if (
    conditions.length === 0 ||
    new Set(conditions).size !== conditions.length
  ) {
    throw new Error("Run conditions must be nonempty and unique");
  }

  const cases = new Map(run.cases.map((record) => [record.fixture.id, record]));

  if (cases.size !== run.cases.length) {
    throw new Error("Duplicate case IDs in run");
  }

  for (const record of cases.values()) {
    if (record.fixture.id !== record.spec.id) {
      throw new Error("Fixture and metadata IDs differ");
    }
  }

  const results = new Map<string, Result>();

  for (const result of run.results) {
    const record = cases.get(result.case_id);

    if (!record || !conditions.includes(result.condition)) {
      throw new Error("Result references an unknown case or condition");
    }

    if (result.repetition > run.manifest.repetitions) {
      throw new Error("Result repetition exceeds the run manifest");
    }

    const key = sampleKey(result.case_id, result.repetition, result.condition);

    if (results.has(key)) {
      throw new Error("Duplicate case/condition/repetition result");
    }

    validateResult(result, record);
    results.set(key, result);
  }

  const expected = cases.size * conditions.length * run.manifest.repetitions;

  if (run.manifest.completed_at !== null && results.size !== expected) {
    throw new Error("Completed run is missing expected sample results");
  }

  return { artifact: run, cases, results };
};

export const loadRun = Effect.fn("loadRun")(function* loadRun(
  location: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const input = path.resolve(location);
  const info = yield* fs.stat(input);
  const file = info.type === "Directory" ? path.join(input, "run.json") : input;

  const artifact = yield* Schema.decodeEffect(
    Schema.fromJsonString(RunArtifactSchema)
  )(yield* fs.readFileString(file), { onExcessProperty: "error" });

  const view = yield* Effect.try({
    catch: (error) =>
      new HarnessError({
        message: Predicate.isError(error) ? error.message : String(error),
      }),
    try: () => inspectRun(artifact),
  });

  return {
    artifact: view.artifact,
    directory: path.dirname(file),
    file,
    inputs: [file],
    view,
  };
});
