import type { NextConfig } from "next";

// better-sqlite3 and dockerode ship native/optional deps that Next's bundler
// can't bundle for the server runtime. Force them to be required at runtime.
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "dockerode"],
};

export default nextConfig;
