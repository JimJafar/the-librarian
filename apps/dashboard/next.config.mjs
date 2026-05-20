/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Lint is owned by the workspace root (`pnpm lint`), which wires the
  // Next.js plugin via the flat config in `eslint.config.mjs`. Next's
  // built-in detection doesn't resolve flat configs that live above its
  // own project root in a monorepo, so we let the root linter be the
  // single source of truth and skip the duplicate run during `next build`.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
