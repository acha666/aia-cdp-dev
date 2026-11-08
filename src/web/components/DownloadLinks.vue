<script setup lang="ts">
import { DownloadIcon } from "@lucide/vue";
import { computed } from "vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ downloads: readonly string[] }>();

const links = computed(() => {
  const named = props.downloads.filter((href) => !href.endsWith(".pem")).length > 1;
  return props.downloads.map((href) => ({
    href,
    format: href.endsWith(".pem") ? "PEM" : "DER",
    fileName: named ? href.slice(href.lastIndexOf("/") + 1) : null,
  }));
});
</script>

<template>
  <span v-if="links.length > 0" class="inline-flex flex-wrap items-center gap-1">
    <Button
      v-for="link in links"
      :key="link.href"
      as="a"
      variant="outline"
      size="xs"
      :href="link.href"
      download
      :title="link.href"
      :data-format="link.format"
    >
      <DownloadIcon data-icon="inline-start" />{{ link.format
      }}<span
        v-if="link.fileName"
        class="font-mono font-normal text-muted-foreground"
        data-testid="file-name"
        >{{ link.fileName }}</span
      ><span class="sr-only">: {{ link.href }}</span>
    </Button>
  </span>
  <span v-else class="text-muted-foreground">—</span>
</template>
