import next from "eslint-config-next";

// .next-*/ are the side-by-side test builds; the sandbox harness is plain Node tooling with a type stub.
const config = [...next, { ignores: [".next/**", ".next-*/**", "node_modules/**", "tests/sandbox/harness.d.mts"] }];
export default config;
