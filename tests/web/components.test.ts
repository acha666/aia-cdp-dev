import { flushPromises, mount } from "@vue/test-utils";
import * as asn1 from "asn1js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import type { Component } from "vue";
import { toast } from "vue-sonner";
import type { PlainExtension } from "../../src/core/pki/extensions.ts";
import { attribute, nameOf } from "../helpers/pki.ts";
import { definitions } from "./helpers";
import DownloadLinks from "@/components/DownloadLinks.vue";
import HexValue from "@/components/HexValue.vue";
import LocaleSelect from "@/components/LocaleSelect.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Accordion } from "@/components/ui/accordion";
import ValueView from "@/components/ValueView.vue";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import ExtensionView from "@/components/x509/ExtensionView.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";
import { describeExtension } from "@/x509/extensions";
import type { ExtensionDisplay } from "@/x509/extensions";

afterEach(() => Reflect.deleteProperty(document, "execCommand"));

function render(component: Component, props: Record<string, unknown>, locale: AppLocale = "en") {
  return mount(component, { props, global: { plugins: [createAppI18n(locale)] } });
}

describe("DownloadLinks", () => {
  it("labels DER paths and .pem paths, keeping nested paths as the server sent them", () => {
    const links = render(DownloadLinks, {
      downloads: ["/ca/nested/root.crt", "/ca/nested/root.crt.pem"],
    }).findAll("a");
    expect(links.map((link) => [link.attributes("href"), link.attributes("data-format")])).toEqual([
      ["/ca/nested/root.crt", "DER"],
      ["/ca/nested/root.crt.pem", "PEM"],
    ]);
    expect(links.every((link) => link.attributes("download") !== undefined)).toBe(true);
    expect(links[1]!.text()).toBe("PEM: /ca/nested/root.crt.pem");
  });

  it("names the files when a resource is served at more than one DER path", () => {
    const links = render(DownloadLinks, {
      downloads: ["/ca/root.crt", "/ca/root.crt.pem", "/ca/legacy/root-2016.cer"],
    }).findAll("a");
    expect(links.map((link) => link.get('[data-testid="file-name"]').text())).toEqual([
      "root.crt",
      "root.crt.pem",
      "root-2016.cer",
    ]);
    expect(links[2]!.attributes("data-format")).toBe("DER");
  });

  it("shows a dash without downloads", () => {
    const links = render(DownloadLinks, { downloads: [] });
    expect(links.find("a").exists()).toBe(false);
    expect(links.text()).toBe("—");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["valid", "Valid"],
    ["expiring", "Expiring"],
    ["not-yet-valid", "Not Yet Valid"],
    ["current", "Current"],
    ["stale", "Stale"],
    ["expired", "Expired"],
    ["unknown", "Unknown"],
    ["unpublished", "Not published"],
  ])("labels %s", (state, label) => {
    const badge = render(StatusBadge, { state });
    expect(badge.text()).toBe(label);
    expect(badge.attributes("data-state")).toBe(state);
  });
});

describe("HexValue", () => {
  it("groups bytes without spaces and copies the bare digits with the Clipboard API", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    const hex = render(HexValue, { value: "0a1b2c" });
    expect(hex.get('[data-testid="hex-value"]').element.textContent).toBe("0A:1B:2C");
    const button = hex.get("button");
    expect(button.attributes("aria-label")).toBe("Copy");
    await button.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("0A1B2C");
    expect(execCommand).not.toHaveBeenCalled();
    expect(button.attributes("aria-label")).toBe("Copied");
  });

  it("falls back to a selected textarea where the Clipboard API refuses, keeping the focus", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
    const copied: string[] = [];
    document.execCommand = vi.fn((command: string) => {
      const area = document.activeElement;
      copied.push(`${command}:${area instanceof HTMLTextAreaElement ? area.value : ""}`);
      return true;
    });

    const hex = mount(HexValue, {
      props: { value: "0a1b" },
      attachTo: document.body,
      global: { plugins: [createAppI18n("en")] },
    });
    const button = hex.get("button");
    (button.element as HTMLButtonElement).focus();
    await button.trigger("click");
    await flushPromises();
    expect(copied).toEqual(["copy:0A1B"]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button.element);
    expect(button.attributes("aria-label")).toBe("Copied");
  });

  it("reports a copy that execCommand refuses as a toast, not as copied", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const execCommand = vi.fn(() => false);
    document.execCommand = execCommand;
    const error = vi.spyOn(toast, "error");

    const hex = render(HexValue, { value: "0A1B" }, "zh-CN");
    const button = hex.get("button");
    await button.trigger("click");
    await flushPromises();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(error).toHaveBeenCalledWith("无法复制到剪贴板");
    expect(button.attributes("aria-label")).toBe("复制");
  });
});

