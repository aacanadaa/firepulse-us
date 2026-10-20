/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@firepulse/protocol", "maplibre-gl"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  experimental: {
    optimizePackageImports: ["@deck.gl/layers", "@deck.gl/core", "@deck.gl/geo-layers"],
  },
};
export default nextConfig;
