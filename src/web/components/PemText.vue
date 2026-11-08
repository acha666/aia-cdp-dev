<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import { ApiError, apiFetch } from "@/client/errors";
import CopyButton from "@/components/CopyButton.vue";
import QueryError from "@/components/QueryError.vue";
import { Skeleton } from "@/components/ui/skeleton";

const props = defineProps<{ path: string }>();

const { t } = useI18n();

const pem = useQuery(() => ({
  queryKey: ["pem", props.path],
  queryFn: async ({ signal }) => {
    const response = await apiFetch(props.path, { cache: "no-cache", signal });
    if (!response.ok) {
      const code = response.status === 404 ? "not_found" : "invalid_response";
      throw new ApiError(response.status, code, `GET ${props.path}: ${String(response.status)}`);
    }
    return response.text();
  },
}));
</script>

<template>
  <QueryError
    v-if="pem.isError.value && pem.data.value === undefined"
    :error="pem.error.value"
    :title="t('details.raw.loadFailed')"
    @retry="pem.refetch()"
  />
  <Skeleton v-else-if="pem.data.value === undefined" class="h-40 w-full" />
  <div v-else class="relative">
    <CopyButton labelled :text="pem.data.value ?? ''" class="absolute top-2 right-2" />
    <pre
      class="max-h-[32rem] overflow-auto rounded-lg bg-muted/50 p-3 pr-24 font-mono text-xs leading-5"
      data-testid="pem-text"
      >{{ pem.data.value }}</pre>
  </div>
</template>
