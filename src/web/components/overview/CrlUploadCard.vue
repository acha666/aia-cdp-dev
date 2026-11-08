<script setup lang="ts">
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FilePlusIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  UploadIcon,
} from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useDropZone, useFocus } from "@vueuse/core";
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "@/client/errors";
import { queries, useUploadCrl } from "@/client/queries";
import type { PublishedCrl } from "@/client/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCrlUploadInput } from "@/composables/useCrlUploadInput";
import { uploadToken as token } from "@/upload-token";
import { errorMessage, errorReason } from "@/utils/errors";

// Publishing a CRL from the browser: no submit while the input is invalid or an upload runs, the
// input cleared only if it did not change meanwhile, a drop takes its first file, the file input is
// reset after a choice, the PEM hint only for text that is there. Files go as they are, pasted PEM
// as a file named crl.pem, both as the request body; the server tells PEM from DER by the bytes.
// created, updated and unchanged are all successes; a failure shows errors.<code> inline. The
// optional token (AIA_UPLOAD_TOKEN) stays in memory and opens itself when the server
// asks for it. Keyboard focus: the submit button is only aria-disabled while an upload runs (a
// disabled button drops the focus to <body>), and the result alert takes the focus from it
// afterwards (a cleared input disables the button).
const i18n = useI18n();
const { t } = i18n;
const client = useQueryClient();
const upload = useUploadCrl();
const { input, text, file, isValid, selectFile, clear } = useCrlUploadInput();

const ids = { text: useId(), token: useId() };
const dropZone = useTemplateRef<HTMLElement>("dropZone");
const { isOverDropZone } = useDropZone(dropZone, {
  onDrop: (files) => {
    if (files?.[0]) {
      selectFile(files[0]);
    }
  },
});
const tokenOpen = ref(false);
// The token field takes the focus whenever it is rendered (the collapsible mounts it when it opens).
const tokenField = useTemplateRef<ComponentPublicInstance>("tokenField");
const { focused: tokenFocused } = useFocus(tokenField, { initialValue: true });
// Set before the first await: two clicks in one tick must not both pass the guard.
const busy = ref(false);

const submitButton = useTemplateRef<{ $el: HTMLElement }>("submitButton");
const successAlert = useTemplateRef<{ $el: HTMLElement }>("successAlert");
const failureAlert = useTemplateRef<{ $el: HTMLElement }>("failureAlert");

interface Success {
  message: string;
  published: PublishedCrl;
}
interface Failure {
  message: string;
  reason: string | null;
}
const success = shallowRef<Success | null>(null);
const failure = shallowRef<Failure | null>(null);

const showPemHint = computed(() => !isValid.value && text.value.trim() !== "");

function openToken() {
  tokenOpen.value = true;
  tokenFocused.value = true;
}

/** The result alert takes the focus when the submit button had it (or it was already lost). */
async function focusResult(alert: typeof successAlert) {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== submitButton.value?.$el) {
    return;
  }
  await nextTick();
  alert.value?.$el.focus();
}

async function submit() {
  if (!isValid.value || busy.value) {
    return;
  }
  busy.value = true;
  success.value = null;
  failure.value = null;
  const submitted = input.value;
  const crl =
    typeof submitted === "string"
      ? new File([submitted], "crl.pem", { type: "application/x-pem-file" })
      : submitted;
  try {
    const published = await upload.mutateAsync({ file: crl, token: token.value.trim() });
    // The target's label from the cached list, when that list has it.
    const cached = client.getQueryData(queries.crls().queryKey);
    const target =
      cached?.find((item) => item.targetId === published.target)?.label ??
      t(`upload.kindTarget.${published.kind}`);
    const message = t(`upload.outcome.${published.outcome}`, { target });
    success.value = { message, published };
    if (input.value === submitted) {
      clear();
    }
    void focusResult(successAlert);
  } catch (error) {
    failure.value = { message: errorMessage(error, i18n), reason: errorReason(error, i18n) };
    if (error instanceof ApiError && error.code === "unauthorized") {
      openToken();
    } else {
      void focusResult(failureAlert);
    }
  } finally {
    busy.value = false;
  }
}

function onFileChange(event: Event) {
  const element = event.target as HTMLInputElement;
  const chosen = element.files?.[0];
  // The same file can be chosen again after it was replaced by text.
  element.value = "";
  if (chosen) {
    selectFile(chosen);
  }
}
</script>

