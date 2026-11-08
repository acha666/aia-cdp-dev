import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/web/**"],
        },
      },
      {
        plugins: [vue()],
        resolve: { alias: { "@": webRoot } },
        assetsInclude: ["**/*.der"],
        server: { fs: { deny: [".env", ".env.*", "**/.git/**"] } },
        define: {
          __VUE_I18N_LEGACY_API__: false,
          __VUE_I18N_FULL_INSTALL__: false,
          __INTLIFY_PROD_DEVTOOLS__: false,
        },
        test: {
          name: "web",
          include: ["tests/web/**/*.test.ts"],
          environment: "happy-dom",
          env: { VITE_SITE_NAME: "Test PKI" },
          setupFiles: ["tests/web/setup.ts"],
        },
      },
    ],
  },
});
