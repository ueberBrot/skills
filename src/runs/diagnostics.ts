import { Cause, Clock, Effect, Exit, Logger, References } from "effect";

import type { Result, RunArtifact } from "../domain";

type RunIdentity = Pick<
  RunArtifact["manifest"],
  "mode" | "run_id" | "skill_name" | "suite"
>;

type SampleIdentity = Pick<Result, "case_id" | "condition" | "repetition">;

type DiagnosticEvent =
  | { readonly name: "run.started" }
  | {
      readonly name: "run.completed";
      readonly status: "success" | "error";
      readonly results: number;
      readonly execution_errors: number;
      readonly evaluation_errors: number;
      readonly literal_failures: number;
    }
  | { readonly name: "run.failed" | "run.interrupted"; readonly stage: "run" }
  | ({ readonly name: "sample.started" } & SampleIdentity)
  | ({ readonly name: "sample.completed" } & SampleIdentity &
      Pick<Result, "duration_seconds" | "status" | "error_stage">);

export type RunDiagnostics = (event: DiagnosticEvent) => Effect.Effect<void>;

export const withRunDiagnostics = Effect.fnUntraced(
  function* withRunDiagnostics<A, E, R>(
    enabled: boolean,
    file: string,
    identity: RunIdentity,
    run: (emit: RunDiagnostics) => Effect.Effect<A, E, R>
  ) {
    if (!enabled) {
      return yield* run(() => Effect.void);
    }

    const logger = yield* Logger.toFile(Logger.formatJson, file, {
      flag: "wx",
      mode: 0o600,
    });

    const started = yield* Clock.currentTimeNanos;

    const metadata = {
      mode: identity.mode,
      run_id: identity.run_id,
      skill_name: identity.skill_name,
      suite: identity.suite,
    };

    const emit = Effect.fnUntraced(function* emit(event: DiagnosticEvent) {
      const { name, ...fields } = event;

      const terminal =
        name === "run.completed" ||
        name === "run.failed" ||
        name === "run.interrupted";

      const duration = terminal
        ? {
            duration_seconds:
              Number((yield* Clock.currentTimeNanos) - started) / 1e9,
          }
        : {};

      return yield* Effect.logInfo(name).pipe(
        Effect.provideService(References.CurrentLogAnnotations, {
          ...metadata,
          ...fields,
          ...duration,
        }),
        Effect.provideService(References.CurrentLogSpans, []),
        Effect.provideService(References.MinimumLogLevel, "All"),
        Effect.provide(Logger.layer([logger]))
      );
    });

    yield* emit({ name: "run.started" });

    return yield* run(emit).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? emit({
              name: Cause.hasInterruptsOnly(exit.cause)
                ? "run.interrupted"
                : "run.failed",
              stage: "run",
            })
          : Effect.void
      )
    );
  },
  Effect.scoped
);
