<script setup lang="ts">
import { ChevronLeftIcon, ChevronRightIcon } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CrlEntry } from "../../../core/pki/parsers.ts";
import { toUpperHex } from "../../../core/digest.ts";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import { formatDate } from "@/utils/dates";
import { entryColumns } from "@/x509/extensions";

// The revoked certificates of a target's current CRL: serial number, revocation date,
// reason and invalidity date; an empty list says so. A CRL can have tens of
// thousands of entries, so the table renders PAGE_SIZE rows at a time; the header row
// stays in view while the box scrolls. On the first and the last page one page button is only
// aria-disabled (a disabled button drops the focus to <body>). A row with entry extensions expands
// to list them all, since the columns leave out a hold instruction, the critical flags and any
// extension not decoded.
const props = defineProps<{ entries: readonly CrlEntry[] }>();

const PAGE_SIZE = 200;

const i18n = useI18n();
const { t } = i18n;
const page = ref(0);
/** The keys of the expanded rows; a row stays expanded across page changes. */
const expanded = ref(new Set<number>());

// A refetch with other entries starts over on the first page, every row collapsed.
watch(
  () => props.entries,
  () => {
    page.value = 0;
    expanded.value = new Set();
  }
);

function toggle(key: number) {
  if (!expanded.value.delete(key)) {
    expanded.value.add(key);
  }
}

const total = computed(() => props.entries.length);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const first = computed(() => page.value * PAGE_SIZE);
const last = computed(() => Math.min(first.value + PAGE_SIZE, total.value));

/** Only the rows of the current page are formatted. */
const rows = computed(() =>
  props.entries.slice(first.value, last.value).map((entry, index) => ({
    key: first.value + index,
    serial: toUpperHex(entry.serial),
    revoked: formatDate(entry.revocationDate.value.toISOString(), i18n),
    extensions: entry.extensions,
    ...entryColumns(entry.extensions, i18n),
  }))
);
</script>

<template>
  <p v-if="total === 0" class="text-sm text-muted-foreground" data-testid="revoked-empty">
    {{ t("details.crl.noRevoked") }}
  </p>
  <div v-else class="grid gap-2">
    <div class="max-h-[36rem] overflow-auto rounded-lg border">
      <table data-slot="table" class="w-full caption-bottom text-sm" data-testid="revoked-table">
        <TableHeader class="sticky top-0 z-10 bg-muted">
          <TableRow class="hover:bg-transparent">
            <TableHead class="w-0">
              <span class="sr-only">{{ t("details.crl.extensions") }}</span>
            </TableHead>
            <TableHead>{{ t("details.crl.serialNumber") }}</TableHead>
            <TableHead>{{ t("details.crl.revocationDate") }}</TableHead>
            <TableHead>{{ t("details.crl.reason") }}</TableHead>
            <TableHead>{{ t("details.crl.invalidSince") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="row in rows" :key="row.key">
            <TableRow>
              <TableCell class="w-0 pr-0">
                <Button
                  v-if="row.extensions.length > 0"
                  variant="ghost"
                  size="icon-xs"
                  :aria-expanded="expanded.has(row.key)"
                  :aria-label="t('details.crl.showEntryExtensions')"
                  data-testid="entry-toggle"
                  @click="toggle(row.key)"
                >
                  <ChevronRightIcon
                    class="transition-transform"
                    :class="{ 'rotate-90': expanded.has(row.key) }"
                  />
                </Button>
              </TableCell>
              <TableCell class="font-mono text-xs break-all whitespace-normal">{{
                row.serial
              }}</TableCell>
              <TableCell class="text-xs">{{ row.revoked }}</TableCell>
              <TableCell class="text-xs">{{ row.reason ?? "—" }}</TableCell>
              <TableCell class="text-xs">{{ row.invalidityDate ?? "—" }}</TableCell>
            </TableRow>
            <TableRow v-if="expanded.has(row.key)" class="hover:bg-transparent">
              <TableCell colspan="5" class="whitespace-normal">
                <ExtensionList :extensions="row.extensions" />
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </table>
    </div>
    <div
      v-if="pageCount > 1"
      class="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground"
    >
      <span data-testid="revoked-range">
        {{ t("details.crl.range", { from: first + 1, to: last, total }) }}
      </span>
      <Button
        variant="outline"
        size="icon-xs"
        :aria-disabled="page === 0 || undefined"
        class="aria-disabled:opacity-50"
        :aria-label="t('common.previousPage')"
        data-testid="previous-page"
        @click="page = Math.max(0, page - 1)"
      >
        <ChevronLeftIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-xs"
        :aria-disabled="page >= pageCount - 1 || undefined"
        class="aria-disabled:opacity-50"
        :aria-label="t('common.nextPage')"
        data-testid="next-page"
        @click="page = Math.min(pageCount - 1, page + 1)"
      >
        <ChevronRightIcon />
      </Button>
    </div>
  </div>
</template>
