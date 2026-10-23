/**
 * Account routes go through the web origin, so the session cookie is
 * first-party wherever the API is hosted. Public data and the WebSocket go
 * straight to the API.
 */
const apiOrigin = (process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8790").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return ["auth", "me", "push"].map((area) => ({
      source: `/api/v1/${area}/:path*`,
      destination: `${apiOrigin}/api/v1/${area}/:path*`,
    }));
  },
  reactStrictMode: true,
  transpilePackages: ["@firepulse/protocol", "maplibre-gl"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  experimental: {
    optimizePackageImports: ["@deck.gl/layers", "@deck.gl/core", "@deck.gl/geo-layers"],
  },
};
export default nextConfig;
