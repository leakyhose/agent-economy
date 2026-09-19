/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a pure client-side telemetry view; it is served as static
  // files next to the simulation server.
  output: 'export',
  // This app lives inside a monorepo next to other lockfiles; pin the trace root.
  outputFileTracingRoot: import.meta.dirname,
  // A production build writes into the same directory the dev server is
  // serving from, which corrupts a running dev session
  // (__webpack_modules__[moduleId] is not a function). Give the build its own
  // directory so the two can coexist.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  devIndicators: false,
  images: { unoptimized: true },
};

export default nextConfig;
