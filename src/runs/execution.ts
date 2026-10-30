import { Effect, FileSystem, Path, Schema } from "effect";

import { CONDITIONS } from "../domain";
import { HarnessError } from "../errors";
import { Writer } from "../writers";
import { withRunDiagnostics } from "./diagnostics";
import { makeManifest } from "./provenance";
import { runSamples } from "./samples";
import { loadRecordings } from "./sources";

import type { Condition, JsonObject } from "../domain";
import type { LoadedSuite } from "../suites";
import type { ReplaySources, RunSource } from "./sources";

interface EvaluationOptions {
  readonly logEvents?: boolean;
  readonly model?: string;
  readonly settings?: JsonObject;
  readonly seed?: number;
  readonly concurrency?: number;
}

export type ReplayOptions = EvaluationOptions;

export interface RunOptions extends EvaluationOptions {
  readonly conditions?: readonly Condition[];
  readonly repetitions?: number;
  readonly timeout?: number;
}

const EvaluationOptionsSchema = Schema.Struct({
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  seed: Schema.Int,
});

const ExecutionControlsSchema = Schema.Struct({
  repetitions: Schema.Int.check(Schema.isGreaterThan(0)),
  timeout: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const evaluate = Effect.fnUntraced(function* evaluate(
  suite: LoadedSuite,
  outputDir: string,
  supplied: EvaluationOptions,
  source: RunSource
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const options = {
    concurrency: 1,
    seed: 42,
    settings: {},
    ...supplied,
  };

  yield* Schema.decodeEffect(EvaluationOptionsSchema)(options).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          message: "Concurrency must be positive, and seed must be an integer",
        })
    )
  );

  const conditions =
    source._tag === "Live"
      ? source.conditions
      : CONDITIONS.filter((condition) => source.outputs.has(condition));

  const repetitions = source._tag === "Live" ? source.repetitions : 1;

  if (
    conditions.length === 0 ||
    new Set(conditions).size !== conditions.length ||
    conditions.some((condition) => !CONDITIONS.includes(condition))
  ) {
    return yield* new HarnessError({
      message: "Select distinct valid conditions",
    });
  }

  if (yield* fs.exists(outputDir)) {
    return yield* new HarnessError({
      message: `Refusing to overwrite run directory: ${outputDir}`,
    });
  }

  if (source._tag === "Live") {
    yield* source.writer.validate({
      model: options.model ?? null,
      settings: options.settings,
    });
  }

  const manifest = yield* makeManifest(
    suite,
    conditions,
    { ...options, repetitions },
    source._tag === "Live"
      ? {
          _tag: "Live",
          descriptor: source.writer.descriptor,
          timeout: source.timeout,
        }
      : { _tag: "Recorded", provenance: source.provenance }
  );

  yield* fs.makeDirectory(path.dirname(path.resolve(outputDir)), {
    recursive: true,
  });
  yield* fs.makeDirectory(outputDir).pipe(
    Effect.mapError(
      (error) =>
        new HarnessError({
          message:
            error.reason._tag === "AlreadyExists"
              ? `Refusing to overwrite run directory: ${outputDir}`
              : error.message,
        })
    )
  );

  return yield* withRunDiagnostics(
    options.logEvents ?? false,
    path.join(outputDir, "events.jsonl"),
    manifest,
    (emit) => runSamples(suite, outputDir, manifest, source, emit)
  );
});

export const executeSuite = Effect.fn("executeSuite")(function* executeSuite(
  suite: LoadedSuite,
  output: string,
  {
    conditions = CONDITIONS,
    repetitions = 1,
    timeout = 120,
    ...options
  }: RunOptions = {}
) {
  yield* Schema.decodeEffect(ExecutionControlsSchema)({
    repetitions,
    timeout,
  }).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          message: "Repetitions and timeout must be positive",
        })
    )
  );

  const writer = yield* Writer;

  return yield* evaluate(suite, output, options, {
    _tag: "Live",
    conditions,
    repetitions,
    timeout,
    writer,
  });
});

export const replaySuite = Effect.fn("replaySuite")(function* replaySuite(
  suite: LoadedSuite,
  output: string,
  sources: ReplaySources,
  options: ReplayOptions = {}
) {
  const recordings = yield* loadRecordings(suite, sources);

  return yield* evaluate(suite, output, options, recordings);
});
