import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname
  },
  serverExternalPackages: ["tesseract.js", "tesseract.js-core"],
  allowedDevOrigins: ["*"],
};

export default nextConfig;
