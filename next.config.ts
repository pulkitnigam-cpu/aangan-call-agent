import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Keep the Postgres driver out of the bundle: bundling it breaks nested
  // sql`` fragments ("bind message supplies 1 parameters … requires 0").
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
