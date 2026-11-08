import { computed, shallowRef } from "vue";

export function useCrlUploadInput() {
  const input = shallowRef<string | File>("");
  const text = computed({
    get: () => (typeof input.value === "string" ? input.value : ""),
    set: (value: string) => {
      input.value = value;
    },
  });
  const file = computed(() => (typeof input.value === "string" ? null : input.value));
  const isValid = computed(() =>
    typeof input.value === "string"
      ? input.value.includes("-----BEGIN X509 CRL-----") &&
        input.value.includes("-----END X509 CRL-----")
      : input.value.size > 0
  );
  const selectFile = (value: File) => {
    input.value = value;
  };
  const clear = () => {
    input.value = "";
  };
  return { input, text, file, isValid, selectFile, clear };
}
