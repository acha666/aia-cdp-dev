<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { RouterLink, RouterView } from "vue-router";
import HealthBadge from "@/components/HealthBadge.vue";
import LocaleSelect from "@/components/LocaleSelect.vue";
import { Toaster } from "@/components/ui/sonner";
import { siteName } from "@/site";

const CONTAINER = "mx-auto w-full max-w-6xl px-4";

const { t } = useI18n();
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <a
      href="#main"
      class="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-3 focus:ring-ring/50"
    >
      {{ t("app.skipToContent") }}
    </a>
    <header class="border-b">
      <div :class="CONTAINER" class="flex flex-wrap items-center gap-2 py-3">
        <RouterLink
          to="/"
          class="mr-auto min-w-0 truncate rounded-sm font-semibold"
          data-testid="site-name"
        >
          {{ siteName }}
        </RouterLink>
        <HealthBadge />
      </div>
    </header>
    <main id="main" tabindex="-1" :class="CONTAINER" class="flex-1 py-6 outline-none">
      <RouterView />
    </main>
    <footer class="border-t">
      <div
        :class="CONTAINER"
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-4 text-xs text-muted-foreground"
      >
        <a href="/api/v1/openapi.json" class="underline-offset-4 hover:underline">
          {{ t("app.apiDocument") }}
        </a>
        <LocaleSelect />
      </div>
    </footer>
    <Toaster position="top-center" />
  </div>
</template>
