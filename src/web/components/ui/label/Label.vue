<script setup lang="ts">
import type { LabelProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "cn";
import { Label } from "reka-ui";

const props = defineProps<LabelProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <Label
    data-slot="label"
    v-bind="delegatedProps"
    :class="cn('flex items-center gap-2 text-sm leading-none font-medium select-none', props.class)"
  >
    <slot />
  </Label>
</template>
