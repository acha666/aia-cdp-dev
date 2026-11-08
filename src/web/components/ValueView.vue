<script setup lang="ts">
import { useI18n } from "vue-i18n";
import HexValue from "@/components/HexValue.vue";
import { Badge } from "@/components/ui/badge";
import type { Value } from "@/utils/values";

const props = defineProps<{ value: Value | null | undefined }>();

const { t } = useI18n();

const empty = (value: Value | null | undefined) =>
  !value ||
  (typeof value === "object" &&
    ("hex" in value ? !value.hex : "lines" in value ? !value.lines.length : !value.tags.length));
</script>

<template>
  <span v-if="empty(props.value)" class="text-muted-foreground">{{ t("common.emptyValue") }}</span>
  <span v-else-if="typeof value === 'string'" class="whitespace-pre-wrap">{{ value }}</span>
  <HexValue v-else-if="value && 'hex' in value" :value="value.hex" />
  <ul v-else-if="value && 'lines' in value" class="font-mono text-xs leading-5 break-all">
    <li v-for="(line, index) in value.lines" :key="index">{{ line }}</li>
  </ul>
  <ul v-else-if="value" class="flex flex-wrap gap-1">
    <li v-for="(tag, index) in value.tags" :key="index">
      <Badge variant="secondary" class="font-normal">{{ tag }}</Badge>
    </li>
  </ul>
</template>
