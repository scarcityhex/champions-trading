import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Artwork is served from this project's own /public (see docs/architecture.md
  // §4) with the on-chain ipfs:// as fallback, so gateways must be allowed.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: 'dweb.link' },
    ],
  },
};

export default config;
