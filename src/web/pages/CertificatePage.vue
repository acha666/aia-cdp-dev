<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { queries } from "@/client/queries";
import CertificateOverview from "@/components/certificate/CertificateOverview.vue";
import DetailLayout from "@/components/DetailLayout.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KindBadge from "@/components/KindBadge.vue";
import PemText from "@/components/PemText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import { useClock } from "@/composables/useClock";
import { relativeTime } from "@/utils/dates";
import { computeCertificateStatus } from "@/utils/status";
import { plainExtension } from "../../core/pki/extensions.ts";

const props = defineProps<{ id: string }>();

const i18n = useI18n();
const { t } = i18n;
const now = useClock();
const list = useQuery(queries.certificates());
const blob = useQuery(() => queries.certificateBlob(props.id));

const data = computed(() => list.data.value?.find((item) => item.id === props.id));
const missing = computed(() => list.data.value !== undefined && data.value === undefined);
const error = computed(() => list.error.value ?? blob.error.value);

function refetch() {
  void list.refetch();
  void blob.refetch();
}

const name = computed(() => {
  const item = data.value;
  if (item === undefined || blob.data.value === undefined) {
    return undefined;
  }
  return item.label ?? item.summary.subjectCN ?? t("details.certificate.unknownName");
});

const state = computed(() => {
  const summary = data.value?.summary;
  return summary
    ? computeCertificateStatus(summary.notBefore, summary.notAfter, now.value.getTime())
    : null;
});

const statusDetail = computed(() => {
  const summary = data.value?.summary;
  if (!summary || state.value === "unknown") {
    return null;
  }
  const boundary = state.value === "not-yet-valid" ? summary.notBefore : summary.notAfter;
  return relativeTime(boundary, now.value.getTime(), i18n, true);
});

const extensions = computed(() => blob.data.value?.extensions?.map(plainExtension) ?? []);
const pemPath = computed(() => data.value?.downloads.find((path) => path.endsWith(".pem")) ?? null);

const PANEL = "rounded-md pt-2 focus-visible:ring-3 focus-visible:ring-ring/50";
</script>

<template>
  <DetailLayout
    :id="id"
    kind="certificate"
    :name="name"
    :missing="missing"
    :error="error"
    @retry="refetch()"
  >
    <template v-if="data && blob.data.value">
      <header class="grid gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-semibold tracking-tight break-all">{{ name }}</h1>
          <KindBadge kind="certificate" />
          <StatusBadge v-if="state" :state="state" />
          <span
            v-if="statusDetail"
            class="text-sm text-muted-foreground"
            data-testid="status-detail"
          >
            ({{ statusDetail }})
          </span>
        </div>
        <p
          v-if="data.label !== null && data.summary.subjectCN"
          class="text-sm text-muted-foreground"
        >
          {{ data.summary.subjectCN }}
        </p>
        <DownloadLinks :downloads="data.downloads" />
      </header>

      <Tabs :key="id" default-value="overview" class="min-w-0">
        <TabsList class="max-w-full justify-start overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.certificate.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
          <TabsTrigger v-if="pemPath" value="raw">{{ t("details.tabs.raw") }}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" :class="PANEL">
          <CertificateOverview :certificate="data" :decoded="blob.data.value" />
        </TabsContent>
        <TabsContent value="extensions" :class="PANEL">
          <h2 class="sr-only">{{ t("details.certificate.extensions") }}</h2>
          <ExtensionList :extensions="extensions" />
        </TabsContent>
        <TabsContent v-if="pemPath" value="raw" :class="PANEL">
          <PemText :path="pemPath" />
        </TabsContent>
      </Tabs>
    </template>
  </DetailLayout>
</template>
