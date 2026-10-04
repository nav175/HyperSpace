/** @type {import('next').NextConfig} */
const nextConfig = {
  // mysql2 runs as a normal Node.js dependency instead of being bundled.
  serverExternalPackages: ['mysql2'],
  devIndicators: false,
  agentRules: false,
};

export default nextConfig;
