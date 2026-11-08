import { describe, expect, it } from "vitest";
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";

type Messages = Record<string, unknown>;

const flatten = (messages: Messages, prefix = ""): [string, string][] =>
  Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value]]
      : flatten(value as Messages, `${prefix}${key}.`)
  );

const EN = new Map(flatten(en));
const ZH = new Map(flatten(zhCN));

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("locales", () => {
  it("have the same keys and placeholders in en and zh-CN, none empty", () => {
    expect([...ZH.keys()].sort()).toEqual([...EN.keys()].sort());
    for (const [key, message] of EN) {
      expect(message.trim(), key).not.toBe("");
      expect(ZH.get(key)!.trim(), key).not.toBe("");
      expect(placeholders(ZH.get(key)!), key).toEqual(placeholders(message));
    }
  });

  it("have messages for client failures and unknown codes", () => {
    for (const code of ["network", "invalid_response", "unknown"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`errors.${code}`), code).toBeTruthy();
      }
    }
  });

  it("have a reason message for every details.reason the server sends with an upload failure", () => {
    for (const reason of [...PKI_PARSE_REASONS, "missing_aki"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`upload.reasons.${reason}`), reason).toBeTruthy();
      }
    }
  });
});
