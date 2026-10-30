import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { discoverSkills, parseSkill, selectSuite } from "../src/skills";
import { run } from "./shared";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const skillText = (name: string): string =>
  `---\nname: ${name}\ndescription: A synthetic test skill.\nlicense: ISC\n---\n\n# Test skill\n`;

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-catalog-"));
  directories.push(root);
  await mkdir(path.join(root, "skills/alpha"), { recursive: true });
  await mkdir(path.join(root, "skills/beta"));
  await mkdir(path.join(root, "evals/alpha"), { recursive: true });
  await Bun.write(path.join(root, "skills/alpha/SKILL.md"), skillText("alpha"));
  await Bun.write(path.join(root, "skills/beta/SKILL.md"), skillText("beta"));
  await Bun.write(path.join(root, "evals/alpha/suite.json"), "{}");

  return await realpath(root);
};

test("discovers multiple skills and permits skills without evaluations", async () => {
  const root = await repository();
  const skills = await run(discoverSkills(root));

  expect(skills).toEqual([
    {
      description: "A synthetic test skill.",
      directory: path.join(root, "skills/alpha"),
      entry: path.join(root, "skills/alpha/SKILL.md"),
      name: "alpha",
      suite: path.join(root, "evals/alpha/suite.json"),
    },
    {
      description: "A synthetic test skill.",
      directory: path.join(root, "skills/beta"),
      entry: path.join(root, "skills/beta/SKILL.md"),
      name: "beta",
      suite: null,
    },
  ]);

  expect(await run(selectSuite({ skill: "alpha" }, root))).toEqual({
    file: path.join(root, "evals/alpha/suite.json"),
    skill: skills[0] ?? null,
  });

  const error = await run(Effect.flip(selectSuite({ skill: "beta" }, root)));

  expect(error.message).toContain("has no evaluation suite");
});

test("requires one selector and supports an explicit external suite", async () => {
  const root = await repository();
  const external = path.join(root, "external.json");
  await Bun.write(external, "{}");

  expect(await run(selectSuite({ suite: external }, root))).toEqual({
    file: external,
    skill: null,
  });
  expect(await run(selectSuite({ suite: "external.json" }, root))).toEqual({
    file: external,
    skill: null,
  });

  await Promise.all(
    [{}, { skill: "alpha", suite: external }].map(async (selection) => {
      const error = await run(Effect.flip(selectSuite(selection, root)));

      expect(error.message).toContain("exactly one");
    })
  );

  const unknown = await run(
    Effect.flip(selectSuite({ skill: "missing" }, root))
  );

  expect(unknown.message).toContain("Unknown skill");
});

test.each([
  ["missing frontmatter", "# Example", "alpha"],
  ["invalid YAML", "---\nmetadata: [\n---\n", "alpha"],
  ["invalid name", skillText("Alpha"), "Alpha"],
  ["empty description", "---\nname: alpha\ndescription: ' '\n---\n", "alpha"],
  ["mismatched directory", skillText("alpha"), "beta"],
  [
    "invalid metadata",
    "---\nname: alpha\ndescription: Test\nmetadata:\n  version: 1\n---\n",
    "alpha",
  ],
])("rejects %s", async (_name, source, directory) => {
  const result = await Effect.runPromise(
    Effect.flip(parseSkill(source, directory))
  );

  expect(result.message).toBeTypeOf("string");
});

test("accepts legacy string metadata without individual skill versions", async () => {
  const metadata = await Effect.runPromise(
    parseSkill(
      "---\nname: alpha\ndescription: Test\nmetadata:\n  version: '2.3.4'\n---\n",
      "alpha"
    )
  );

  expect(metadata).toEqual({ description: "Test", name: "alpha" });
});

test.each(["skill", "suite"])(
  "rejects a %s file that escapes its directory",
  async (kind) => {
    const root = await repository();
    const target = path.join(root, "outside.md");
    await Bun.write(target, skillText("alpha"));

    const location =
      kind === "skill"
        ? path.join(root, "skills/alpha/SKILL.md")
        : path.join(root, "evals/alpha/suite.json");

    await Bun.file(location).delete();
    await symlink(target, location);

    const error = await run(Effect.flip(discoverSkills(root)));

    expect(error.message).toContain("must be a file inside");
  }
);
