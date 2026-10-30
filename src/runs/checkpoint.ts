import { DateTime, Effect, Path, Semaphore } from "effect";

import { compareText, writeJson } from "../internal/json";

import type { Result, RunArtifact } from "../domain";
import type { Crypto, FileSystem } from "effect";

/** Publish immutable candidate snapshots; only successful renames advance state. */
export const initializeCheckpoint = Effect.fnUntraced(
  function* initializeCheckpoint(outputDir: string, artifact: RunArtifact) {
    const path = yield* Path.Path;
    const file = path.join(outputDir, "run.json");
    const lock = yield* Semaphore.make(1);

    const context = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem
    >();

    yield* writeJson(file, artifact, 0);

    const commit = Effect.fnUntraced(function* commit(result: Result) {
      return yield* lock
        .withPermits(1)(
          Effect.gen(function* publishResult() {
            const results = [...artifact.results, result];
            yield* writeJson(file, { ...artifact, results }, 0);
            artifact.results = results;
          })
        )
        .pipe(Effect.uninterruptible, Effect.provide(context));
    });

    const complete = Effect.fnUntraced(function* complete() {
      return yield* lock
        .withPermits(1)(
          Effect.gen(function* publishCompletion() {
            const results = artifact.results.toSorted(
              (left, right) =>
                compareText(left.case_id, right.case_id) ||
                compareText(left.condition, right.condition) ||
                left.repetition - right.repetition
            );

            const completedAt = DateTime.formatIso(yield* DateTime.now);
            yield* writeJson(
              file,
              {
                ...artifact,
                manifest: { ...artifact.manifest, completed_at: completedAt },
                results,
              },
              0
            );
            artifact.results = results;
            artifact.manifest.completed_at = completedAt;
          })
        )
        .pipe(Effect.uninterruptible, Effect.provide(context));
    });

    return { artifact, commit, complete };
  }
);
