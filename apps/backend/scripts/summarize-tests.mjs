// Prints passed/failed/skipped counts from a vitest JSON report and fails on failures OR skips (CI must not skip required tests).
import { readFileSync, appendFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2] ?? "test-report.json", "utf8"));
const line = `backend tests: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests + (r.numTodoTests ?? 0)} skipped, ${r.numTotalTests} total in ${r.numTotalTestSuites} suites`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
if (r.numFailedTests > 0 || r.numPendingTests > 0 || r.numFailedTestSuites > 0) { console.error("FAIL: failures or skipped tests present"); process.exit(1); }
