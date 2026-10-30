import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Schema } from "effect";

import { acquireGradingOwnership } from "../../src/assessment/ownership";

const owner = Effect.gen(function* holdOwnership() {
  const directory = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
    process.argv[2]
  );

  yield* acquireGradingOwnership(directory);
  yield* Console.log("owned");

  return yield* Effect.never;
});

BunRuntime.runMain(
  owner.pipe(Effect.scoped, Effect.provide(BunServices.layer))
);
