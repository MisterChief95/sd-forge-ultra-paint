import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "test-results", "playwright-report"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // Codebase uses plain Map/Set for non-reactive bookkeeping (listener
      // registries, texture caches) outside `$state` -- this rule can't tell
      // those apart from reactive collections and flags all of them.
      "svelte/prefer-svelte-reactivity": "off",
      // `activeInstance = this` is a deliberate singleton registration, not
      // an accidental closure-scoping alias.
      "@typescript-eslint/no-this-alias": "off",
    },
  },
);
