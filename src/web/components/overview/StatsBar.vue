<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { queries } from "@/client/queries";
import QueryError from "@/components/QueryError.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { useClock } from "@/composables/useClock";
import { computeTargetStatus, needsAttention } from "@/utils/status";

const certificates = useQuery(queries.certificates());
const targets = useQuery(queries.crls());
const now = useClock();
const { t } = useI18n();

const failed = computed(() => certificates.error.value ?? targets.error.value);

function retry() {
  void certificates.refetch();
  void targets.refetch();
}

const tiles = computed(() => {
  const certificateList = certificates.data.value;
  const targetList = targets.data.value;
  if (certificateList === undefined || targetList === undefined) {
    return null;
  }
  const count = (list: typeof targetList) => ({
    full: list.filter((target) => target.kind === "full").length,
    delta: list.filter((target) => target.kind === "delta").length,
  });
  const configured = count(targetList);
  const publishedList = targetList.filter((target) => target.current !== null);
  const published = count(publishedList);
  // Delta CRLs repeat entries of their base CRL, so only full CRLs are counted.
  const fullCrls = publishedList.filter((target) => target.kind === "full");
  const revocations = fullCrls.reduce(
    (sum, target) => sum + (target.current?.summary.revokedCount ?? 0),
    0
  );
  const nowMs = now.value.getTime();
  const attention = targetList.filter((target) =>
    needsAttention(computeTargetStatus(target.current, nowMs))
  ).length;
  return [
    {
      key: "certificates",
      label: t("stats.certificates"),
      value: String(certificateList.length),
      hint: t("stats.certificatesHint"),
    },
    {
      key: "targets",
      label: t("stats.targets"),
      value: String(targetList.length),
      hint: t("stats.byKind", configured),
    },
    {
      key: "published",
      label: t("stats.published"),
      value: String(publishedList.length),
      hint: t("stats.byKind", published),
    },
    {
      key: "revocations",
      label: t("stats.revocations"),
      value: fullCrls.length === 0 ? t("common.unknown") : String(revocations),
      hint: t("stats.revocationsHint"),
    },
    {
      key: "attention",
      label: t("stats.needsAttention"),
      value: String(attention),
      hint: t("stats.needsAttentionHint"),
      warn: attention > 0,
    },
  ];
});
</script>

<template>
  <section :aria-label="t('stats.title')">
    <QueryError
      v-if="tiles === null && failed"
      :error="failed"
      :title="t('stats.loadFailed')"
      @retry="retry()"
    />
    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <template v-if="tiles">
        <dl
          v-for="tile in tiles"
          :key="tile.key"
          class="rounded-xl p-3 ring-1 ring-foreground/10"
          :data-stat="tile.key"
        >
          <dt class="text-xs text-muted-foreground">{{ tile.label }}</dt>
          <dd
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="{ 'text-warning': tile.warn }"
            data-testid="stat-value"
          >
            {{ tile.value }}
          </dd>
          <dd class="mt-0.5 text-xs text-muted-foreground">{{ tile.hint }}</dd>
        </dl>
      </template>
      <template v-else>
        <div
          v-for="index in 5"
          :key="index"
          class="rounded-xl p-3 ring-1 ring-foreground/10"
          data-testid="stat-skeleton"
        >
          <Skeleton class="h-3 w-20" />
          <Skeleton class="mt-2 h-7 w-10" />
          <Skeleton class="mt-1 h-3 w-24" />
        </div>
      </template>
    </div>
  </section>
</template>
