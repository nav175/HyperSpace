import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // mysql2 (TiDB) must run in Node, not the Edge bundle.
  serverExternalPackages: ["mysql2"],
};

export default nextConfig;
