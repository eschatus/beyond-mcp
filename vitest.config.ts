import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html"],
      include: ["src/**/*.ts"],
      // index-*.ts are thin transport/bootstrap entrypoints — excluded like the parent repo.
      exclude: ["src/**/*.test.ts", "src/index*.ts"],
    },
  },
});
