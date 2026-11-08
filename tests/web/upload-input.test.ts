import { assert, test } from "vitest";
import { useCrlUploadInput } from "@/composables/useCrlUploadInput";

test("text replaces a previously selected binary file and a file replaces text", () => {
  const state = useCrlUploadInput();
  const file = new File([new Uint8Array([0x30, 1])], "binary.pem");
  state.selectFile(file);
  assert.equal(state.input.value, file);
  assert.equal(state.isValid.value, true);
  const pem = "-----BEGIN X509 CRL-----\nAA==\n-----END X509 CRL-----";
  state.text.value = pem;
  assert.equal(state.input.value, pem);
  assert.equal(state.file.value, null);
  state.selectFile(file);
  assert.equal(state.text.value, "");
  assert.equal(state.file.value, file);
  state.clear();
  assert.equal(state.isValid.value, false);
});

test("file selection is independent of extension and rejects empty files", () => {
  const state = useCrlUploadInput();
  for (const name of ["crl.pem", "crl.der", "crl.CRL"]) {
    state.selectFile(new File(["bytes"], name));
    assert.equal(state.isValid.value, true);
  }
  state.selectFile(new File([], "empty.crl"));
  assert.equal(state.isValid.value, false);
});
