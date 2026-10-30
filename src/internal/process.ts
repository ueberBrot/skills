import { Duration, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HarnessError } from "../errors";

export const captureProcess = Effect.fn("captureProcess")(
  function* captureProcess(
    command: readonly string[],
    input: string,
    cwd: string,
    timeoutSeconds: number,
    environment: Record<string, string | undefined> = process.env
  ) {
    const [executable, ...args] = command;

    if (
      executable === undefined ||
      executable === "" ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0
    ) {
      return yield* new HarnessError({
        message: "An executable and positive finite timeout are required",
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.gen(function* collectProcess() {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, args, {
          cwd,
          env: environment,
          extendEnv: false,
          forceKillAfter: "100 millis",
          killSignal: "SIGKILL",
          stderr: "ignore",
          stdin: Stream.make(new TextEncoder().encode(input)),
          stdout: "pipe",
        })
      );

      return yield* Effect.all(
        {
          code: child.exitCode.pipe(Effect.map(Number)),
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: "unbounded" }
      );
    }).pipe(
      Effect.scoped,
      Effect.timeout(Duration.seconds(timeoutSeconds)),
      Effect.mapError(
        (error) =>
          new HarnessError({
            message:
              error._tag === "TimeoutError"
                ? "Executor timed out"
                : "Could not start executor",
          })
      )
    );
  }
);
