import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import bs58 from "bs58";
import type { ApprovedArtifact } from "../config/index.js";
import { loadArtifacts } from "../config/index.js";

export interface LoadedArtifact extends ApprovedArtifact { bytes: Uint8Array; codeHashBase58: string }

/** Only artifacts listed in the approved registry can be deployed, and the bytes must hash to the approved sha256. */
export function loadApprovedArtifact(artifactsFile: string, id: string, version: string): LoadedArtifact {
  const entry = loadArtifacts(artifactsFile).find((a) => a.id === id && a.version === version);
  if (!entry) throw new Error(`artifact ${id}@${version} is not in the approved registry (${artifactsFile})`);
  const bytes = readFileSync(resolve(dirname(resolve(artifactsFile)), entry.path));
  const digest = createHash("sha256").update(bytes).digest();
  if (digest.toString("hex") !== entry.sha256.toLowerCase()) throw new Error(`artifact ${id}@${version} bytes hash ${digest.toString("hex")} != approved ${entry.sha256}`);
  return { ...entry, bytes, codeHashBase58: bs58.encode(digest) };
}
