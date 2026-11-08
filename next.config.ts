import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The dev-only route indicator sat on top of the home page's corner; production never shows it.
  devIndicators: false,
  serverExternalPackages: [
    "node:sqlite",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "sharp",
    "exceljs",
    "mammoth",
  ],
  // PDF.js loads its worker and built-in character/font assets by computed paths.
  outputFileTracingIncludes: {
    "/api/intakes/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/cmaps/**/*",
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./.env*",
      "./data/**",
      "./work/**",
      "./artifacts/**",
      "./private/**",
      "./outputs/**",
      "./.git/**",
      "./test-results/**",
      "./playwright-report/**",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default config;
