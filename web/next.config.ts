import path from 'node:path';
import type { NextConfig } from 'next';

// The Flow-E core lives one level up (the published package's pure `@flow-e/mcp/core` entry,
// built to ../dist). The app imports it through this alias instead of a `file:..` link, which
// would make the package contain itself through web/.
const repoRoot = path.join(__dirname, '..');

const nextConfig: NextConfig = {
  // Every sandbox page is per user and dynamic, and the CSP nonce needs request-time rendering,
  // so the classic (non-Cache-Components) model is the simpler correct choice here.
  cacheComponents: false,
  poweredByHeader: false,
  // Embedded Postgres ships WebAssembly and data files that must be loaded from node_modules.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  turbopack: {
    root: repoRoot,
    resolveAlias: {
      '@flow-e/mcp/core': '../dist/core.js',
    },
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
