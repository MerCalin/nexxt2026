import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  // In development the staff API runs separately; Nitro's dev server answers every request itself,
  // so /api is proxied with a Nitro route rule (Vite's server.proxy is never reached).
  // In AWS the load balancer routes /api/* to the staff API, so no proxy is built into the bundle.
  const staffApi = process.env.STAFF_API_DEV_URL ?? "http://localhost:3001";
  return {
    // "@/…" → frontend/… (Untitled UI components import each other through this alias)
    resolve: { alias: { "@": fileURLToPath(new URL("./frontend", import.meta.url)) } },
    plugins: [
      tailwindcss(),
      tanstackStart({ srcDirectory: "frontend" }),
      nitro(command === "serve" ? { routeRules: { "/api/**": { proxy: `${staffApi}/api/**` } } } : {}),
      react(),
    ],
  };
});
