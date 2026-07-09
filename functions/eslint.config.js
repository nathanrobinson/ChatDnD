const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // 1. Global Ignores (Replaces old .eslintignore layouts)
  {
    ignores: ["node_modules/", "lib/"],
  },

  // 2. Main Rule Definitions (Applied to all JS files)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    // We mix recommended rules with your explicit styling rules directly
    plugins: {
      js: js,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-restricted-globals": ["error", "name", "length"],
      "prefer-arrow-callback": "error",
      quotes: ["error", "double", { allowTemplateLiterals: true }],
      semi: ["error", "always"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // 3. Test File Environment Overrides
  {
    files: ["**/*.spec.js"],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
];
