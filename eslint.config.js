// Dev-only tooling: the service ships with no dependencies and is never built,
// so nothing here is installed into the image.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules*/**", "src/generated/**"] },
  { ignores: ["node_modules/**", "node_modules.root-owned.bak/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly" },
      // Type-aware, for no-floating-promises alone: every state write returns a
      // promise now, and one missing await silently loses the write.
      parserOptions: {
        // eslint.config.js itself is not in tsconfig, and does not need to be.
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Papra's and Mistral's JSON is validated at the edge and then narrowed;
      // `any` at those boundaries is the honest type.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test's describe/it return promises by design.
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "before", "beforeEach", "after", "afterEach"],
            },
          ],
        },
      ],
    },
  },
);
