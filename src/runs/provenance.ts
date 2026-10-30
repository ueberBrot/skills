import {
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Path,
  Schema,
  Stream,
} from "effect";
import { forEach as traverse } from "effect/Effect";

import packageInfo from "../../package.json";
import { ManifestSchema } from "../domain";
import { compareText } from "../internal/json";
import { captureProcess } from "../internal/process";
import { REPO } from "../paths";

import type { Condition, JsonObject } from "../domain";
import type { LoadedSuite } from "../suites";
import type { WriterDescriptor } from "../writers";

type ManifestSource =
  | {
      readonly _tag: "Live";
      readonly descriptor: WriterDescriptor;
      readonly timeout: number;
    }
  | {
      readonly _tag: "Recorded";
      readonly provenance: Readonly<Record<string, string>>;
    };

interface ManifestOptions {
  readonly model?: string;
  readonly settings: JsonObject;
  readonly repetitions: number;
  readonly seed: number;
  readonly concurrency: number;
}

const gitValue = Effect.fnUntraced(function* gitValue(...args: string[]) {
  return yield* captureProcess(["git", "-C", REPO, ...args], "", REPO, 10).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)),
    Effect.orElseSucceed(() => null)
  );
});

const gatherFiles = Effect.fnUntraced(function* gatherFiles(
  suite: LoadedSuite,
  source: ManifestSource
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hashes = new Map([
    ...Object.entries(suite.provenance),
    ...Object.entries(source._tag === "Recorded" ? source.provenance : {}),
  ]);

  const sourceDirectory = path.join(REPO, "src");

  const sourceNames = yield* fs.readDirectory(sourceDirectory, {
    recursive: true,
  });

  const locations = [
    ...sourceNames
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(sourceDirectory, name)),
    ...[
      "package.json",
      "bun.lock",
      "tsconfig.json",
      ".bun-version",
      "bunfig.toml",
      "vite.config.ts",
    ].map((name) => path.join(REPO, name)),
    ...(source._tag === "Recorded"
      ? Object.keys(source.provenance)
      : source.descriptor.files),
  ];

  yield* traverse(
    new Set(locations.filter((filePath) => !hashes.has(filePath))),
    Effect.fnUntraced(function* hashFile(filePath) {
      const hasher = yield* fs.stream(filePath).pipe(
        Stream.runFold(
          () => new Bun.CryptoHasher("sha256"),
          (hash, chunk) => hash.update(chunk)
        )
      );

      hashes.set(filePath, hasher.digest("hex"));
    }),
    { concurrency: 8 }
  );

  return Object.fromEntries(
    [...hashes].toSorted(([left], [right]) => compareText(left, right))
  );
});

export const makeManifest = Effect.fnUntraced(function* makeManifest(
  suite: LoadedSuite,
  conditions: readonly Condition[],
  options: ManifestOptions,
  source: ManifestSource
) {
  const crypto = yield* Crypto.Crypto;

  const status = yield* gitValue(
    "status",
    "--porcelain",
    "--untracked-files=all"
  );

  const limitations = [
    "Literal checks do not establish semantic fidelity, naturalness, or comprehension.",
    "Semantic grading is recorded separately from generation.",
    "The controlled full-skill condition injects the skill and selected references; it does not test installed-skill discovery.",
    "Fresh working directories do not erase administrator-enforced instructions or external state.",
    "Requested model/settings are separate from reported actual model/settings; unknown values stay unset.",
    "Synthetic regression cases are not a representative workplace benchmark.",
    "Harness order uses the installed Effect Random implementation with the recorded seed, separate from provider sampling.",
  ];

  if (source._tag === "Recorded") {
    limitations.push(
      "Replayed outputs were not generated from these saved prompts or the current skill snapshot. Replay validates the harness, not current skill effectiveness."
    );
  }

  return yield* Schema.decodeEffect(ManifestSchema)(
    {
      concurrency: options.concurrency,
      conditions: [...conditions],
      executor_argv:
        source._tag === "Live" && source.descriptor.command !== null
          ? [...source.descriptor.command]
          : null,
      executor_metadata:
        source._tag === "Live" ? source.descriptor.metadata : null,
      executor_name: source._tag === "Live" ? source.descriptor.name : null,
      executor_timeout_seconds: source._tag === "Live" ? source.timeout : null,
      file_hashes: yield* gatherFiles(suite, source),
      git_commit: yield* gitValue("rev-parse", "HEAD"),
      git_dirty: status === null ? null : status.length > 0,
      limitations,
      mode: source._tag === "Live" ? "execute" : "replay",
      package_versions: {
        ...packageInfo.dependencies,
        ...packageInfo.devDependencies,
        [packageInfo.name]: packageInfo.version,
        bun: Bun.version,
      },
      repetitions: options.repetitions,
      requested_model: options.model ?? null,
      requested_settings: options.settings,
      run_id: yield* crypto.randomUUIDv4(),
      schema_version: 2,
      seed: options.seed,
      skill_name: suite.skillName,
      started_at: DateTime.formatIso(yield* DateTime.now),
      suite: suite.name,
    },
    { onExcessProperty: "error" }
  );
});
