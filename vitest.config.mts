import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      // Tests never touch real services.
      SENTINEL_DB_PATH: ":memory:",
      PAYPAL_MODE: "mock",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
    },
  },
});
