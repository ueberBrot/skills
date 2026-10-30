import { Effect, FileSystem, Path, Schema } from "effect";
import { forEach as traverse } from "effect/Effect";

import { HarnessError } from "../errors";
import { REPO } from "../paths";

const SkillNameSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
);

const SkillMetadataSchema = Schema.Struct({
  "allowed-tools": Schema.optionalKey(Schema.String),
  compatibility: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/u))
  ),
  description: Schema.String.check(
    Schema.isMaxLength(1024),
    Schema.isPattern(/\S/u)
  ),
  license: Schema.optionalKey(Schema.NonEmptyString),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: SkillNameSchema,
});

interface SkillMetadata {
  readonly name: string;
  readonly description: string;
}

export interface SkillEntry extends SkillMetadata {
  readonly directory: string;
  readonly entry: string;
  readonly suite: string | null;
}

export interface SuiteSelection {
  readonly skill?: string;
  readonly suite?: string;
}

export const parseSkill = Effect.fnUntraced(function* parseSkill(
  source: string,
  expectedName?: string
) {
  const frontmatter = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    source
  )?.groups?.yaml;

  if (frontmatter === undefined) {
    return yield* new HarnessError({
      message: "SKILL.md requires YAML frontmatter with name and description",
    });
  }

  const yaml = yield* Effect.try({
    catch: () =>
      new HarnessError({ message: "Invalid YAML frontmatter in SKILL.md" }),
    try: () => Bun.YAML.parse(frontmatter),
  });

  const metadata = yield* Schema.decodeUnknownEffect(SkillMetadataSchema)(
    yaml
  ).pipe(
    Effect.mapError(
      (error) =>
        new HarnessError({
          message: `Invalid skill metadata: ${error.message}`,
        })
    )
  );

  if (expectedName !== undefined && metadata.name !== expectedName) {
    return yield* new HarnessError({
      message: `Skill name ${metadata.name} must match directory ${expectedName}`,
    });
  }

  return Object.freeze({
    description: metadata.description,
    name: metadata.name,
  } satisfies SkillMetadata);
});

const within = (
  path: Path.Path,
  directory: string,
  target: string
): boolean => {
  const relative = path.relative(directory, target);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const optionalFile = Effect.fnUntraced(function* optionalFile(
  directory: string,
  filename: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = path.join(directory, filename);

  const info = yield* fs
    .lstat(candidate)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(null)
      )
    );

  if (info === null) {
    return null;
  }

  const actual = yield* fs.realPath(candidate);
  const target = yield* fs.stat(actual);

  if (target.type !== "File" || !within(path, directory, actual)) {
    return yield* new HarnessError({
      message: `${filename} must be a file inside ${directory}`,
    });
  }

  return actual;
});

export const discoverSkills = Effect.fn("discoverSkills")(
  function* discoverSkills(root: string = REPO) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* fs.realPath(root);
    const skillsPath = path.join(repository, "skills");

    if (!(yield* fs.exists(skillsPath))) {
      return Object.freeze<SkillEntry[]>([]);
    }

    const skillsRoot = yield* fs.realPath(skillsPath);

    if (!within(path, repository, skillsRoot)) {
      return yield* new HarnessError({
        message: "The skills directory must stay inside the repository",
      });
    }

    const names = yield* fs.readDirectory(skillsRoot);

    const entries = yield* traverse(
      names.toSorted(),
      Effect.fnUntraced(function* discoverSkill(name) {
        const candidate = path.join(skillsRoot, name);
        const info = yield* fs.stat(candidate);

        if (info.type !== "Directory") {
          return null;
        }

        const directory = yield* fs.realPath(candidate);

        if (!within(path, skillsRoot, directory)) {
          return yield* new HarnessError({
            message: `Skill directory escapes the repository: ${name}`,
          });
        }

        const entry = yield* optionalFile(directory, "SKILL.md");

        if (entry === null) {
          return null;
        }

        const metadata = yield* parseSkill(
          yield* fs.readFileString(entry),
          name
        );

        const suite = yield* optionalFile(
          path.join(repository, "evals", name),
          "suite.json"
        );

        return Object.freeze({
          ...metadata,
          directory,
          entry,
          suite,
        } satisfies SkillEntry);
      })
    );

    return Object.freeze(
      entries.flatMap((entry) => (entry === null ? [] : [entry]))
    );
  }
);

export const selectSuite = Effect.fn("selectSuite")(function* selectSuite(
  selection: SuiteSelection,
  root: string = REPO
) {
  if ((selection.skill === undefined) === (selection.suite === undefined)) {
    return yield* new HarnessError({
      message: "Choose exactly one of --skill NAME or --suite PATH",
    });
  }

  if (selection.suite !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const suite = yield* fs.realPath(path.resolve(root, selection.suite));
    const info = yield* fs.stat(suite);

    if (info.type !== "File") {
      return yield* new HarnessError({
        message: `Expected an evaluation suite file: ${selection.suite}`,
      });
    }

    return { file: suite, skill: null };
  }

  const skills = yield* discoverSkills(root);
  const selected = skills.find((skill) => skill.name === selection.skill);

  if (selected === undefined) {
    return yield* new HarnessError({
      message: `Unknown skill: ${selection.skill}`,
    });
  }

  if (selected.suite === null) {
    return yield* new HarnessError({
      message: `Skill ${selected.name} has no evaluation suite`,
    });
  }

  return { file: selected.suite, skill: selected };
});
