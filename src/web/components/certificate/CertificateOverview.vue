<script setup lang="ts">
import type { Certificate } from "pkijs";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { KEY_ALG_NAMES, SIGNATURE_ALG_NAMES } from "../../../core/pki/constants.ts";
import { toUpperHex } from "../../../core/digest.ts";
import type { CertificateListItem } from "@/client/types";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import type en from "@/locales/en.json";
import { formatDate } from "@/utils/dates";
import { compareTargets } from "@/utils/targets";
import { rowOf, rows } from "@/utils/values";
import { formatAlgorithm, publicKeyInfo, uniqueIdHex, versionText } from "@/x509/fields";

const props = defineProps<{ certificate: CertificateListItem; decoded: Certificate }>();

const i18n = useI18n();
const { t, locale } = i18n;
const row = rowOf<keyof typeof en.details.certificate>(i18n, "details.certificate");

const validity = computed(() => [
  row("notBefore", formatDate(props.decoded.notBefore.value.toISOString(), i18n)),
  row("notAfter", formatDate(props.decoded.notAfter.value.toISOString(), i18n)),
]);

const general = computed(() => [
  row("x509Version", versionText(props.decoded.version)),
  row("serialNumber", { hex: toUpperHex(props.decoded.serialNumber.valueBlock.valueHexView) }),
  row("imported", formatDate(props.certificate.importedAt, i18n)),
  row("size", t("common.bytes", { count: props.certificate.size })),
]);

const publicKey = computed(() => {
  const spki = props.decoded.subjectPublicKeyInfo;
  const { bits, curve } = publicKeyInfo(spki);
  return rows(
    row("publicKeyAlgorithm", formatAlgorithm(spki.algorithm, KEY_ALG_NAMES, i18n)),
    bits !== undefined && row("keySize", `${String(bits)} ${t("common.bits")}`),
    curve !== undefined && row("curve", curve)
  );
});

const signature = computed(() => [
  row(
    "signatureAlgorithm",
    formatAlgorithm(props.decoded.signatureAlgorithm, SIGNATURE_ALG_NAMES, i18n)
  ),
  row("signatureValue", { hex: toUpperHex(props.decoded.signatureValue.valueBlock.valueHexView) }),
]);

const fingerprints = computed(() => [
  { label: "SHA-1", value: { hex: props.certificate.summary.sha1 } },
  { label: "SHA-256", value: { hex: props.certificate.id } },
]);

const targets = computed(() =>
  [...props.certificate.targets].sort((a, b) => compareTargets(a, b, locale.value))
);

const uniqueIds = computed(() => {
  const issuerUniqueId = uniqueIdHex(props.decoded.issuerUniqueID);
  const subjectUniqueId = uniqueIdHex(props.decoded.subjectUniqueID);
  return rows(
    issuerUniqueId !== undefined && row("issuerUniqueId", { hex: issuerUniqueId }),
    subjectUniqueId !== undefined && row("subjectUniqueId", { hex: subjectUniqueId })
  );
});
</script>

<template>
  <div class="grid gap-6">
    <div class="grid gap-6 lg:grid-cols-2">
      <NameDetails :name="decoded.subject" :title="t('details.certificate.subject')" />
      <NameDetails :name="decoded.issuer" :title="t('details.certificate.issuer')" />
    </div>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.validity") }}</h2>
      <KeyValueList :items="validity" />
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.information") }}</h2>
      <KeyValueList :items="general" />
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.cryptography") }}</h2>
      <KeyValueList :items="publicKey" data-testid="public-key" />
      <KeyValueList :items="signature" data-testid="signature" />
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.fingerprints") }}</h2>
      <KeyValueList :items="fingerprints" />
    </section>

    <section v-if="uniqueIds.length > 0" class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.uniqueIds") }}</h2>
      <KeyValueList :items="uniqueIds" />
    </section>

    <section class="space-y-2" data-testid="crl-targets">
      <h2 class="text-sm font-medium">{{ t("details.certificate.crlTargets") }}</h2>
      <ul v-if="targets.length > 0" class="space-y-1 text-sm">
        <li v-for="target in targets" :key="target.targetId" class="flex items-center gap-2">
          <KindBadge :kind="target.kind" />
          <RouterLink
            :to="{ name: 'crl', params: { targetId: target.targetId } }"
            class="underline-offset-4 hover:underline"
          >
            {{ target.label }}
          </RouterLink>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">
        {{ t("details.certificate.noCrlTargets") }}
      </p>
    </section>
  </div>
</template>
