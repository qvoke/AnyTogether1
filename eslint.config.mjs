import js from "@eslint/js";
import typescriptParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      parser: typescriptParser,
      sourceType: "module",
      globals: {
        Blob: "readonly",
        Buffer: "readonly",
        CustomEvent: "readonly",
        Date: "readonly",
        HTMLInputElement: "readonly",
        HTMLMediaElement: "readonly",
        HTMLTextAreaElement: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        performance: "readonly",
        sessionStorage: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly"
      }
    },
    rules: {
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-useless-escape": "off"
    }
  },
  {
    ignores: [".notes/**", ".wrangler/**", "data/**", "extension/_metadata/**", "node_modules/**"]
  }
];
