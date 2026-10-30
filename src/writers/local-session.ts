import {
  defineSandbox,
  defineWorkspace,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { Effect } from "effect";

import { HarnessError } from "../errors";
import { consumeCompletion } from "./completion";

import type { StreamChunk } from "@tanstack/ai";

interface LocalSessionOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly passEnv: readonly string[];
  readonly scrubEnv: readonly string[];
}

interface LocalSession {
  readonly abortController: AbortController;
  readonly adapterEnvironment: Record<string, string>;
  readonly middleware: [ReturnType<typeof withSandbox>];
  readonly runId: string;
  readonly threadId: string;
}

// The local provider manages workspaces/processes; agent permissions belong to the adapter.
export const runLocalSession = Effect.fn("runLocalSession")(
  function* runLocalSession(
    options: LocalSessionOptions,
    openStream: (session: LocalSession) => AsyncIterable<StreamChunk>
  ) {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (value) =>
        Effect.sync(() => {
          value.abort();
        })
    );

    const passEnv = options.passEnv.filter((key) => key in options.environment);

    const scrubEnv = [
      ...Object.keys(process.env).filter(
        (key) => !(key in options.environment)
      ),
      ...options.scrubEnv,
    ];

    const sandbox = defineSandbox({
      fileEvents: false,
      id: crypto.randomUUID(),
      lifecycle: { destroyOnComplete: true, reuse: "none" },
      provider: localProcessSandbox({ passEnv, scrubEnv }),
      workspace: defineWorkspace({ source: { type: "none" } }),
    });

    const identity = {
      runId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
    };

    // Early RUN_ERROR consumption can bypass the middleware's teardown hook.
    // This runs after the iterator closes; destroy is a no-op for removed sessions.
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        catch: () =>
          new HarnessError({
            message: "Could not release the agent workspace",
          }),
        try: async () => {
          await sandbox.destroy(identity);
        },
      }).pipe(Effect.ignore)
    );

    const stream = yield* Effect.try({
      catch: () =>
        new HarnessError({
          message: "Agent execution failed; diagnostics were not saved",
        }),
      try: () =>
        openStream({
          abortController: controller,
          adapterEnvironment: Object.fromEntries(
            Object.entries(options.environment).filter(([key]) =>
              passEnv.includes(key)
            )
          ),
          middleware: [withSandbox(sandbox)],
          ...identity,
        }),
    });

    // Consume and close the lazy stream before this session's scope ends.
    return yield* consumeCompletion(stream, controller);
  },
  Effect.scoped
);
