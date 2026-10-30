import { Effect, Layer } from "effect";

import { HarnessError } from "../errors";
import { prepareConfiguredWriter } from "./registry";
import { Writer } from "./service";

import type { WriterConfig } from "./registry";
import type { PreparedWriter, WriterPlatform } from "./service";

export const prepareWriter = Effect.fn("prepareWriter")(
  function* prepareWriter(config: WriterConfig) {
    const context = yield* Effect.context<WriterPlatform>();

    const prepared: PreparedWriter = yield* prepareConfiguredWriter(config);

    const descriptor = Object.freeze({
      ...prepared.descriptor,
      command:
        prepared.descriptor.command === null
          ? null
          : Object.freeze([...prepared.descriptor.command]),
      files: Object.freeze([...prepared.descriptor.files]),
      metadata: Object.freeze(prepared.descriptor.metadata),
    });

    return Writer.of({
      descriptor,
      execute: (request, timeoutSeconds) =>
        prepared.execute(request, timeoutSeconds).pipe(Effect.provide(context)),
      validate: (configuration) =>
        prepared.validate(configuration).pipe(Effect.provide(context)),
    });
  },
  Effect.mapError((cause) =>
    cause._tag === "HarnessError"
      ? cause
      : new HarnessError({ message: "Could not prepare writer" })
  )
);

export const writerLayer = (config: WriterConfig) =>
  Layer.effect(Writer, prepareWriter(config));
