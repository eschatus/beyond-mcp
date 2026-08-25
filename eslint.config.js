// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      // Raw DDB payloads are modelled as `any` at the transport boundary (same
      // convention as roll20-dm-mcp); typed shapes begin at the domain mappers.
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  }
);
