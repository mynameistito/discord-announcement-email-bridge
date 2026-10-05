import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
      "@scripts": fileURLToPath(new URL("scripts", import.meta.url)),
      "@tests": fileURLToPath(new URL("__tests__", import.meta.url)),
    },
  },
});
