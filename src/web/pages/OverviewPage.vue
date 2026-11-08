<script setup lang="ts">
import { useI18n } from "vue-i18n";
import CertificateTable from "@/components/overview/CertificateTable.vue";
import CrlUploadCard from "@/components/overview/CrlUploadCard.vue";
import CrlTargetTable from "@/components/overview/CrlTargetTable.vue";
import StatsBar from "@/components/overview/StatsBar.vue";
import { usePageTitle } from "@/composables/usePageTitle";

const { t } = useI18n();
usePageTitle(() => t("pages.overview.title"));
</script>

<template>
  <section class="grid gap-6">
    <h1 class="text-2xl font-semibold tracking-tight">{{ t("pages.overview.title") }}</h1>
    <StatsBar />
    <CertificateTable />
    <CrlTargetTable />
    <CrlUploadCard />
  </section>
</template>
