import { VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { envelope, publishedCrl, stubApi, targetItems, testQueryClient } from "./helpers";
import type { Handler } from "./helpers";
import { queries } from "@/client/queries";
import type { PublishedCrl } from "@/client/types";
import CrlUploadCard from "@/components/overview/CrlUploadCard.vue";
import { uploadToken } from "@/upload-token";
import { createAppI18n } from "@/i18n";

const PEM =
  "-----BEGIN X509 CRL-----\nMIIBszCBnAIBATANBgkqhkiG9w0BAQsFADAA\n-----END X509 CRL-----\n";

afterEach(() => {
  uploadToken.value = "";
});

function render(post: Handler) {
  const api = stubApi({ "POST /api/v1/crls": post });
  const client = testQueryClient();
  client.setQueryData(queries.crls().queryKey, targetItems());
  const card = mount(CrlUploadCard, {
    attachTo: document.body,
    global: { plugins: [createAppI18n("en"), [VueQueryPlugin, { queryClient: client }]] },
  });
  const posts = () =>
    api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init!);
  return { card, posts };
}

const ok = (outcome: PublishedCrl["outcome"]) => () =>
  Response.json(publishedCrl(outcome), { status: outcome === "created" ? 201 : 200 });

async function paste(card: VueWrapper, text: string) {
  await card.get("textarea").setValue(text);
}

async function submit(card: VueWrapper) {
  await card.get("form").trigger("submit");
  await flushPromises();
}

