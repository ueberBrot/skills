import { Effect, FileSystem, Path, Schema } from "effect";
import { forEach as traverse } from "effect/Effect";

import { CONDITIONS, WriterOutputSchema } from "../domain";
import { HarnessError } from "../errors";
import { sha256 } from "../internal/json";

import type { Condition, WriterOutput } from "../domain";
import type { LoadedSuite } from "../suites";
import type { Writer } from "../writers";

export type ReplaySources = Partial<Record<Condition, string>>;

export type RunSource =
  | {
      readonly _tag: "Live";
      readonly writer: Writer["Service"];
      readonly conditions: readonly Condition[];
      readonly repetitions: number;
      readonly timeout: number;
    }
  | {
      readonly _tag: "Recorded";
      readonly outputs: ReadonlyMap<
        Condition,
        ReadonlyMap<string, WriterOutput>
      >;
      readonly provenance: Readonly<Record<string, string>>;
    };

export const loadRecordings = Effect.fnUntraced(function* loadRecordings(
  suite: LoadedSuite,
  sources: ReplaySources
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = new Set(suite.cases.map((record) => record.fixture.id));
  const provenance: Record<string, string> = {};
  const recordings = new Map<string, ReadonlyMap<string, WriterOutput>>();

  const pairs = yield* traverse(
    CONDITIONS,
    Effect.fnUntraced(function* loadCondition(condition) {
      const source = sources[condition];

      if (source === undefined || source === "") {
        return null;
      }

      const file = path.resolve(source);
      const cached = recordings.get(file);

      if (cached !== undefined) {
        return [condition, cached] as const;
      }

      const bytes = yield* fs.readFile(file);

      const values = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({ id: Schema.String, ...WriterOutputSchema.fields })
          )
        )
      )(new TextDecoder().decode(bytes), { onExcessProperty: "error" });

      const outputs = new Map<string, WriterOutput>();

      for (const { id, ...response } of values) {
        if (outputs.has(id)) {
          return yield* new HarnessError({
            message: `Duplicate recorded output ID: ${id}`,
          });
        }

        outputs.set(id, response);
      }

      if (
        outputs.size !== expected.size ||
        [...expected].some((id) => !outputs.has(id))
      ) {
        return yield* new HarnessError({
          message:
            "Recorded output IDs must exactly match selected suite cases",
        });
      }

      provenance[file] = sha256(bytes);
      recordings.set(file, outputs);

      return [condition, outputs] as const;
    })
  );

  return {
    _tag: "Recorded",
    outputs: new Map(pairs.flatMap((pair) => (pair === null ? [] : [pair]))),
    provenance,
  } satisfies RunSource;
});
