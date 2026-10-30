import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { acquireGradingOwnership } from "../src/assessment/ownership";
import { run } from "./shared";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const directory = async () => {
  const created = await mkdtemp(path.join(tmpdir(), "skills-grading-owner-"));
  directories.push(created);

  return created;
};

const acquire = async (target: string) => {
  await run(acquireGradingOwnership(target).pipe(Effect.scoped));
};

test("failed contenders preserve ownership until its scope closes", async () => {
  const target = await directory();

  await run(
    Effect.gen(function* contend() {
      yield* acquireGradingOwnership(target);

      for (const attempt of [1, 2]) {
        const failure = yield* Effect.flip(
          acquireGradingOwnership(target).pipe(Effect.scoped)
        );

        expect(failure.message, `contention attempt ${attempt}`).toContain(
          "already owned"
        );
      }
    }).pipe(Effect.scoped)
  );

  const lock = path.join(target, ".grading-ownership.sqlite");
  const previous = await stat(lock);
  await acquire(target);
  const current = await stat(lock);

  expect(current.ino).toBe(previous.ino);
});

test.skipIf(process.platform === "win32")(
  "forced termination releases ownership on the same persistent file",
  async () => {
    const target = await directory();

    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        Bun.fileURLToPath(
          new URL("fixtures/grading-owner.ts", import.meta.url)
        ),
        target,
      ],
      { stderr: "pipe", stdin: "ignore", stdout: "pipe" }
    );

    try {
      const ready = child.stdout.getReader();
      const chunk = await ready.read();
      ready.releaseLock();
      expect(new TextDecoder().decode(chunk.value)).toBe("owned\n");
      await expect(acquire(target)).rejects.toThrow("already owned");
      const lock = path.join(target, ".grading-ownership.sqlite");
      const previous = await stat(lock);
      child.kill("SIGKILL");
      await child.exited;
      await acquire(target);
      const current = await stat(lock);

      expect(current.ino).toBe(previous.ino);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
);
