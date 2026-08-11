import { cloudflare } from "@cloudflare/vite-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./sites-vite-plugin";

const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 5_173),
    strictPort: true,
  },
  build: {
    outDir: ".notes/build-codex/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, "client/app.js"),
      },
      output: {
        entryFileNames: "client/[name].js",
      },
    },
  },
  plugins: [
    sites(),
    cloudflare({
      persistState: { path: process.env.CLOUDFLARE_STATE_PATH || ".notes/build-codex/cloudflare-state" },
      config: {
        main: "./worker/index.ts",
        compatibility_date: "2026-05-22",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*", "/ws"],
        },
        durable_objects: {
          bindings: [
            { name: "ROOMS", class_name: "RoomDurableObject" },
            { name: "DIRECTORY", class_name: "DirectoryDurableObject" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: ["RoomDurableObject", "DirectoryDurableObject"],
          },
        ],
        d1_databases: hostingConfig.d1
          ? [
              {
                binding: hostingConfig.d1,
                database_name: "anytogether-d1",
                database_id: LOCAL_DATABASE_ID,
              },
            ]
          : [],
      },
    }),
  ],
});
