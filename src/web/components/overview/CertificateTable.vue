<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { queries } from "@/client/queries";
import DownloadLinks from "@/components/DownloadLinks.vue";
import OverviewTable from "@/components/overview/OverviewTable.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { TableCell, TableRow } from "@/components/ui/table";
import { useClock } from "@/composables/useClock";
import { formatDate, relativeTime } from "@/utils/dates";
import { computeCertificateStatus } from "@/utils/status";

// The imported certificates: name (config label, else subject CN), issuer, validity with
// the time left while valid, status and downloads, sorted by name. The list keeps showing while it
// refetches; skeleton rows appear only before the first answer. On a phone (below sm) only the name
// and the status show: with every column the table scrolls sideways inside its card, which hides
// the status; issuer, validity and downloads are on the detail page. From sm up, where the table
// may still scroll, the name keeps a minimum width instead of one word per line.
const { data, error, refetch } = useQuery(queries.certificates());

const SECONDARY = "hidden sm:table-cell";
const COLUMNS = [
  { label: "table.name" },
  { label: "table.issuer", class: SECONDARY },
  { label: "table.validity", class: SECONDARY },
  { label: "table.status" },
  { label: "table.downloads", class: SECONDARY },
];
const now = useClock();
const i18n = useI18n();
const { t, locale } = i18n;

const rows = computed(() => {
  const nowMs = now.value.getTime();
  return (data.value ?? [])
    .map((certificate) => {
      const { notBefore, notAfter, issuerCN, subjectCN } = certificate.summary;
      const state = computeCertificateStatus(notBefore, notAfter, nowMs);
      return {
        id: certificate.id,
        name: certificate.label ?? subjectCN ?? t("details.certificate.unknownName"),
        // The CN under a label, when they differ.
        subjectCN: certificate.label !== null && subjectCN !== certificate.label ? subjectCN : null,
        issuer: issuerCN ?? t("common.unknown"),
        from: formatDate(notBefore, i18n, { time: false, zone: false }),
        until: formatDate(notAfter, i18n, { time: false }),
        // Only while the certificate is valid (expiring is the last tenth of that).
        remaining:
          state === "valid" || state === "expiring" ? relativeTime(notAfter, nowMs, i18n) : null,
        state,
        downloads: certificate.downloads,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale.value) || a.id.localeCompare(b.id));
});
</script>

<template>
  <OverviewTable
    list="certificates"
    :columns="COLUMNS"
    :count="data?.length"
    :error="error"
    data-testid="certificate-table"
    @retry="refetch()"
  >
    <TableRow v-for="row in rows" :key="row.id" :data-id="row.id">
      <TableCell class="whitespace-normal sm:min-w-44">
        <RouterLink
          :to="{ name: 'certificate', params: { id: row.id } }"
          class="font-medium underline-offset-4 hover:underline"
        >
          {{ row.name }}
        </RouterLink>
        <div v-if="row.subjectCN" class="text-xs text-muted-foreground">
          {{ row.subjectCN }}
        </div>
      </TableCell>
      <TableCell :class="SECONDARY" class="min-w-40 whitespace-normal text-muted-foreground">{{
        row.issuer
      }}</TableCell>
      <TableCell :class="SECONDARY" class="text-xs">
        <div>{{ row.from }} – {{ row.until }}</div>
        <div v-if="row.remaining" class="text-muted-foreground" data-testid="remaining">
          {{ row.remaining }}
        </div>
      </TableCell>
      <TableCell><StatusBadge :state="row.state" /></TableCell>
      <TableCell :class="[SECONDARY, { 'text-center': row.downloads.length === 0 }]">
        <DownloadLinks :downloads="row.downloads" />
      </TableCell>
    </TableRow>
  </OverviewTable>
</template>
