<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import QueryError from "@/components/QueryError.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/composables/usePageTitle";

const props = defineProps<{
  kind: "certificate" | "crl";
  id: string;
  name?: string;
  missing: boolean;
  error: unknown;
}>();
defineEmits<{ retry: [] }>();

const { t } = useI18n();

usePageTitle(
  () =>
    props.name ??
    t(props.missing ? `details.${props.kind}.notFoundTitle` : `pages.${props.kind}.title`)
);
</script>

<template>
  <section class="grid gap-4">
    <Button as-child variant="ghost" size="sm" class="w-fit">
      <RouterLink to="/">
        <ArrowLeftIcon data-icon="inline-start" />
        {{ t("nav.backToOverview") }}
      </RouterLink>
    </Button>

    <slot v-if="name !== undefined" />

    <div v-else-if="missing" class="grid gap-2" data-testid="missing">
      <h1 class="text-2xl font-semibold tracking-tight">
        {{ t(`details.${kind}.notFoundTitle`) }}
      </h1>
      <p class="text-muted-foreground">{{ t(`details.${kind}.notFound`) }}</p>
      <code class="font-mono text-xs break-all text-muted-foreground">{{ id }}</code>
    </div>

    <QueryError
      v-else-if="error"
      :error="error"
      :title="t(`details.${kind}.loadFailed`)"
      @retry="$emit('retry')"
    />

    <div v-else class="grid gap-3" data-testid="detail-skeleton">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-5 w-40" />
      <Skeleton class="h-48 w-full" />
    </div>
  </section>
</template>
