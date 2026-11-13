import {
  Array as Arr,
  Effect,
  FileSystem,
  Predicate,
  Random,
  Record,
  Schema,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";

import type { JsonValue } from "../domain";

export const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  return Number(left > right);
};

export const defined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing validated value");
  }

  return value;
};

export const sha256 = Effect.fnUntraced(function* sha256(
  value: string | Uint8Array
) {
  const digest = yield* Digest.Digest;

  return yield* digest.digestHex(
    Digest.sha256,
    Predicate.isString(value) ? new TextEncoder().encode(value) : value
  );
});

export const readJson = Effect.fn("readJson")(function* readJson(
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
    yield* fs.readFileString(filePath)
  );
});

export const writeJson = Effect.fn("writeJson")(function* writeJson(
  filePath: string,
  value: JsonValue,
  space?: number
) {
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;

  const serialized = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Json, { space: space ?? 2 })
  )(value);

  const temporary = `${filePath}.${yield* random.uuidV4()}.tmp`;
  yield* Effect.gen(function* commitJson() {
    yield* fs.writeFileString(temporary, `${serialized}\n`);
    yield* fs.rename(temporary, filePath);
  }).pipe(
    Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore))
  );
});

export const canonicalJson = (value: JsonValue): string => {
  if (Arr.isArray<JsonValue>(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return JSON.stringify(value);
  }

  const fields = Record.toEntries<string, JsonValue>(value).toSorted(
    ([left], [right]) => compareText(left, right)
  );

  const members = fields.map(([key, item]) => {
    const encoded = canonicalJson(item);

    return `${JSON.stringify(key)}:${encoded}`;
  });

  return `{${members.join(",")}}`;
};

/** A seeded harness shuffle, separate from provider sampling. */
export const shuffle = <T>(values: readonly T[], seed: number | string) =>
  Random.shuffle(values).pipe(Random.withSeed(seed));
