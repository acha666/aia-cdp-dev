<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "cn";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div
    data-slot="card-header"
    :class="
      cn(
        'grid auto-rows-min items-start gap-1 rounded-t-xl px-4 has-data-[slot=card-description]:grid-rows-[auto_auto]',
        props.class
      )
    "
  >
    <slot />
  </div>
</template>
