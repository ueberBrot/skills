import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Duration, Effect, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HarnessError } from "../errors";
import {
  CODEX_EXECUTABLE_ENV,
  ISOLATION_FLAGS,
  sanitizedEnvironment,
} from "./auth";

const main = Effect.fnUntraced(function* main() {
  const environment = yield* sanitizedEnvironment();
  const path = yield* Path.Path;
  const executable = environment[CODEX_EXECUTABLE_ENV];
  const [action, ...args] = process.argv.slice(2);

  if (
    executable === undefined ||
    executable.length === 0 ||
    !path.isAbsolute(executable) ||
    action !== "exec"
  ) {
    return yield* new HarnessError({
      message: "Invalid Codex launcher configuration",
    });
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const child = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      [
        "--no-daemon",
        "exec",
        ...ISOLATION_FLAGS,
        ...args.map((argument) =>
          argument === "--experimental-json" ? "--json" : argument
        ),
      ],
      {
        detached: false,
        env: environment,
        extendEnv: false,
        forceKillAfter: Duration.millis(250),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      }
    )
  );

  return Number(yield* child.exitCode);
}, Effect.scoped);

if (import.meta.main) {
  BunRuntime.runMain(
    main().pipe(
      Effect.matchEffect({
        onFailure: () =>
          Console.error(
            "Codex launcher failed; diagnostics were not saved"
          ).pipe(Effect.as(1)),
        onSuccess: (code) => Effect.succeed(code),
      }),
      Effect.tap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        })
      ),
      Effect.provide(BunServices.layer)
    ),
    { disableErrorReporting: true }
  );
}
