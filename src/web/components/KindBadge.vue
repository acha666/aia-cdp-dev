<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";

type Kind = "certificate" | "full" | "delta";

const CLASSES = {
  certificate:
    "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:border-blue-400/30 dark:text-blue-300",
  full: "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:border-purple-400/30 dark:text-purple-300",
  delta:
    "border-green-500/30 bg-green-500/10 text-green-700 dark:border-green-400/30 dark:text-green-300",
} satisfies Record<Kind, string>;

defineProps<{ kind: Kind }>();

const { t } = useI18n();
</script>

<template>
  <Badge variant="outline" :data-kind="kind" :class="CLASSES[kind]">
    {{ t(`kind.${kind}`) }}
  </Badge>
</template>