describe("ValueView", () => {
  it.each([null, "", { hex: "" }, { lines: [] }, { tags: [] }])("reads (empty) for %j", (value) => {
    expect(render(ValueView, { value }).text()).toBe("(empty)");
  });

  it("gives each line or tag a list item", () => {
    const lines = render(ValueView, { value: { lines: ["URI: http://a.test/", "DNS: b.test"] } });
    expect(lines.findAll("li").map((item) => item.text())).toEqual([
      "URI: http://a.test/",
      "DNS: b.test",
    ]);
    expect(render(ValueView, { value: { tags: ["a", "b"] } }).findAll("li")).toHaveLength(2);
  });
});

describe("LocaleSelect", () => {
  it("switches the global locale between the two UI languages", async () => {
    const locale = render(LocaleSelect, {});
    const select = locale.get("select");
    expect(
      locale.findAll("option").map((option) => [option.attributes("value"), option.text()])
    ).toEqual([
      ["en", "English"],
      ["zh-CN", "简体中文"],
    ]);
    expect(locale.text()).toContain("Language");
    await select.setValue("zh-CN");
    expect(locale.text()).toContain("语言");
    expect((select.element as HTMLSelectElement).value).toBe("zh-CN");
  });
});

describe("NameDetails", () => {
  const name = nameOf(
    [attribute("0.9.2342.19200300.100.1.25", new asn1.IA5String({ value: "test" }))],
    [attribute("1.2.3.4", new asn1.Boolean({ value: true }))],
    [attribute("2.5.4.6", new asn1.PrintableString({ value: "US" }))],
    [attribute("2.5.4.10", new asn1.Utf8String({ value: " " }))],
    [attribute("2.5.4.3", new asn1.Utf8String({ value: " <script>bad</script> " }))]
  );

  it("keeps the labels of empty fields", () => {
    const details = render(NameDetails, { title: "Issuer", name });
    expect(definitions(details)).toEqual([
      ["Common Name", "<script>bad</script>"],
      ["Organization", "(empty)"],
      ["Organizational Unit", "(empty)"],
      ["Country Name", "US"],
      ["State/Province", "(empty)"],
      ["Locality", "(empty)"],
      ["domainComponent", "test"],
      ["1.2.3.4", "#0101FF"],
    ]);
    expect(details.findAll("dt")[6]!.attributes("title")).toBe("ia5String");
    expect(details.text()).toContain(
      "CN=\\ \\<script\\>bad\\</script\\>\\ ,O=\\ ,C=US,1.2.3.4=#0101ff,DC=test"
    );
  });
});

function extension(extnID: string, critical: boolean): PlainExtension {
  return { extnID, critical, value: Uint8Array.of(0x0c, 0x01, 0x41) };
}

describe("ExtensionList", () => {
  it("puts critical extensions first, then sorts by name (or OID), without reordering its input", () => {
    const items = [
      extension("2.5.29.14", false),
      extension("2.5.29.15", true),
      extension("1.2.5", false),
      extension("2.5.29.19", true),
    ];
    const list = render(ExtensionList, { extensions: items });
    expect(list.findAll("[data-oid]").map((item) => item.attributes("data-oid"))).toEqual([
      "2.5.29.19",
      "2.5.29.15",
      "1.2.5",
      "2.5.29.14",
    ]);
    expect(items.map((item) => item.extnID)).toEqual([
      "2.5.29.14",
      "2.5.29.15",
      "1.2.5",
      "2.5.29.19",
    ]);
    expect(list.findAll('[data-testid="critical"]')).toHaveLength(2);
  });
});

