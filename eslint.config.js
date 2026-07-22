import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { URL: "readonly", process: "readonly" } } },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
