import path from "node:path";
import { defineConfig } from "vitest/config";

// The Sandbox suite starts a local chain and takes ~2 minutes: it runs with `pnpm test:sandbox`, not on every `pnpm test`.
const sandbox = process.env.NEARODDS_SANDBOX === "1";
export default defineConfig({ resolve: { alias: { "@": path.resolve(__dirname) } }, test: { include: ["tests/**/*.test.ts"], exclude: sandbox ? [] : ["tests/sandbox.test.ts", "node_modules/**"] } });
