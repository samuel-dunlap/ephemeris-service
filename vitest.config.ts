import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        // Module rules for non-JS imports (matches wrangler.jsonc rules).
        modulesRules: [
          { type: "CompiledWasm", include: ["**/*.wasm"] },
          { type: "Data", include: ["**/*.se1"] },
        ],
      },
    }),
  ],
  test: {
    // Longer timeout — first test needs to init WASM + mount ephemeris
    testTimeout: 30_000,
  },
});
