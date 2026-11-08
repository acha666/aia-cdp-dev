<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { I18nT, useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { queries } from "@/client/queries";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import DetailLayout from "@/components/DetailLayout.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { useClock } from "@/composables/useClock";
import type en from "@/locales/en.json";
import { formatDate, relativeTime } from "@/utils/dates";
import { computeTargetStatus } from "@/utils/status";
import { rowOf, rows } from "@/utils/values";
import { formatAlgorithm, versionText } from "@/x509/fields";
import { SIGNATURE_ALG_NAMES } from "../../core/pki/constants.ts";
import { plainExtension } from "../../core/pki/extensions.ts";

// One CRL target, in DetailLayout's frame: header with label, kind, status and
// downloads, then the current CRL in tabs (overview with the issuer link, CRL and base CRL numbers,
// thisUpdate / nextUpdate / Next CRL Publish, algorithm and fingerprints; revoked certificates;
// extensions). The target list gives the catalog's facts, the current CRL's DER (decoded in the
// browser) the rest; a target the list does not have is not found. A target without a current CRL
// says it is not published instead, and offers no downloads (its paths answer 404). `targetId`
// matched the router's pattern. Tabs and panels as on CertificatePage.
const props = defineProps<{ targetId: string }>();

const i18n = useI18n();
const { t } = i18n;
const now = useClock();
const list = useQuery(queries.crls());
const data = computed(() => list.data.value?.find((item) => item.targetId === props.targetId));
const missing = computed(() => list.data.value !== undefined && data.value === undefined);

const current = computed(() => data.value?.current ?? null);
const blob = useQuery(() => ({
  ...queries.crlBlob(current.value?.sha256 ?? ""),
  enabled: current.value !== null,
}));
/** The decoded current CRL; null without one. */
const crl = computed(() => (current.value === null ? null : blob.data.value));
const error = computed(() => list.error.value ?? (current.value ? blob.error.value : null));

function refetch() {
  void list.refetch();
  if (current.value !== null) {
    void blob.refetch();
  }
}

/** The label once the current CRL (if any) is decoded too. */
const name = computed(() => (crl.value === undefined ? undefined : data.value?.label));

const status = computed(() => computeTargetStatus(current.value, now.value.getTime()));
const extensions = computed(() => crl.value?.crlExtensions?.extensions.map(plainExtension) ?? []);

const time = (iso: string | null | undefined) => formatDate(iso, i18n);
const row = rowOf<keyof typeof en.details.crl>(i18n, "details.crl");

/** The overview of the current CRL, in sections; the issuer link and the status are in the header. */
const overview = computed(() => {
  const published = current.value;
  const decoded = crl.value;
  if (!published || !decoded) {
    return null;
  }
  const { summary } = published;
  return {
    information: rows(
      row("crlNumber", summary.crlNumber),
      summary.baseCrlNumber !== null && row("baseCrlNumber", summary.baseCrlNumber),
      row("version", versionText(decoded.version)),
      row("publishedAt", time(published.publishedAt)),
      row("size", t("common.bytes", { count: published.size }))
    ),
    validity: rows(
      row("thisUpdate", time(summary.thisUpdate)),
      row("nextUpdate", time(summary.nextUpdate)),
      summary.nextPublish !== null && row("nextPublish", time(summary.nextPublish))
    ),
    cryptography: [
      row(
        "signatureAlgorithm",
        formatAlgorithm(decoded.signatureAlgorithm, SIGNATURE_ALG_NAMES, i18n)
      ),
    ],
    fingerprints: [
      { label: "SHA-1", value: { hex: summary.sha1 } },
      { label: "SHA-256", value: { hex: published.sha256 } },
    ],
  };
});

const SECTIONS = ["information", "validity", "cryptography", "fingerprints"] as const;

/**
 * Time to nextUpdate (or since it, once expired) next to the status badge; to thisUpdate while not
 * yet valid (a browser clock behind the server's), as on CertificatePage.
 */
const statusDetail = computed(() => {
  const summary = current.value?.summary;
  if (!summary || status.value === "unknown") {
    return null;
  }
  const boundary = status.value === "not-yet-valid" ? summary.thisUpdate : summary.nextUpdate;
  return relativeTime(boundary, now.value.getTime(), i18n, true);
});

const PANEL = "rounded-md pt-2 focus-visible:ring-3 focus-visible:ring-ring/50";
</script>

<template>
  <DetailLayout
    :id="targetId"
    kind="crl"
    :name="name"
    :missing="missing"
    :error="error"
    @retry="refetch()"
  >
    <template v-if="data && crl !== undefined">
      <header class="grid gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-semibold tracking-tight break-all">{{ data.label }}</h1>
          <KindBadge :kind="data.kind" />
          <StatusBadge :state="status" />
          <span
            v-if="statusDetail"
            class="text-sm text-muted-foreground"
            data-testid="status-detail"
          >
            ({{ statusDetail }})
          </span>
        </div>
        <I18nT
          keypath="details.crl.issuedBy"
          scope="global"
          tag="p"
          class="text-sm text-muted-foreground"
        >
          <template #issuer>
            <RouterLink
              :to="{ name: 'certificate', params: { id: data.issuer.id } }"
              class="text-foreground underline-offset-4 hover:underline"
              data-testid="issuer-link"
            >
              {{ data.issuer.label ?? data.issuer.subjectCN ?? t("common.unknown") }}
            </RouterLink>
          </template>
        </I18nT>
        <DownloadLinks :downloads="current === null ? [] : data.downloads" />
      </header>

      <div
        v-if="current === null"
        class="rounded-lg border border-dashed p-4"
        data-testid="unpublished"
      >
        <p class="font-medium">{{ t("crl.unpublished") }}</p>
        <p class="text-sm text-muted-foreground">{{ t("details.crl.unpublishedBody") }}</p>
      </div>

      <Tabs v-else-if="crl" :key="targetId" default-value="overview" class="min-w-0">
        <TabsList class="max-w-full justify-start overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="revoked">
            {{ t("details.crl.revokedCertificates") }}
            ({{ crl.entries.length }})
          </TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.crl.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" :class="[PANEL, 'grid gap-6']" data-testid="crl-overview">
          <template v-if="overview">
            <section v-for="section in SECTIONS" :key="section" class="space-y-2">
              <h2 class="text-sm font-medium">{{ t(`details.crl.${section}`) }}</h2>
              <KeyValueList :items="overview[section]" />
            </section>
          </template>
          <NameDetails :name="crl.issuer" :title="t('details.crl.issuer')" />
        </TabsContent>
        <TabsContent value="revoked" :class="PANEL">
          <RevokedTable :entries="crl.entries" />
        </TabsContent>
        <TabsContent value="extensions" :class="PANEL">
          <!-- The extensions' accordion headings are h3. -->
          <h2 class="sr-only">{{ t("details.crl.extensions") }}</h2>
          <ExtensionList :extensions="extensions" />
        </TabsContent>
      </Tabs>
    </template>
  </DetailLayout>
</template>