describe("CrlUploadCard", () => {
  it("sends pasted PEM as the request body", async () => {
    const { card, posts } = render(ok("created"));
    await paste(card, PEM);
    await submit(card);

    expect(posts()).toHaveLength(1);
    const { body, headers } = posts()[0]!;
    expect(body).toBeInstanceOf(File);
    expect(await (body as File).text()).toBe(PEM);
    expect(new Headers(headers).get("Content-Type")).toBe("application/octet-stream");
  });

  it("sends a dropped file as it is, the first of several", async () => {
    const { card, posts } = render(ok("updated"));
    const der = new File([new Uint8Array([0x30, 0x82, 0x01])], "full.crl");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [der, new File(["x"], "second.crl")],
        items: [
          { kind: "file", type: "" },
          { kind: "file", type: "" },
        ],
      },
    });
    await flushPromises();
    card.get('[data-testid="drop-zone"]').element.dispatchEvent(drop);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(card.get('[data-testid="upload-helper"]').text()).toBe("full.crl");

    await submit(card);
    expect(posts()[0]!.body).toBe(der);
  });

  it("takes a chosen file and resets the file input", async () => {
    const { card } = render(ok("created"));
    const chosen = new File(["-----BEGIN X509 CRL-----"], "issuing.pem");
    const element = card.get('[data-testid="file-input"]').element as HTMLInputElement;
    expect(element.accept).toBe(".crl,.pem,.der");
    const values: string[] = [];
    Object.defineProperty(element, "files", { value: [chosen] });
    Object.defineProperty(element, "value", {
      get: () => "",
      set: (value: string) => values.push(value),
    });
    element.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(card.get('[data-testid="upload-helper"]').text()).toBe("issuing.pem");
    expect(values).toEqual([""]);
  });

  it.each([
    ["created", "Published to Issuing CA 01: its first CRL."],
    ["updated", "Published to Issuing CA 01: it replaces the previous CRL."],
    ["unchanged", "Issuing CA 01 already serves this CRL; nothing changed."],
  ] as const)("reports %s as a success with the target's label", async (outcome, text) => {
    const { card } = render(ok(outcome));
    await paste(card, PEM);
    await submit(card);

    const alert = card.get('[data-testid="upload-success"]');
    expect(alert.text()).toContain(text);
    expect(alert.text()).toContain("CRL #3");
    expect(alert.findAll("a").map((link) => link.attributes("href"))).toEqual([
      "/crl/ca01.crl",
      "/crl/ca01.crl.pem",
    ]);
    expect(card.find('[data-testid="upload-error"]').exists()).toBe(false);
    expect((card.get("textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it.each([
    [
      "stale_crl",
      () => envelope(409, "stale_crl"),
      ["The CRL is older than the target's current CRL."],
    ],
    [
      "invalid_crl with its reason",
      () => envelope(422, "invalid_crl", { reason: "pem_blocks" }),
      [
        "This is not a valid X.509 CRL.",
        "Reason: the text must contain exactly one complete PEM block",
      ],
    ],
    [
      "a reason it does not know as it is",
      () => envelope(422, "invalid_crl", { reason: "something_new" }),
      ["This is not a valid X.509 CRL.", "Reason: something_new"],
    ],
    [
      "a code of a newer server",
      () => envelope(422, "future_code"),
      ["Unexpected error (future_code)."],
    ],
    [
      "no response",
      () => Promise.reject(new TypeError("Failed to fetch")),
      ["The server could not be reached."],
    ],
  ])("shows %s as an inline error", async (_, answer, [message, ...more]) => {
    const { card } = render(answer);
    await paste(card, PEM);
    await submit(card);

    const alert = card.get('[data-testid="upload-error"]');
    expect(alert.attributes("role")).toBe("alert");
    for (const text of ["Upload failed", message!, ...more]) {
      expect(alert.text()).toContain(text);
    }
    expect((card.get("textarea").element as HTMLTextAreaElement).value).toBe(PEM);
  });

  it("opens and focuses the token field on 401, then sends the token as a bearer header", async () => {
    let calls = 0;
    const { card, posts } = render(() => {
      calls += 1;
      return calls === 1 ? envelope(401, "unauthorized") : ok("created")();
    });
    expect(card.find('[data-testid="token-input"]').exists()).toBe(false);

    await paste(card, PEM);
    await submit(card);
    expect(new Headers(posts()[0]!.headers).has("Authorization")).toBe(false);
    const field = card.get('[data-testid="token-input"]');
    expect(document.activeElement).toBe(field.element);
    expect(card.get('[data-testid="upload-error"]').text()).toContain(
      "The upload token is missing or wrong."
    );

    await field.setValue("  s3cret-token  ");
    await submit(card);
    expect(new Headers(posts()[1]!.headers).get("Authorization")).toBe("Bearer s3cret-token");
    expect(card.find('[data-testid="upload-success"]').exists()).toBe(true);
  });

  it("does not submit again while an upload runs, keeping the button focusable", async () => {
    const pending = Promise.withResolvers<Response>();
    const { card, posts } = render(() => pending.promise);
    await paste(card, PEM);
    const button = card.get('[data-testid="upload-submit"]');
    (button.element as HTMLButtonElement).focus();

    const form = card.get("form");
    await form.trigger("submit");
    await form.trigger("submit");
    await button.trigger("click");
    await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(button.attributes("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button.element);
    expect(button.text()).toBe("Uploading…");

    pending.resolve(ok("created")());
    await flushPromises();
    expect(button.text()).toBe("Upload CRL");
    expect(posts()).toHaveLength(1);
    expect(document.activeElement).toBe(card.get('[data-testid="upload-success"]').element);
  });

  it("hints at invalid PEM only for text that is there", async () => {
    const { card, posts } = render(ok("created"));
    expect(card.find('[data-testid="pem-hint"]').exists()).toBe(false);
    expect(card.get('[data-testid="upload-submit"]').attributes("disabled")).toBeDefined();

    await paste(card, "   \n");
    expect(card.find('[data-testid="pem-hint"]').exists()).toBe(false);
    await paste(card, "not a CRL");
    expect(card.get('[data-testid="pem-hint"]').text()).toBe(
      "Invalid PEM format. Must contain X509 CRL markers."
    );
    await submit(card);
    expect(posts()).toHaveLength(0);
  });
});
