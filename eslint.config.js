import tsParser from "@typescript-eslint/parser";

const MAX_FILE_LINES = 620;
const MAX_FUNCTION_COMPLEXITY = 20;

export default [
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "max-lines": [
        "error",
        {
          max: MAX_FILE_LINES,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      complexity: ["error", { max: MAX_FUNCTION_COMPLEXITY }],
    },
  },
];
