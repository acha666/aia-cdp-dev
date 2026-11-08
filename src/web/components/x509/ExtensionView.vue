<script setup lang="ts">
import { ChevronRightIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import HexValue from "@/components/HexValue.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import Asn1Dump from "@/components/x509/Asn1Dump.vue";
import type { ExtensionDisplay } from "@/x509/extensions";

// One extension as an accordion item (inside ExtensionList's Accordion). The header names it
// (OID beside a known name, on its baseline; hover underlines the name only), marks it critical
// and, unless decoded, gives its parse status. The body shows the sections of x509/extensions.ts,
// each one KeyValueList, a rule between them. An extension that is not decoded (no decoder, or
// its value does not decode) shows the parse error, an ASN.1 dump and the raw value.
defineProps<{ extension: ExtensionDisplay; value: string }>();

const { t } = useI18n();
</script>

<template>
  <AccordionItem :value="value" :data-oid="extension.oid">
    <AccordionTrigger class="hover:no-underline">
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="underline-offset-4 group-hover/accordion-trigger:underline">
          {{ extension.name ?? extension.oid }}
        </span>
        <span v-if="extension.name" class="font-mono text-xs font-normal text-muted-foreground">
          {{ extension.oid }}
        </span>
        <Badge v-if="extension.critical" variant="destructive" data-testid="critical">
          {{ t("extension.critical") }}
        </Badge>
        <Badge
          v-if="extension.status !== 'parsed'"
          :variant="extension.status === 'error' ? 'destructive' : 'outline'"
          data-testid="parse-status"
        >
          {{ t(`extension.status.${extension.status}`) }}
        </Badge>
      </span>
    </AccordionTrigger>
    <AccordionContent class="space-y-3">
      <template v-if="extension.sections">
        <p v-if="extension.sections.length === 0" class="text-sm text-muted-foreground">
          {{ t("common.emptyValue") }}
        </p>
        <KeyValueList
          v-for="(section, index) in extension.sections"
          :key="index"
          :items="section"
          :class="{ 'border-t pt-3': index > 0 }"
        />
      </template>

      <template v-else>
        <p v-if="extension.error" class="text-xs text-destructive" data-testid="parse-error">
          {{ t("extension.error") }}: {{ extension.error }}
        </p>
        <div v-if="extension.asn1?.length">
          <p class="mb-1 text-xs text-muted-foreground">{{ t("extension.asn1") }}</p>
          <Asn1Dump :lines="extension.asn1" />
        </div>
        <CollapsibleRoot v-slot="{ open }">
          <CollapsibleTrigger as-child>
            <Button variant="ghost" size="xs" class="-ml-2 text-muted-foreground">
              <ChevronRightIcon
                data-icon="inline-start"
                class="transition-transform"
                :class="{ 'rotate-90': open }"
              />
              {{ t("extension.rawHex") }}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <HexValue
              block
              :value="extension.hex"
              class="mt-1 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs"
            />
          </CollapsibleContent>
        </CollapsibleRoot>
      </template>
    </AccordionContent>
  </AccordionItem>
</template>
