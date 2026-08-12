import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".vitest/**", "coverage/**"],
  },
  {
    files: ["packages/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ["./packages/*/tsconfig.json", "./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: [
      "action/src/**/*.mjs",
      "action/test/**/*.mjs",
      "eslint.config.mjs",
      "packages/**/*.mjs",
      "scripts/**/*.mjs",
      "tools/**/*.mjs",
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      sourceType: "module",
    },
  },
);
