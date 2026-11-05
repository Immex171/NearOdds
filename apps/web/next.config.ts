import type { NextConfig } from "next";

// NEXT_DIST_DIR lets browser tests build differently-configured copies (demo, live, integration) side by side.
const nextConfig: NextConfig = { reactStrictMode: true, transpilePackages: ["@nearodds/types"], distDir: process.env.NEXT_DIST_DIR || ".next" };
export default nextConfig;
