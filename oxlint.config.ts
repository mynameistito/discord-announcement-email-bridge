import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["github", "sonarjs"]);

export default defineConfig({
  extends: [core, vitest, antiSlop, jsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  rules: {
    "eslint/func-style": "off",
    "eslint/max-classes-per-file": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-bitwise": "off",
    "eslint/no-use-before-define": "off",
    "eslint/sort-keys": "off",
    // Effect.succeed(undefined) needs its explicit success value in adapters.
    "unicorn/no-useless-undefined": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
  },
});
