<script setup lang="ts">
import ValueView from "@/components/ValueView.vue";
import type { Row } from "@/utils/values";

defineProps<{ items: readonly Row[] }>();
</script>

<template>
  <dl
    class="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-y-2"
  >
    <template v-for="(item, index) in items" :key="index">
      <dt class="text-muted-foreground sm:break-words" :title="item.title">{{ item.label }}</dt>
      <dd class="mb-2 min-w-0 break-words sm:mb-0">
        <ValueView :value="item.value" />
      </dd>
    </template>
  </dl>
</template>
