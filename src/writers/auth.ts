import { Effect, FileSystem, Path } from "effect";

import { HarnessError } from "../errors";
import { REPO } from "../paths";
import { environmentWithoutApiKeys } from "./environment";

export const CODEX_EXECUTABLE_ENV = "UEBERBROT_SKILLS_CODEX_EXECUTABLE";

export const ISOLATION_FLAGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--strict-config",
] as const;

const authenticationPathError = () =>
  new HarnessError({
    message:
      "Codex credential storage must be absolute and outside the repository",
  });

const canonicalPath: (
  candidate: string
) => Effect.Effect<string, HarnessError, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* resolveCanonicalPath(
    candidate: string
  ): Effect.fn.Return<string, HarnessError, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { base, dir, root } = path.parse(candidate);

    const parent = base === "" ? root : yield* canonicalPath(dir);

    if (base === "." || base === "..") {
      const info = yield* fs
        .stat(parent)
        .pipe(Effect.mapError(authenticationPathError));

      if (info.type !== "Directory") {
        return yield* authenticationPathError();
      }
    }

    // Inspect parents before joining so ".." cannot skip a symlink or missing directory.
    const target = base === "" ? root : path.join(parent, base);

    return yield* fs.realPath(target).pipe(
      Effect.catch((error) => {
        if (error.reason._tag !== "NotFound") {
          return Effect.fail(authenticationPathError());
        }

        return fs.lstat(target).pipe(
          Effect.matchEffect({
            onFailure: (statError) =>
              statError.reason._tag === "NotFound"
                ? Effect.succeed(target)
                : Effect.fail(authenticationPathError()),
            onSuccess: () => Effect.fail(authenticationPathError()),
          })
        );
      })
    );
  });

/** Keep authentication at its existing external location; inspect paths, never credentials. */
export const sanitizedEnvironment = Effect.fnUntraced(
  function* sanitizedEnvironment(
    source: Record<string, string | undefined> = process.env
  ) {
    const path = yield* Path.Path;
    let authHome = source.CODEX_HOME;

    if (authHome === undefined) {
      const home =
        source.HOME ??
        source.USERPROFILE ??
        Bun.env.HOME ??
        Bun.env.USERPROFILE;

      if (home === undefined || !path.isAbsolute(home)) {
        return yield* authenticationPathError();
      }

      authHome = path.join(yield* canonicalPath(home), ".codex");
    }

    if (!path.isAbsolute(authHome)) {
      return yield* authenticationPathError();
    }

    const repository = yield* canonicalPath(REPO);
    const canonicalHome = yield* canonicalPath(authHome);
    const withinRepository = path.relative(repository, canonicalHome);

    const outsideRepository =
      withinRepository === ".." ||
      withinRepository.startsWith(`..${path.sep}`) ||
      path.isAbsolute(withinRepository);

    if (!outsideRepository) {
      return yield* authenticationPathError();
    }

    return environmentWithoutApiKeys(source);
  }
);
