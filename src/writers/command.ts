import { Effect, FileSystem, Path, Schema } from "effect";

import { WriterOutputSchema } from "../domain";
import { HarnessError } from "../errors";
import { captureProcess } from "../internal/process";
import { environmentWithoutApiKeys } from "./environment";

import type { WriterInput } from "../domain";
import type { PreparedWriter } from "./service";

const runtimeValueFlags = new Set([
  "-r",
  "--require",
  "--preload",
  "--loader",
  "--experimental-loader",
  "--import",
  "--env-file",
  "--env-file-if-exists",
  "--conditions",
  "--input-type",
]);

const runtimeBooleanFlags = new Set([
  "--bun",
  "--enable-source-maps",
  "--experimental-strip-types",
  "--experimental-transform-types",
]);

const runtimeFlag = (argument: string): boolean =>
  argument.startsWith("--no-") ||
  runtimeBooleanFlags.has(argument) ||
  (argument.startsWith("--") && argument.includes("="));

const launcherScriptIndex = (
  runtime: string,
  args: readonly string[]
): number => {
  if (!/^(?:bun|node|nodejs|tsx|ts-node)(?:\.exe)?$/u.test(runtime)) {
    return -1;
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";

    if (/^(?:--(?:eval|print|cwd)(?:=|$)|-[epC])/u.test(argument)) {
      return -1;
    }

    if (argument === "--") {
      return index + 1;
    }

    if (runtimeValueFlags.has(argument)) {
      index += 1;
    } else if (
      !runtimeFlag(argument) &&
      !(runtime === "bun" && argument === "run")
    ) {
      return argument.startsWith("-") ? -1 : index;
    }
  }

  return -1;
};

export const prepareCommand = Effect.fnUntraced(function* prepareCommand(
  argv: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [requested, ...args] = argv;

  const executable =
    requested === undefined || requested === "" ? null : Bun.which(requested);

  if (executable === null) {
    return yield* new HarnessError({
      message: "Executor executable not found",
    });
  }

  const files = [executable];

  const runtime =
    executable === process.execPath ? "bun" : path.basename(executable);

  const scriptIndex = launcherScriptIndex(runtime, args);

  for (const [index, argument] of args.entries()) {
    if (
      /\.(?:ts|js|mjs|cjs)$/u.test(argument) &&
      (yield* fs.exists(argument))
    ) {
      const absolute = path.resolve(argument);
      files.push(absolute);

      if (index === scriptIndex) {
        args[index] = absolute;
      }
    }
  }

  const command = [executable, ...args];
  const environment = environmentWithoutApiKeys(process.env);

  const execute = Effect.fnUntraced(
    function* executeCommand(request: WriterInput, timeoutSeconds: number) {
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "skills-command-",
      });

      const response = yield* captureProcess(
        command,
        JSON.stringify(request),
        directory,
        timeoutSeconds,
        environment
      );

      if (response.code !== 0) {
        return yield* new HarnessError({
          message: `Executor failed with exit code ${response.code}`,
        });
      }

      return yield* Schema.decodeEffect(
        Schema.fromJsonString(WriterOutputSchema)
      )(response.stdout, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () =>
            new HarnessError({
              message: "Executor returned an invalid writing response",
            })
        )
      );
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "HarnessError"
        ? cause
        : new HarnessError({ message: "Could not start executor" })
    )
  );

  return {
    descriptor: {
      command,
      files,
      metadata: { authentication: "adapter-defined", backend: "command" },
      name: "command",
    },
    execute,
    validate: () => Effect.void,
  } satisfies PreparedWriter;
});
