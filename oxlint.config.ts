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
  overrides: [
    {
      files: ["src/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                message: "Use the @/* alias for imports between src modules.",
                regex: "^\\.\\.(?:/\\.\\.)?/(?!alchemy\\.run$)",
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    // Preserve declaration-style functions and their normal hoisting behavior.
    "eslint/func-style": ["error", "declaration"],
    "eslint/no-use-before-define": ["error", { functions: false }],
  },
});
