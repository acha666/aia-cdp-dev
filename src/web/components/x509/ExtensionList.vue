<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PlainExtension } from "../../../core/pki/extensions.ts";
import { Accordion } from "@/components/ui/accordion";
import ExtensionView from "@/components/x509/ExtensionView.vue";
import { describeExtension } from "@/x509/extensions";
import type { ExtensionDisplay } from "@/x509/extensions";

const props = defineProps<{ extensions: readonly PlainExtension[] }>();

const i18n = useI18n();
const { t } = i18n;

const label = (extension: ExtensionDisplay) => extension.name ?? extension.oid;

const items = computed(() => {
  const sorted = props.extensions.map((extension) => describeExtension(extension, i18n));
  sorted.sort((a, b) => {
    if (a.critical !== b.critical) {
      return a.critical ? -1 : 1;
    }
    return label(a).localeCompare(label(b));
  });
  return sorted.map((extension, index) => ({
    extension,
    value: `${String(index)}-${extension.oid}`,
  }));
});
</script>

<template>
  <Accordion v-if="items.length > 0" type="multiple" class="rounded-lg border px-3">
    <ExtensionView
      v-for="item in items"
      :key="item.value"
      :extension="item.extension"
      :value="item.value"
    />
  </Accordion>
  <p v-else class="text-sm text-muted-foreground">{{ t("details.noExtensions") }}</p>
</template>
