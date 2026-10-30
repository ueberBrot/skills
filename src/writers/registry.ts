import { Record } from "effect";

import { prepareCodex } from "./codex";
import { prepareCommand } from "./command";

import type { HarnessError } from "../errors";
import type { PreparedWriter, WriterPlatform } from "./service";
import type { Effect } from "effect";

const builtinWriters = {
  codex: prepareCodex,
} satisfies Record<
  string,
  () => Effect.Effect<PreparedWriter, HarnessError, WriterPlatform>
>;

type BuiltinWriterName = keyof typeof builtinWriters;

export const builtinWriterNames = Object.freeze(Record.keys(builtinWriters));

export type WriterConfig =
  | { readonly _tag: "Builtin"; readonly name: BuiltinWriterName }
  | { readonly _tag: "Command"; readonly argv: readonly string[] };

export const prepareConfiguredWriter = (config: WriterConfig) =>
  config._tag === "Command"
    ? prepareCommand(config.argv)
    : builtinWriters[config.name]();
