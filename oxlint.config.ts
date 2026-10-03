import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
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
