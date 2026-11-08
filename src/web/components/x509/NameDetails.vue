<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RelativeDistinguishedNames } from "pkijs";
import KeyValueList from "@/components/KeyValueList.vue";
import { readName } from "@/x509/names";

const props = defineProps<{ name: RelativeDistinguishedNames; title?: string }>();

const { t } = useI18n();

// The common attributes always get a row; any others follow with their own labels.
const FIELDS = [
  ["commonName", "2.5.4.3"],
  ["organization", "2.5.4.10"],
  ["organizationalUnit", "2.5.4.11"],
  ["country", "2.5.4.6"],
  ["stateOrProvince", "2.5.4.8"],
  ["locality", "2.5.4.7"],
] as const;
const NORMALIZED_OIDS = new Set<string>(FIELDS.map(([, oid]) => oid));

const view = computed(() => readName(props.name));

const items = computed(() => {
  const attributes = view.value.rdns.flat();
  const first = (oid: string) =>
    attributes.find((attribute) => attribute.oid === oid && attribute.string !== undefined)?.string;
  return [
    ...FIELDS.map(([field, oid]) => ({
      label: t(`nameFields.${field}`),
      value: first(oid)?.trim() ?? "",
    })),
    ...attributes
      .filter((attribute) => !NORMALIZED_OIDS.has(attribute.oid))
      .map((attribute) => ({
        label: attribute.label,
        value: attribute.value,
        title: attribute.encoding,
      })),
  ];
});
</script>

<template>
  <section class="space-y-2">
    <h2 v-if="title" class="text-sm font-medium">{{ title }}</h2>
    <p v-if="view.rfc4514" class="font-mono text-xs break-all text-muted-foreground">
      {{ view.rfc4514 }}
    </p>
    <KeyValueList :items="items" />
  </section>
</template>
