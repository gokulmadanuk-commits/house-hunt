import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is only needed for the Docker image (see Dockerfile).
  output: process.env.STANDALONE ? "standalone" : undefined,
  serverExternalPackages: ["@anthropic-ai/sdk"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
