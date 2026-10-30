import { Clock, DateTime, Effect, Path, Schema } from "effect";
import { forEach as traverse } from "effect/Effect";

import { ResultSchema, sampleKey } from "../domain";
import { defined, shuffle, writeJson } from "../internal/json";
import { initializeCheckpoint } from "./checkpoint";

import type {
  CaseRecord,
  Condition,
  RunArtifact,
  WriterInput,
  WriterOutput,
} from "../domain";
import type { HarnessError } from "../errors";
import type { LoadedSuite } from "../suites";
import type { RunDiagnostics } from "./diagnostics";
import type { RunSource } from "./sources";

type SampleOutcome =
  | {
      readonly _tag: "Completed";
      readonly response: WriterOutput;
      readonly anchors: {
        readonly all_selected_anchors_present: boolean;
        readonly missing_from_rewrite: readonly string[];
      } | null;
    }
  | { readonly _tag: "ExecutionFailed"; readonly message: string }
  | {
      readonly _tag: "EvaluationFailed";
      readonly message: string;
      readonly response: WriterOutput;
    };

const collectOutcome = Effect.fnUntraced(function* collectOutcome(
  execute: Effect.Effect<WriterOutput, HarnessError>,
  assess: (output: string) => ReturnType<LoadedSuite["assess"]>
) {
  return yield* execute.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed({
          _tag: "ExecutionFailed",
          message: error.message,
        } satisfies SampleOutcome),
      onSuccess: (response) =>
        assess(response.output).pipe(
          Effect.match({
            onFailure: (error) =>
              ({
                _tag: "EvaluationFailed",
                message: error.message,
                response,
              }) satisfies SampleOutcome,
            onSuccess: (anchors) =>
              ({
                _tag: "Completed",
                anchors,
                response,
              }) satisfies SampleOutcome,
          })
        ),
    })
  );
});

const outcomeResult = Effect.fnUntraced(function* outcomeResult(
  record: CaseRecord,
  condition: Condition,
  repetition: number,
  startedAt: string,
  startedNanos: bigint,
  outcome: SampleOutcome
) {
  const response = outcome._tag === "ExecutionFailed" ? null : outcome.response;
  const anchors = outcome._tag === "Completed" ? outcome.anchors : null;

  const errorStages: Record<
    SampleOutcome["_tag"],
    "execution" | "evaluation" | null
  > = {
    Completed: null,
    EvaluationFailed: "evaluation",
    ExecutionFailed: "execution",
  };

  return yield* Schema.decodeEffect(ResultSchema)(
    {
      anchors_pass: anchors?.all_selected_anchors_present ?? null,
      case_id: record.fixture.id,
      completed_at: DateTime.formatIso(yield* DateTime.now),
      condition,
      duration_seconds:
        Number((yield* Clock.currentTimeNanos) - startedNanos) / 1e9,
      error: outcome._tag === "Completed" ? null : outcome.message,
      error_stage: errorStages[outcome._tag],
      executor_metadata: response?.executor_metadata ?? null,
      language: record.spec.language,
      missing_anchors: [...(anchors?.missing_from_rewrite ?? [])],
      output: response?.output ?? null,
      repetition,
      reported_model: response?.model ?? null,
      reported_settings: response?.settings ?? null,
      split: record.spec.split,
      started_at: startedAt,
      status: outcome._tag === "Completed" ? "success" : "error",
      task: record.spec.task,
      usage: response?.usage ?? null,
    },
    { onExcessProperty: "error" }
  );
});

export const runSamples = Effect.fnUntraced(function* runSamples(
  suite: LoadedSuite,
  outputDir: string,
  manifest: RunArtifact["manifest"],
  source: RunSource,
  emit: RunDiagnostics
) {
  const path = yield* Path.Path;

  const artifact: RunArtifact = {
    cases: [...suite.cases],
    manifest,
    results: [],
  };

  const jobs = yield* shuffle(
    suite.cases.flatMap((record) =>
      manifest.conditions.flatMap((condition) =>
        Array.from({ length: manifest.repetitions }, (_, index) => ({
          condition,
          record,
          repetition: index + 1,
        }))
      )
    ),
    manifest.seed
  );

  const prompts = Object.fromEntries(
    jobs.map(({ record, condition, repetition }) => [
      sampleKey(record.fixture.id, repetition, condition),
      {
        model: manifest.requested_model,
        prompt: suite.promptFor(record.fixture.id, condition),
        settings: manifest.requested_settings,
      } satisfies WriterInput,
    ])
  );

  yield* writeJson(path.join(outputDir, "prompts.json"), prompts);
  const checkpoint = yield* initializeCheckpoint(outputDir, artifact);

  yield* traverse(
    jobs,
    Effect.fnUntraced(function* evaluateSample({
      record,
      condition,
      repetition,
    }) {
      const request = defined(
        prompts[sampleKey(record.fixture.id, repetition, condition)]
      );

      const start = yield* Clock.currentTimeNanos;
      const startedAt = DateTime.formatIso(yield* DateTime.now);

      yield* emit({
        case_id: record.fixture.id,
        condition,
        name: "sample.started",
        repetition,
      });

      const execute =
        source._tag === "Live"
          ? source.writer.execute(request, source.timeout)
          : Effect.succeed(
              defined(
                defined(source.outputs.get(condition)).get(record.fixture.id)
              )
            );

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* persistEvaluatedSample() {
          const outcome = yield* restore(
            collectOutcome(execute, suite.assess.bind(suite, record.fixture.id))
          );

          const result = yield* outcomeResult(
            record,
            condition,
            repetition,
            startedAt,
            start,
            outcome
          );

          yield* checkpoint.commit(result);

          yield* emit({
            case_id: result.case_id,
            condition: result.condition,
            duration_seconds: result.duration_seconds,
            error_stage: result.error_stage,
            name: "sample.completed",
            repetition: result.repetition,
            status: result.status,
          });
        })
      );
    }),
    { concurrency: manifest.concurrency }
  );

  yield* checkpoint.complete();

  const executionErrors = artifact.results.filter(
    (result) => result.error_stage === "execution"
  ).length;

  const evaluationErrors = artifact.results.filter(
    (result) => result.error_stage === "evaluation"
  ).length;

  const literalFailures = artifact.results.filter(
    (result) => result.anchors_pass === false
  ).length;

  yield* emit({
    evaluation_errors: evaluationErrors,
    execution_errors: executionErrors,
    literal_failures: literalFailures,
    name: "run.completed",
    results: artifact.results.length,
    status:
      executionErrors || evaluationErrors || literalFailures
        ? "error"
        : "success",
  });

  return {
    artifact,
    exitCode: executionErrors || evaluationErrors || literalFailures ? 1 : 0,
    summary: {
      evaluation_errors: evaluationErrors,
      execution_errors: executionErrors,
      fidelity: "not_assessed",
      literal_failures: literalFailures,
      results: artifact.results.length,
      run: outputDir,
    },
  };
});
