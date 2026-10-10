import { defineConfig } from "vitest/config";


export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 60_000, // starting the in-memory Postgres
  },
});
