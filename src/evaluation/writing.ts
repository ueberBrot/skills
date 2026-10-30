import { Effect, FileSystem, Path, Schema } from "effect";

import { HarnessError } from "../errors";
import { captureProcess } from "../internal/process";

import type { ChildProcessSpawner } from "effect/process";

const AnchorResultSchema = Schema.Struct({
  all_selected_anchors_present: Schema.Boolean,
  missing_from_rewrite: Schema.Array(Schema.String),
  note: Schema.String,
  selected_anchor_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  semantic_equivalence_checked: Schema.Literal(false),
});

export type WritingAssessment = typeof AnchorResultSchema.Type;

export type WritingPlatform =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export const assessWriting = Effect.fn("assessWriting")(
  function* assessWriting(
    helper: Uint8Array | null,
    source: string,
    output: string,
    anchors: readonly string[]
  ) {
    if (anchors.length === 0) {
      return null;
    }

    if (helper === null) {
      return yield* new HarnessError({
        message: "An anchor helper is required",
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "skills-anchors-",
    });

    const script = path.join(directory, "helper.py");
    const before = path.join(directory, "before.txt");
    const after = path.join(directory, "after.txt");
    const manifest = path.join(directory, "anchors.json");

    yield* Effect.all(
      [
        fs.writeFile(script, helper),
        fs.writeFileString(before, source),
        fs.writeFileString(after, output),
        fs.writeFileString(manifest, JSON.stringify(anchors)),
      ],
      { concurrency: "unbounded" }
    );

    const result = yield* captureProcess(
      ["python3", script, before, after, "--anchors", manifest],
      "",
      directory,
      10
    );

    if (result.code !== 0 && result.code !== 1) {
      return yield* new HarnessError({ message: "Anchor helper failed" });
    }

    const parsed = yield* Schema.decodeEffect(
      Schema.fromJsonString(AnchorResultSchema)
    )(result.stdout, { onExcessProperty: "error" });

    if ((result.code === 0) !== parsed.all_selected_anchors_present) {
      return yield* new HarnessError({
        message: "Anchor helper returned inconsistent results",
      });
    }

    return parsed;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "HarnessError"
      ? cause
      : new HarnessError({ message: cause.message })
  )
);
