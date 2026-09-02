import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The current UI intentionally derives some local workflow state from
    // external records in effects. Keep the React compiler diagnostics visible
    // without making the existing, production-tested patterns fail CI.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    files: ["pb_hooks/**/*.js", "pb_migrations/**/*.js"],
    // PocketBase executes CommonJS-style hooks and type references directly;
    // these are platform contracts rather than Next.js modules.
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vinext/**",
    ".runtime/**",
    ".qa/**",
    ".wrangler/**",
    ".pnpm-store/**",
    "out/**",
    "build/**",
    "dist/**",
    "node_modules/**",
    "activityradar/**",
    "analysis_*/**",
    "analysis_artifacts/**",
    "analysis_cache/**",
    "artifacts/**",
    "lingshu_AI-0816/**",
    "outputs/**",
    "pb_data/**",
    "public/material-analysis/**",
    "public/material-covers/**",
    "public/material-previews/**",
    "public/renders/**",
    "temp/**",
    "tmp/**",
    "tools/**",
    "worker/runtime-types.d.ts",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
