import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const DEFAULT_SITE_NAME = "PKI AIA/CDP";

// In development, the API and downloads come from the server on port 8787.
const SERVER_PATHS = "^/(?:api|ca|crl|dcrl)/";

export default defineConfig(({ mode }) => {
  const configured = loadEnv(mode, repoRoot, "VITE_").VITE_SITE_NAME ?? "";
  process.env.VITE_SITE_NAME = configured === "" ? DEFAULT_SITE_NAME : configured;

  return {
    root: webRoot,
    envDir: repoRoot,
    plugins: [vue(), tailwindcss()],
    define: {
      __VUE_I18N_LEGACY_API__: false,
      __VUE_I18N_FULL_INSTALL__: false,
      __INTLIFY_PROD_DEVTOOLS__: false,
    },
    resolve: {
      alias: { "@": webRoot },
    },
    build: {
      outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      proxy: { [SERVER_PATHS]: "http://127.0.0.1:8787" },
    },
  };
});
