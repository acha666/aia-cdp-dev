<script setup lang="ts">
import { CheckIcon, CopyIcon } from "@lucide/vue";
import { refAutoReset } from "@vueuse/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/utils/clipboard";

const props = defineProps<{ text: string; labelled?: boolean }>();

const { t } = useI18n();
const copied = refAutoReset(false, 1500);
const label = computed(() => t(copied.value ? "common.copied" : "common.copy"));

async function copy(): Promise<void> {
  try {
    await copyText(props.text);
    copied.value = true;
  } catch {
    copied.value = false;
    toast.error(t("common.copyFailed"));
  }
}
</script>

<template>
  <Button
    type="button"
    :variant="labelled ? 'outline' : 'ghost'"
    :size="labelled ? 'xs' : 'icon-xs'"
    :aria-label="labelled ? undefined : label"
    :title="labelled ? undefined : label"
    @click="copy()"
  >
    <component
      :is="copied ? CheckIcon : CopyIcon"
      :data-icon="labelled ? 'inline-start' : undefined"
    />
    <template v-if="labelled">{{ label }}</template>
  </Button>
</template>
