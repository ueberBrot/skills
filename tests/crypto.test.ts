import { expect, test } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

import { sha256, writeJson } from "../src/internal/json";
import { run } from "./shared";

test("native digest preserves the persisted SHA-256 format", async () => {
  expect(await run(sha256("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  expect(await run(sha256(new TextEncoder().encode("Grüße")))).toBe(
    await run(sha256("Grüße"))
  );
});

test("hashing uses the supplied Effect digest service", async () => {
  const result = await run(
    Effect.gen(function* injectedDigest() {
      const digest = yield* Digest.Digest;

      return yield* sha256("content").pipe(
        Effect.provideService(Digest.Digest, {
          ...digest,
          digestHex: (algorithm, bytes) => {
            expect(algorithm).toBe(Digest.sha256);
            expect(new TextDecoder().decode(bytes)).toBe("content");

            return Effect.succeed("injected-digest");
          },
        })
      );
    })
  );

  expect(result).toBe("injected-digest");
});

test("atomic writes use Effect secure randomness and remove the temporary file", async () => {
  await run(
    Effect.gen(function* injectedRandomness() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "skills-crypto-",
      });

      const target = path.join(directory, "result.json");
      let temporary: string | undefined;

      yield* writeJson(target, { saved: true }).pipe(
        Effect.provideService(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size))
        ),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) => {
            temporary = from;

            return fs.rename(from, to);
          },
        })
      );

      expect(temporary).toBe(
        `${target}.00000000-0000-4000-8000-000000000000.tmp`
      );
      expect(yield* fs.readFileString(target)).toBe('{\n  "saved": true\n}\n');
      expect(yield* fs.readDirectory(directory)).toEqual(["result.json"]);
    }).pipe(Effect.scoped)
  );
});
