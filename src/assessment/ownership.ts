import { Database, SQLiteError } from "bun:sqlite";

import { Effect, Path } from "effect";

import { HarnessError } from "../errors";

const openOwnership = (file: string) =>
  Effect.try({
    catch: (cause) =>
      new HarnessError({
        message:
          cause instanceof SQLiteError && cause.code === "SQLITE_BUSY"
            ? "Grading directory is already owned by another process"
            : "Could not acquire grading directory ownership",
      }),
    try: () => {
      const database = new Database(file);

      try {
        database.run("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");

        return database;
      } catch (error) {
        database.close(true);

        throw error;
      }
    },
  });

export const acquireGradingOwnership = Effect.fn("acquireGradingOwnership")(
  function* acquireGradingOwnership(directory: string) {
    const path = yield* Path.Path;

    yield* Effect.acquireRelease(
      openOwnership(path.join(directory, ".grading-ownership.sqlite")),
      (database) =>
        Effect.sync(() => {
          database.close(true);
        })
    );
  }
);
