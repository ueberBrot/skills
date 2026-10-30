import { Context } from "effect";

import type { JsonObject, WriterInput, WriterOutput } from "../domain";
import type { HarnessError } from "../errors";
import type { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";

export type WriterPlatform =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface WriterDescriptor {
  readonly name: string;
  readonly command: readonly string[] | null;
  readonly files: readonly string[];
  readonly metadata: JsonObject;
}

export type WriterConfiguration = Pick<WriterInput, "model" | "settings">;

export interface PreparedWriter {
  readonly descriptor: WriterDescriptor;
  readonly validate: (
    configuration: WriterConfiguration
  ) => Effect.Effect<void, HarnessError, WriterPlatform>;
  readonly execute: (
    request: WriterInput,
    timeoutSeconds: number
  ) => Effect.Effect<WriterOutput, HarnessError, WriterPlatform>;
}

export class Writer extends Context.Service<
  Writer,
  {
    readonly descriptor: WriterDescriptor;
    readonly validate: (
      configuration: WriterConfiguration
    ) => Effect.Effect<void, HarnessError>;
    readonly execute: (
      request: WriterInput,
      timeoutSeconds: number
    ) => Effect.Effect<WriterOutput, HarnessError>;
  }
>()("skills/Writer") {}
