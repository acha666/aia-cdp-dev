<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { queries } from "@/client/queries";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KindBadge from "@/components/KindBadge.vue";
import OverviewTable from "@/components/overview/OverviewTable.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { TableCell, TableRow } from "@/components/ui/table";
import { useClock } from "@/composables/useClock";
import { formatDate, relativeTime } from "@/utils/dates";
import { compareTargets } from "@/utils/targets";
import { computeTargetStatus } from "@/utils/status";

const { data, error, refetch } = useQuery(queries.crls());

const SECONDARY = "hidden sm:table-cell";
const COLUMNS = [
  { label: "table.label" },
  { label: "table.kind" },
  { label: "table.crlNumber", class: SECONDARY },
  { label: "table.updates", class: SECONDARY },
  { label: "table.revoked", class: `${SECONDARY} text-right` },
  { label: "table.status" },
  { label: "table.downloads", class: SECONDARY },
];
const now = useClock();
const i18n = useI18n();
const { t, locale } = i18n;

const rows = computed(() => {
  const nowMs = now.value.getTime();
  return [...(data.value ?? [])]
    .sort((a, b) => compareTargets(a, b, locale.value))
    .map((target) => {
      const state = computeTargetStatus(target.current, nowMs);
      const summary = target.current?.summary ?? null;
      return {
        targetId: target.targetId,
        label: target.label,
        kind: target.kind,
        issuer: target.issuer.label ?? target.issuer.subjectCN ?? t("common.unknown"),
        crlNumber: summary?.crlNumber ?? null,
        thisUpdate: summary
          ? formatDate(summary.thisUpdate, i18n, { time: false, zone: false })
          : null,
        nextUpdate: summary ? formatDate(summary.nextUpdate, i18n, { time: false }) : null,
        remaining: state === "current" ? relativeTime(summary?.nextUpdate, nowMs, i18n) : null,
        revoked: summary === null ? null : String(summary.revokedCount),
        state,
        downloads: target.current === null ? [] : target.downloads,
      };
    });
});
</script>

<template>
  <OverviewTable
    list="crls"
    :columns="COLUMNS"
    :count="data?.length"
    :error="error"
    data-testid="crl-target-table"
    @retry="refetch()"
  >
    <TableRow v-for="row in rows" :key="row.targetId" :data-id="row.targetId">
      <TableCell class="whitespace-normal sm:min-w-44">
        <RouterLink
          :to="{ name: 'crl', params: { targetId: row.targetId } }"
          class="font-medium underline-offset-4 hover:underline"
        >
          {{ row.label }}
        </RouterLink>
        <div class="text-xs text-muted-foreground">{{ row.issuer }}</div>
      </TableCell>
      <TableCell><KindBadge :kind="row.kind" /></TableCell>
      <TableCell :class="SECONDARY" class="font-mono text-xs" data-testid="crl-number">
        {{ row.crlNumber === null ? "—" : `#${row.crlNumber}` }}
      </TableCell>
      <TableCell :class="SECONDARY" class="text-xs">
        <template v-if="row.thisUpdate">
          <div>{{ row.thisUpdate }} – {{ row.nextUpdate }}</div>
          <div v-if="row.remaining" class="text-muted-foreground" data-testid="remaining">
            {{ row.remaining }}
          </div>
        </template>
        <span v-else class="text-muted-foreground">—</span>
      </TableCell>
      <TableCell :class="SECONDARY" class="text-right tabular-nums" data-testid="revoked-count">
        {{ row.revoked ?? "—" }}
      </TableCell>
      <TableCell><StatusBadge :state="row.state" /></TableCell>
      <TableCell :class="[SECONDARY, { 'text-center': row.downloads.length === 0 }]">
        <DownloadLinks :downloads="row.downloads" />
      </TableCell>
    </TableRow>
  </OverviewTable>
</template>
