<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner";

import { OctagonXIcon } from "@lucide/vue";
import { Toaster as Sonner } from "vue-sonner";

const props = defineProps<Pick<ToasterProps, "position">>();
</script>

<template>
  <Sonner
    class="toaster group"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    }"
    :toast-options="{ classes: { toast: 'rounded-2xl' } }"
    :position="props.position"
  >
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
  </Sonner>
</template>