<template>
  <Card data-testid="upload-card">
    <CardHeader>
      <CardTitle>
        <h2>{{ t("upload.title") }}</h2>
      </CardTitle>
      <CardDescription>{{ t("upload.description") }}</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-4">
      <Alert
        v-if="success"
        ref="successAlert"
        tabindex="-1"
        class="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="upload-success"
      >
        <CircleCheckIcon class="text-success" />
        <AlertTitle>{{ success.message }}</AlertTitle>
        <AlertDescription class="grid gap-1">
          <span v-if="success.published.crlNumber !== null">
            {{ t("upload.crlNumber", { number: success.published.crlNumber }) }}
            <template v-if="success.published.baseCrlNumber !== null">
              · {{ t("upload.baseCrlNumber", { number: success.published.baseCrlNumber }) }}
            </template>
          </span>
          <span v-if="success.published.downloads.length > 0">{{ t("upload.servedAt") }}</span>
          <ul v-if="success.published.downloads.length > 0" class="grid gap-0.5">
            <li v-for="path in success.published.downloads" :key="path">
              <a :href="path" download class="font-mono text-xs break-all">{{ path }}</a>
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <Alert
        v-if="failure"
        ref="failureAlert"
        variant="destructive"
        tabindex="-1"
        class="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="upload-error"
      >
        <CircleAlertIcon />
        <AlertTitle>{{ t("upload.errors.uploadFailed") }}</AlertTitle>
        <AlertDescription>
          <p>{{ failure.message }}</p>
          <p v-if="failure.reason">{{ t("upload.reason", { reason: failure.reason }) }}</p>
        </AlertDescription>
      </Alert>

      <form class="grid gap-3" @submit.prevent="submit">
        <Label :for="ids.text">{{ t("upload.labels.pemContent") }}</Label>
        <div
          ref="dropZone"
          class="relative rounded-lg"
          :class="{ 'ring-3 ring-ring/50': isOverDropZone }"
          data-testid="drop-zone"
        >
          <Textarea
            :id="ids.text"
            v-model="text"
            rows="8"
            spellcheck="false"
            class="min-h-40 resize-y pb-10 font-mono text-xs"
            :placeholder="t('upload.placeholder')"
          />
          <Button
            as="label"
            variant="outline"
            size="xs"
            class="absolute right-2 bottom-2 cursor-pointer has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <FilePlusIcon data-icon="inline-start" />
            {{ t("upload.selectFile") }}
            <input
              type="file"
              accept=".crl,.pem,.der"
              class="sr-only"
              data-testid="file-input"
              @change="onFileChange"
            />
          </Button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <p v-if="showPemHint" class="text-sm text-destructive" data-testid="pem-hint">
            {{ t("upload.errors.invalidPem") }}
          </p>
          <p v-else class="text-sm text-muted-foreground" data-testid="upload-helper">
            {{ file ? file.name : t("upload.helpers.pem") }}
          </p>
          <Button
            ref="submitButton"
            type="submit"
            :disabled="!isValid"
            :aria-disabled="busy || undefined"
            class="aria-disabled:opacity-50"
            data-testid="upload-submit"
          >
            <LoaderCircleIcon
              v-if="busy"
              data-icon="inline-start"
              class="animate-spin motion-reduce:animate-none"
            />
            <UploadIcon v-else data-icon="inline-start" />
            {{ busy ? t("upload.actions.uploading") : t("upload.actions.upload") }}
          </Button>
        </div>

        <CollapsibleRoot v-model:open="tokenOpen">
          <CollapsibleTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="-ml-2 text-muted-foreground"
              data-testid="token-toggle"
            >
              <ChevronRightIcon
                data-icon="inline-start"
                class="transition-transform"
                :class="{ 'rotate-90': tokenOpen }"
              />
              <KeyRoundIcon />
              {{ t("upload.token.toggle") }}
              <span v-if="token.trim() !== ''" class="text-success">
                ({{ t("upload.token.set") }})
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent class="grid max-w-md gap-2 pt-2">
            <Label :for="ids.token">{{ t("upload.token.label") }}</Label>
            <Input
              :id="ids.token"
              ref="tokenField"
              v-model="token"
              type="password"
              autocomplete="off"
              spellcheck="false"
              data-testid="token-input"
            />
            <p class="text-xs text-muted-foreground">{{ t("upload.token.hint") }}</p>
          </CollapsibleContent>
        </CollapsibleRoot>
      </form>
    </CardContent>
  </Card>
</template>
