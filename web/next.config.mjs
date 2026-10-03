/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: plain HTML/JS/CSS served by Firebase Hosting, no Node server needed.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
