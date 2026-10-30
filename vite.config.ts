import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import fmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import { defineConfig } from "vite-plus";

const jsPlugins = selectJsPlugins(["github", "sonarjs", "tsdoc"]);
const evaluationData = ["evals/**/*.json", "evals/**/*.txt", "evals/**/*.md"];

export default defineConfig({
  envDir: false,
  fmt: {
    ...fmt,
    ignorePatterns: [
      ...(fmt.ignorePatterns ?? []),
      "skills/**",
      ...evaluationData,
    ],
    sortImports: {
      groups: [
        "side_effect",
        "builtin",
        "external",
        ["internal", "subpath"],
        ["parent", "sibling", "index"],
        "type",
        "style",
        "unknown",
      ],
      ignoreCase: true,
      newlinesBetween: true,
      order: "asc",
    },
  },
  lint: {
    env: { browser: false, node: true },
    extends: [core, jsPlugins, antiSlop, effectRecommended],
    globals: { Bun: "readonly" },
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      "skills/**",
      ...evaluationData,
    ],
    jsPlugins: jsPlugins.jsPlugins,
    options: { typeAware: true, typeCheck: false },
    overrides: [
      {
        files: ["tests/**/*.test.ts"],
        // Vitest recognizes it.effect; this static heuristic does not.
        rules: { "sonarjs/no-empty-test-file": "off" },
      },
    ],
  },
  run: {
    cache: false,
    tasks: {
      "benchmark:replay": {
        command: "bun --no-env-file benchmarks/replay.ts",
      },
      changeset: {
        command: "changeset",
      },
      check: {
        command: [
          "vp run typecheck",
          "vp run lint",
          "vp run format:check",
          "vp run fallow",
          "vp run skills validate",
          "vp run test",
        ],
      },
      fallow: {
        command: "fallow dead-code --format json --quiet",
      },
      "fallow:dupes": {
        command: "fallow dupes --format json --quiet",
      },
      "fallow:health": {
        command: "fallow health --format json --quiet",
      },
      format: {
        command:
          "vp fmt src tests benchmarks evals vite.config.ts package.json tsconfig.json bunfig.toml .fallowrc.json .changeset/config.json",
      },
      "format:check": {
        command:
          "vp fmt --check src tests benchmarks evals vite.config.ts package.json tsconfig.json bunfig.toml .fallowrc.json .changeset/config.json",
      },
      intent: {
        command: "intent",
      },
      lint: {
        command: "vp lint src tests benchmarks evals vite.config.ts",
      },
      "lint:fix": {
        command: "vp lint --fix src tests benchmarks evals vite.config.ts",
      },
      "pilot:profile": {
        command:
          "bun --no-env-file --no-orphans evals/clear-writing/profile.ts",
      },
      release: {
        command: "changeset publish",
      },
      skills: {
        command: "bun --no-env-file --no-orphans src/cli.ts",
      },
      test: {
        command: "bun --no-env-file --bun node_modules/vitest/vitest.mjs run",
      },
      typecheck: {
        command: "tsrs --noEmit",
      },
      "version-packages": {
        command: "changeset version",
      },
    },
  },
  test: {
    execArgv: ["--no-env-file"],
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    pool: "forks",
  },
});
