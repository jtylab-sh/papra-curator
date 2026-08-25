// Dev-only tooling: the service ships with no dependencies and is never built,
// so nothing here is installed into the image.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules*/**"] },
  { ignores: ["node_modules/**", "node_modules.root-owned.bak/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly" },
    },
    rules: {
      // Papra's and Mistral's JSON is validated at the edge and then narrowed;
      // `any` at those boundaries is the honest type.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
