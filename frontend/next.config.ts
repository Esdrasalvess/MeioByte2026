import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
  return [{ source: '/hips/:path*', destination: 'https://alasky.cds.unistra.fr/:path*' }];
},
};

export default nextConfig;