describe("ExtensionView", () => {
  function renderOpen(value: ExtensionDisplay, locale: AppLocale = "en") {
    return mount(Accordion, {
      props: { type: "multiple", defaultValue: [value.oid] },
      slots: { default: () => h(ExtensionView, { extension: value, value: value.oid }) },
      global: { plugins: [createAppI18n(locale)] },
    });
  }

  it("shows the parse error, the ASN.1 dump and the raw hex of an undecoded extension", async () => {
    const view = renderOpen({
      oid: "1.3.6.1.4.1.32473.1",
      name: undefined,
      critical: true,
      hex: "0C03616263",
      status: "error",
      error: "Unexpected value",
      asn1: [
        { depth: 0, tag: "SEQUENCE", length: 5 },
        { depth: 1, tag: "UTF8String", length: 3, value: "abc" },
      ],
    });
    expect(view.get("button").text()).toContain("1.3.6.1.4.1.32473.1");
    expect(view.get('[data-testid="critical"]').text()).toBe("Critical");
    expect(view.get('[data-testid="parse-status"]').text()).toBe("Decode error");
    expect(view.get('[data-testid="parse-error"]').text()).toBe("Error: Unexpected value");
    expect(view.findAll("ol > li").map((line) => line.element.textContent)).toEqual([
      "SEQUENCE (5)",
      "  UTF8String (3) abc",
    ]);
    expect(view.find('[data-testid="hex-value"]').exists()).toBe(false);
    const rawHex = view.findAll("button").find((button) => button.text() === "Raw value (hex)");
    expect(rawHex).toBeDefined();
    await rawHex!.trigger("click");
    expect(view.get('[data-testid="hex-value"]').element.textContent).toBe("0C:03:61:62:63");
  });

  const decoded = (oid: string, value: asn1.BaseBlock, locale: AppLocale = "en") =>
    describeExtension(
      { extnID: oid, critical: false, value: new Uint8Array(value.toBER()) },
      createAppI18n(locale).global
    );

  it("renders the sections of a decoded extension without dump or raw value", () => {
    const view = renderOpen(
      decoded("1.3.6.1.4.1.311.21.1", new asn1.Integer({ value: 1 }), "zh-CN"),
      "zh-CN"
    );
    const header = view.get("button").text();
    expect(header).toContain("CA Version");
    expect(header).toContain("1.3.6.1.4.1.311.21.1");
    expect(view.find('[data-testid="parse-status"]').exists()).toBe(false);
    expect(view.find('[data-testid="critical"]').exists()).toBe(false);
    expect(definitions(view)).toEqual([
      ["CA 证书索引", "1"],
      ["CA 密钥索引", "0"],
    ]);
  });

  it("draws one list per section, a hex value with HexValue, and (empty) without sections", () => {
    const point = (uri: string) =>
      new asn1.Sequence({
        value: [
          new asn1.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 },
            value: [
              new asn1.Constructed({
                idBlock: { tagClass: 3, tagNumber: 0 },
                value: [
                  new asn1.Primitive({
                    idBlock: { tagClass: 3, tagNumber: 6 },
                    valueHex: new TextEncoder().encode(uri).buffer,
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    const freshest = renderOpen(
      decoded(
        "2.5.29.46",
        new asn1.Sequence({ value: [point("http://a.test/a.crl"), point("http://b.test/b.crl")] })
      )
    );
    expect(freshest.findAll("dl")).toHaveLength(2);

    const ski = renderOpen(
      decoded("2.5.29.14", new asn1.OctetString({ valueHex: Uint8Array.of(0xab, 0x12).buffer }))
    );
    expect(ski.get('dd [data-testid="hex-value"]').element.textContent).toBe("AB:12");
    expect(renderOpen(decoded("2.5.29.30", new asn1.Sequence())).text()).toContain("(empty)");
  });

  it("names the access methods in the UI language, else by their OID", () => {
    const access = (method: string, uri: string) =>
      new asn1.Sequence({
        value: [
          new asn1.ObjectIdentifier({ value: method }),
          new asn1.Primitive({
            idBlock: { tagClass: 3, tagNumber: 6 },
            valueHex: new TextEncoder().encode(uri).buffer,
          }),
        ],
      });
    const view = renderOpen(
      decoded(
        "1.3.6.1.5.5.7.1.1",
        new asn1.Sequence({
          value: [
            access("1.3.6.1.5.5.7.48.2", "http://a.test/ca.crt"),
            access("1.3.6.1.4.1.32473.5", "http://a.test/x"),
          ],
        }),
        "zh-CN"
      ),
      "zh-CN"
    );
    expect(view.findAll("dt").map((term) => term.text())).toEqual([
      "CA 签发者",
      "1.3.6.1.4.1.32473.5",
    ]);
  });

  it("marks an extension without a decoder as such, with its raw value", () => {
    const view = renderOpen(decoded("1.3.6.1.4.1.32473.3", new asn1.Utf8String({ value: "A" })));
    expect(view.get('[data-testid="parse-status"]').text()).toBe("Not decoded");
    expect(view.findAll("button").some((button) => button.text() === "Raw value (hex)")).toBe(true);
  });
});
