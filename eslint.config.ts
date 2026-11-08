import js from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

export default defineConfig(
  includeIgnoreFile(`${import.meta.dirname}/.gitignore`),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".vue"],
      },
    },
  },

  pluginVue.configs["flat/recommended"],
  { name: "vue/no-layout-rules", rules: pluginVue.configs["no-layout-rules"].rules },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      "no-undef": "off",
      "vue/multi-word-component-names": "off",
    },
  },

  {
    rules: {
      eqeqeq: "error",
      curly: "error",
      "prefer-template": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/web/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "hono",
              message: "src/web may import only hono/client of Hono.",
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: [
                "**/core/*",
                "!**/core/pki",
                "!**/core/digest.ts",
                "**/http/**",
                "**/storage/**",
                "**/runtime/**",
              ],
              message:
                "src/web may import only types from the server (`import type`), and core/pki and core/digest.ts.",
              allowTypeImports: true,
            },
            {
              group: ["hono/*", "!hono/client", "@hono/*"],
              message: "src/web may import only hono/client of Hono.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["src/web/components/ui/**"],
    rules: {
      "vue/require-default-prop": "off",
    },
  }
);
