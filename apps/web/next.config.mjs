/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a pure client-side telemetry view; it is served as static
  // files next to the simulation server.
  output: 'export',
  // This app lives inside a monorepo next to other lockfiles; pin the trace root.
  outputFileTracingRoot: import.meta.dirname,
  reactStrictMode: true,
  devIndicators: false,
  images: { unoptimized: true },
};

export default nextConfig;
