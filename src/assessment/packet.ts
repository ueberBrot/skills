import { Effect, Exit, FileSystem, Option, Path } from "effect";

import { HarnessError } from "../errors";
import { loadRun } from "../runs";
import { planReview } from "./plan";

import type { Condition } from "../domain";
import type { RunView } from "../runs";

interface ReviewOptions {
  readonly conditions?: readonly Condition[];
}

const exists = Effect.fnUntraced(function* exists(target: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.lstat(target).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false))
  );
});

const removeOwned = Effect.fnUntraced(function* removeOwned(
  target: string,
  owned: FileSystem.File.Info
) {
  const fs = yield* FileSystem.FileSystem;

  const current = yield* fs
    .lstat(target)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(null)
      )
    );

  if (
    current === null ||
    Option.isNone(current.ino) ||
    Option.isNone(owned.ino)
  ) {
    return;
  }

  if (current.dev === owned.dev && current.ino.value === owned.ino.value) {
    yield* fs.remove(target, { recursive: owned.type === "Directory" });
  }
});

const writeReviewPacket = Effect.fn("writeReviewPacket")(
  function* writeReviewPacket(
    view: RunView,
    outputDir: string,
    seed: number,
    options: ReviewOptions
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const decodingPath = path.join(
      path.dirname(outputDir),
      `${path.basename(outputDir)}-decoding.json`
    );

    if ((yield* exists(outputDir)) || (yield* exists(decodingPath))) {
      return yield* new HarnessError({
        message: "Review output or private decoding already exists",
      });
    }

    const packet = yield* planReview(view, seed, options.conditions);

    if (!packet.decoding.trials.length) {
      return yield* new HarnessError({
        message: "No complete successful comparison groups to review",
      });
    }

    const parent = path.dirname(outputDir);
    yield* fs.makeDirectory(parent, { recursive: true });

    const staging = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: `.${path.basename(outputDir)}-`,
    });

    const publicFiles: (readonly [string, string])[] = [
      ["comparisons.json", `${JSON.stringify(packet.comparisons, null, 2)}\n`],
      ["judgments.json", `${JSON.stringify(packet.judgments, null, 2)}\n`],
      [
        "comprehension.json",
        `${JSON.stringify(packet.comprehension, null, 2)}\n`,
      ],
    ];

    for (const [name, contents] of publicFiles) {
      yield* fs.writeFileString(path.join(staging, name), contents, {
        flag: "wx",
        mode: 0o600,
      });
    }

    const stagedDecoding = path.join(staging, "decoding.json");
    yield* fs.writeFileString(
      stagedDecoding,
      `${JSON.stringify(packet.decoding, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );

    const decodingIdentity = yield* fs.lstat(stagedDecoding);

    yield* Effect.acquireRelease(
      fs
        .makeDirectory(outputDir, { mode: 0o700 })
        .pipe(
          Effect.andThen(
            fs
              .lstat(outputDir)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? fs
                        .remove(outputDir, { recursive: true })
                        .pipe(Effect.ignore)
                    : Effect.void
                )
              )
          )
        ),
      (owned, exit) =>
        Exit.isFailure(exit)
          ? removeOwned(outputDir, owned).pipe(Effect.ignore)
          : Effect.void
    );

    for (const [name] of publicFiles) {
      yield* fs.link(path.join(staging, name), path.join(outputDir, name));
    }

    yield* Effect.acquireRelease(
      fs.link(stagedDecoding, decodingPath),
      (_, exit) =>
        Exit.isFailure(exit)
          ? removeOwned(decodingPath, decodingIdentity).pipe(Effect.ignore)
          : Effect.void
    );

    return outputDir;
  },
  Effect.scoped
);

export const exportReview = Effect.fn("exportReview")(function* exportReview(
  options: ReviewOptions & {
    readonly run: string;
    readonly out: string;
    readonly seed?: number;
  }
) {
  const path = yield* Path.Path;
  const loaded = yield* loadRun(options.run);
  const output = path.resolve(options.out);
  yield* writeReviewPacket(loaded.view, output, options.seed ?? 42, options);

  return { review: output };
});
