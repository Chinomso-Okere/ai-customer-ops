import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".claude/**", ".next/**","node_modules/**", "out/**", "coverage/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Allowed on purpose: eval facts, test helpers and scripted-model harness code
    // read loosely typed tool inputs and results from the Agent Trace.
    files: ["src/evals/**", "src/server/testing/**", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // A leading underscore marks a variable that is deliberately unused
    // (e.g. omitting a key by destructuring).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
];

export default eslintConfig;
