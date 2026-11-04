import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["node:sqlite"],
  outputFileTracingExcludes: {
    "/*": ["./.env*", "./data/**", "./work/**", "./artifacts/**", "./private/**", "./outputs/**", "./.git/**", "./test-results/**", "./playwright-report/**"]
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ] }];
  }
};
export default config;
