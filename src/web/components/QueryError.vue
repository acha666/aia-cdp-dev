<script setup lang="ts">
import { CircleAlertIcon, RotateCwIcon } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/utils/errors";

const props = defineProps<{ error: unknown; title: string }>();
defineEmits<{ retry: [] }>();

const i18n = useI18n();
const { t } = i18n;
const message = computed(() => errorMessage(props.error, i18n));
</script>

<template>
  <Alert variant="destructive" data-testid="query-error">
    <CircleAlertIcon />
    <AlertTitle>{{ title }}</AlertTitle>
    <AlertDescription>{{ message }}</AlertDescription>
    <AlertAction>
      <Button variant="outline" size="xs" @click="$emit('retry')">
        <RotateCwIcon data-icon="inline-start" />
        {{ t("common.retry") }}
      </Button>
    </AlertAction>
  </Alert>
</template>
