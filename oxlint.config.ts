import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["github", "sonarjs"]);

export default defineConfig({
  extends: [core, vitest, antiSlop, jsPlugins],
  ignorePatterns: core.ignorePatterns,

  jsPlugins: [
    ...jsPlugins.jsPlugins,

    {
      name: "tsdoc",
      specifier: "eslint-plugin-tsdoc",
    },

    // `jsdoc` is reserved by Oxlint's native plugin.
    {
      name: "jsdoc-js",
      specifier: "eslint-plugin-jsdoc",
    },
  ],

  overrides: [
    {
      files: ["src/**/*.{ts,tsx,mts,cts}"],
      rules: {
        // Require documentation for exported/public APIs.
        "jsdoc-js/require-jsdoc": [
          "error",
          {
            contexts: [
              "TSInterfaceDeclaration",
              "TSTypeAliasDeclaration",
              "TSEnumDeclaration",
            ],
            publicOnly: true,
            require: {
              ArrowFunctionExpression: true,
              ClassDeclaration: true,
              ClassExpression: true,
              FunctionDeclaration: true,
              FunctionExpression: true,
              MethodDefinition: true,
            },
          },
        ],

        // Once something has TSDoc, make the useful tags complete.
        "jsdoc/require-param": "error",
        "jsdoc/require-param-description": "error",
        "jsdoc/require-param-type": "off",
        "jsdoc/require-returns": "error",
        "jsdoc/require-returns-description": "error",
        "jsdoc/require-returns-type": "off",

        // Never duplicate TypeScript types inside TSDoc.

        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                message: "Use the @/* alias for imports between src modules.",
                regex: "^\\.{1,2}/",
              },
            ],
          },
        ],

        // Validate existing doc comments against TSDoc.
        "tsdoc/syntax": "error",
      },
    },
  ],
});
