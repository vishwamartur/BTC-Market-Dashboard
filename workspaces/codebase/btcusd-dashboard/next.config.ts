import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ['ws'],
  typescript: {
    // v2/ is a separate standalone trading bot project with its own deps.
    // Its types are excluded from tsconfig.json but Turbopack still resolves them.
    // Type-checking is done separately; this only disables the build-time check.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
