<script setup lang="ts">
import { computed } from "vue";
import CopyButton from "@/components/CopyButton.vue";

const props = withDefaults(
  defineProps<{
    value?: string | null;
    block?: boolean;
  }>(),
  { value: null, block: false }
);

const digits = computed(() => props.value?.toUpperCase() ?? "");
const groups = computed(() => digits.value.match(/.{1,2}/g) ?? []);
</script>

<template>
  <component
    :is="block ? 'div' : 'span'"
    class="min-w-0 items-baseline gap-1"
    :class="block ? 'flex' : 'inline-flex'"
  >
    <span class="min-w-0 font-mono break-words" data-testid="hex-value">
      <span v-for="(group, index) in groups" :key="index"
        >{{ index < groups.length - 1 ? `${group}:` : group }}<wbr
      /></span>
    </span>
    <CopyButton v-if="digits" :text="digits" class="self-center text-muted-foreground" />
  </component>
</template>
