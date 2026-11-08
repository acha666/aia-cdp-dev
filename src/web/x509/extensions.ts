import { Integer } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import { integerNumber, readStrictTime, stringOf } from "../../core/pki/asn1.ts";
import {
  BIT_STRING,
  ENUMERATED,
  GENERALIZED_TIME,
  IA5_STRING,
  INTEGER,
  NULL,
  OBJECT_IDENTIFIER,
  OCTET_STRING,
  SEQUENCE,
  DerReader,
  asUniversal,
  context,
  contents,
  expectTag,
  explicit,
  hasTag,
  readAscii,
  readBigInt,
  readBits,
  readBoolean,
  readInteger,
  readOid,
  readOne,
  sequenceOf,
} from "../../core/pki/der.ts";
import { messageOf } from "../../core/pki/errors.ts";
import { readAuthorityKeyId, readSubjectKeyId } from "../../core/pki/extensions.ts";
import type { PlainExtension } from "../../core/pki/extensions.ts";
import { toUpperHex } from "../../core/digest.ts";
import type { I18nText } from "@/i18n";
import type en from "@/locales/en.json";
import { formatDate } from "@/utils/dates";
import { rowOf, rows } from "@/utils/values";
import type { Row, Value } from "@/utils/values";
import { blockHex, displayText, dumpAsn1 } from "./asn1-dump";
import type { Asn1Line } from "./asn1-dump";
import {
  formatAttributes,
  formatGeneralName,
  formatGeneralNames,
  readOtherNameParts,
  readRelativeName,
} from "./names";
import {
  ACCESS_METHOD_NAMES,
  CERTIFICATE_POLICY_NAMES,
  CRL_REASON_CODES,
  EKU_NAMES,
  EXTENSION_NAMES,
  HOLD_INSTRUCTION_NAMES,
  KEY_USAGE_FLAGS,
  NETSCAPE_CERT_TYPE_FLAGS,
  POLICY_QUALIFIER_NAMES,
  QC_STATEMENT_NAMES,
  REASON_FLAGS,
  TLS_FEATURE_NAMES,
  oidName,
} from "./oid-names";

export type Section = Row[];

export type FieldKey = keyof typeof en.extension.fields;

export interface ExtensionDisplay {
  oid: string;
  name: string | undefined;
  critical: boolean;
  hex: string;
  sections?: Section[];
  status: "parsed" | "unsupported" | "error";
  error?: string;
  asn1?: Asn1Line[];
}

interface Context {
  i18n: I18nText;
  row: (key: FieldKey, value: Row["value"]) => Row;
  time: (block: BaseBlock | undefined) => string;
  yes: string;
}

const field = (key: FieldKey, i18n: I18nText) => i18n.t(`extension.fields.${key}`);

function oidText(oid: string, names?: Record<string, string>): string {
  const name = oidName(oid, names);
  return name ? `${name} (${oid})` : oid;
}

function readText(block: BaseBlock): string {
  const text = stringOf(block);
  if (text === undefined) {
    throw new Error("Expected an ASN.1 string");
  }
  return text;
}

const lines = (list: readonly string[]): Value => ({ lines: list });

const readReasons = (block: BaseBlock) => readBits(block, REASON_FLAGS);

function pointNameRows(name: BaseBlock | undefined, reasons: string[] | undefined, ctx: Context) {
  const { row, i18n } = ctx;
  const choice = name && explicit(name, context(0));
  let nameRow: Row | false = false;
  if (choice && hasTag(choice, context(0))) {
    nameRow = row("fullName", lines(formatGeneralNames(choice, i18n, context(0))));
  } else if (choice && hasTag(choice, context(1))) {
    nameRow = row("nameRelativeToCRLIssuer", lines([formatAttributes(readRelativeName(choice))]));
  } else if (choice) {
    throw new Error("Invalid DistributionPointName");
  }
  return rows(nameRow, reasons !== undefined && row("reasons", { tags: reasons }));
}

function distributionPoint(block: BaseBlock, ctx: Context): Section {
  const point = new DerReader(block);
  const name = point.optional(context(0));
  const reasons = point.optional(context(1), readReasons);
  const issuer = point.optional(context(2), (names) =>
    formatGeneralNames(names, ctx.i18n, context(2))
  );
  return [
    ...pointNameRows(name, reasons, ctx),
    ...rows(issuer !== undefined && ctx.row("crlIssuer", lines(issuer))),
  ];
}

const distributionPoints = (root: BaseBlock, ctx: Context) =>
  sequenceOf(root).map((block) => distributionPoint(block, ctx));

function accessDescriptions(root: BaseBlock, ctx: Context): Section[] {
  const { i18n } = ctx;
  return [
    sequenceOf(root).map((block) => {
      const access = new DerReader(block);
      const oid = readOid(access.read(OBJECT_IDENTIFIER));
      const name = oidName(oid, ACCESS_METHOD_NAMES);
      const key = `extension.accessMethod.${name ?? ""}`;
      return {
        label: name !== undefined && i18n.te(key) ? i18n.t(key) : (name ?? oid),
        value: lines([formatGeneralName(access.any(), i18n)]),
      };
    }),
  ];
}

function subtree(block: BaseBlock, ctx: Context): string {
  const reader = new DerReader(block);
  const base = formatGeneralName(reader.any(), ctx.i18n);
  const minimum = reader.optional(context(0), readInteger) ?? 0;
  const maximum = reader.optional(context(1), readInteger);
  if (minimum === 0 && maximum === undefined) {
    return base;
  }
  return `${base} [${String(minimum)}${maximum === undefined ? "" : `–${String(maximum)}`}]`;
}

const CPS_QUALIFIER = "1.3.6.1.5.5.7.2.1";
const USER_NOTICE_QUALIFIER = "1.3.6.1.5.5.7.2.2";

function userNotice(block: BaseBlock): string {
  const notice = new DerReader(block);
  const reference = notice.optional(SEQUENCE);
  const explicitText = notice.optional();
  const text = explicitText && readText(explicitText);
  let organization = "";
  if (reference) {
    const ref = new DerReader(reference);
    organization = readText(ref.any());
    const numbers = sequenceOf(ref.read(SEQUENCE), SEQUENCE, 0).map((number) =>
      readBigInt(expectTag(number, INTEGER)).toString()
    );
    organization += numbers.length ? ` (${numbers.join(", ")})` : "";
  }
  return [organization, text].filter(Boolean).join("\n");
}

function qualifierRow(info: pkijs.PolicyQualifierInfo, i18n: I18nText): Row {
  const qualifier: unknown = info.qualifier;
  if (!(qualifier instanceof Object) || !("idBlock" in qualifier)) {
    throw new Error("Missing policy qualifier");
  }
  const block = qualifier as BaseBlock;
  try {
    if (info.policyQualifierId === CPS_QUALIFIER) {
      return { label: field("cps", i18n), value: lines([readText(block)]) };
    }
    if (info.policyQualifierId === USER_NOTICE_QUALIFIER) {
      return { label: field("userNotice", i18n), value: userNotice(block) };
    }
  } catch {}
  const id = info.policyQualifierId;
  return { label: oidName(id, POLICY_QUALIFIER_NAMES) ?? id, value: { hex: blockHex(block) } };
}

function policies(root: BaseBlock, ctx: Context, names = CERTIFICATE_POLICY_NAMES): Section[] {
  const { i18n } = ctx;
  return new pkijs.CertificatePolicies({ schema: root }).certificatePolicies.map((policy) => [
    { label: field("policy", i18n), value: oidText(policy.policyIdentifier, names) },
    ...(policy.policyQualifiers ?? []).map((info) => qualifierRow(info, i18n)),
  ]);
}

const lengthAt = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

function checkSctFraming(list: Uint8Array): void {
  let at = 2;
  while (at < list.length) {
    at += 2 + lengthAt(list, at);
  }
  if (list.length <= 2 || lengthAt(list, 0) !== list.length - 2 || at !== list.length) {
    throw new Error("Invalid SCT list");
  }
}

function sctSection(sct: pkijs.SignedCertificateTimestamp, ctx: Context): Section {
  const { row, i18n } = ctx;
  const version: unknown = sct.version;
  if (typeof version !== "number" || sct.logID.byteLength !== 32 || !sct.signature.byteLength) {
    throw new Error("Invalid SCT");
  }
  return [
    row("logId", { hex: toUpperHex(sct.logID) }),
    row("timestamp", formatDate(sct.timestamp.toISOString(), i18n)),
    row("signatureAlgorithm", `${sct.hashAlgorithm}/${sct.signatureAlgorithm}`),
  ];
}

type Decoder = (value: BaseBlock, ctx: Context) => Section[] | undefined;

const one = (row: Row | false) => [rows(row)];

const DECODERS: Record<string, Decoder | undefined> = {
  "2.5.29.9": (value) => [
    new pkijs.SubjectDirectoryAttributes({ schema: value }).attributes.map((attribute) => ({
      label: oidText(attribute.type),
      value: attribute.values.map(displayText).join("; "),
    })),
  ],

  "2.5.29.14": (value, { row }) => one(row("keyId", { hex: toUpperHex(readSubjectKeyId(value)) })),

  "2.5.29.15": (value, { row }) => {
    const bits = expectTag(value, BIT_STRING);
    const usages = readBits(bits, KEY_USAGE_FLAGS);
    return contents(bits).length === 1 ? undefined : one(row("usages", { tags: usages }));
  },

  "2.5.29.16": (value, { row, time }) => {
    const period = new DerReader(value);
    const generalized = (block: BaseBlock) => asUniversal(block, GENERALIZED_TIME);
    const notBefore = period.optional(context(0), generalized);
    const notAfter = period.optional(context(1), generalized);
    return [[row("notBefore", time(notBefore)), row("notAfter", time(notAfter))]];
  },

  "2.5.29.17": (value, { row, i18n }) => one(row("names", lines(formatGeneralNames(value, i18n)))),
  "2.5.29.18": (value, { row, i18n }) => one(row("names", lines(formatGeneralNames(value, i18n)))),

  "2.5.29.19": (value, { row, yes, i18n }) => {
    const { cA, pathLenConstraint } = new pkijs.BasicConstraints({ schema: value });
    const pathLength =
      pathLenConstraint instanceof Integer ? integerNumber(pathLenConstraint) : pathLenConstraint;
    return [
      rows(
        row("ca", cA ? yes : i18n.t("common.no")),
        pathLength !== undefined && row("pathLength", String(pathLength))
      ),
    ];
  },

  "2.5.29.20": (value, { row }) =>
    one(row("crlNumber", readBigInt(expectTag(value, INTEGER)).toString())),

  "2.5.29.21": (value, { row }) => {
    const code = readInteger(expectTag(value, ENUMERATED));
    return one(row("reason", `${reasonName(code)} (${String(code)})`));
  },

  "2.5.29.23": (value, { row }) =>
    one(
      row(
        "holdInstruction",
        oidText(readOid(expectTag(value, OBJECT_IDENTIFIER)), HOLD_INSTRUCTION_NAMES)
      )
    ),

  "2.5.29.24": (value, { row, time }) =>
    one(row("invalidityDate", time(expectTag(value, GENERALIZED_TIME)))),

  "2.5.29.27": (value, { row }) =>
    one(row("baseCrlNumber", readBigInt(expectTag(value, INTEGER)).toString())),

  "2.5.29.28": (value, ctx) => {
    const idp = new DerReader(value);
    const flag = (num: number) => idp.optional(context(num), readBoolean) ?? false;
    const name = idp.optional(context(0));
    const onlyContainsUserCerts = flag(1);
    const onlyContainsCACerts = flag(2);
    const reasons = idp.optional(context(3), readReasons);
    const indirectCRL = flag(4);
    const onlyContainsAttributeCerts = flag(5);
    const flags = {
      onlyContainsUserCerts,
      onlyContainsCACerts,
      onlyContainsAttributeCerts,
      indirectCRL,
    };
    return [
      [
        ...pointNameRows(name, reasons, ctx),
        ...Object.entries(flags)
          .filter(([, set]) => set)
          .map(([key]) => ctx.row(key as FieldKey, ctx.yes)),
      ],
    ];
  },

  "2.5.29.29": (value, { row, i18n }) => one(row("names", lines(formatGeneralNames(value, i18n)))),

  "2.5.29.30": (value, ctx) => {
    const constraints = new DerReader(value);
    const permitted = constraints.optional(context(0));
    const excluded = constraints.optional(context(1));
    const subtrees = (block: BaseBlock, tag: number) =>
      lines(sequenceOf(block, context(tag)).map((each) => subtree(each, ctx)));
    return [
      rows(
        permitted !== undefined && ctx.row("permittedSubtrees", subtrees(permitted, 0)),
        excluded !== undefined && ctx.row("excludedSubtrees", subtrees(excluded, 1))
      ),
    ];
  },

  "2.5.29.31": distributionPoints,
  "2.5.29.46": distributionPoints,

  "2.5.29.32": (value, ctx) => policies(value, ctx),

  "2.5.29.33": (value) => [
    new pkijs.PolicyMappings({ schema: value }).mappings.map((mapping) => ({
      label: oidText(mapping.issuerDomainPolicy, CERTIFICATE_POLICY_NAMES),
      value: oidText(mapping.subjectDomainPolicy, CERTIFICATE_POLICY_NAMES),
    })),
  ],

  "2.5.29.35": (value, { row, i18n }) => {
    const { keyIdentifier, names, serial } = readAuthorityKeyId(value);
    return [
      rows(
        keyIdentifier !== undefined && row("keyId", { hex: toUpperHex(keyIdentifier) }),
        names !== undefined &&
          row("authorityCertIssuer", lines(names.map((name) => formatGeneralName(name, i18n)))),
        serial !== undefined && row("authorityCertSerialNumber", { hex: toUpperHex(serial) })
      ),
    ];
  },

  "2.5.29.36": (value, { row }) => {
    const constraints = new DerReader(value);
    const requireExplicitPolicy = constraints.optional(context(0), readInteger);
    const inhibitPolicyMapping = constraints.optional(context(1), readInteger);
    return [
      rows(
        requireExplicitPolicy !== undefined &&
          row("requireExplicitPolicy", String(requireExplicitPolicy)),
        inhibitPolicyMapping !== undefined &&
          row("inhibitPolicyMapping", String(inhibitPolicyMapping))
      ),
    ];
  },

  "2.5.29.37": (value, { row }) =>
    one(
      row("purposes", {
        tags: new pkijs.ExtKeyUsage({ schema: value }).keyPurposes.map(
          (oid) => oidName(oid, EKU_NAMES) ?? oid
        ),
      })
    ),

  "2.5.29.54": (value, { row }) =>
    one(row("skipCerts", String(readInteger(expectTag(value, INTEGER))))),

  "2.5.29.60": (value, { row, time }) =>
    one(row("expiredCertsOnCRL", time(expectTag(value, GENERALIZED_TIME)))),

  "1.3.6.1.5.5.7.1.1": accessDescriptions,
  "1.3.6.1.5.5.7.1.11": accessDescriptions,

  "1.3.6.1.5.5.7.1.3": (value) => [
    sequenceOf(value, SEQUENCE, 0).map((block) => {
      const statement = new pkijs.QCStatement({ schema: block });
      const info: unknown = statement.type;
      return {
        label: oidText(statement.id, QC_STATEMENT_NAMES),
        value: {
          hex: info instanceof Object && "idBlock" in info ? blockHex(info as BaseBlock) : "",
        },
      };
    }),
  ],

  "1.3.6.1.5.5.7.1.24": (value, { row }) =>
    one(
      row("features", {
        tags: sequenceOf(value, SEQUENCE, 0).map((block) => {
          const code = readInteger(expectTag(block, INTEGER));
          return TLS_FEATURE_NAMES[code] ?? String(code);
        }),
      })
    ),

  "1.3.6.1.5.5.7.48.1.5": (value, { row, yes }) => {
    if (contents(expectTag(value, NULL)).length > 0) {
      throw new Error("Invalid NULL");
    }
    return one(row("ocspNoCheck", yes));
  },

  "1.3.6.1.4.1.11129.2.4.2": (value, ctx) => {
    const list = expectTag(value, OCTET_STRING);
    checkSctFraming(contents(list));
    return new pkijs.SignedCertificateTimestampList({ schema: list }).timestamps.map((sct) =>
      sctSection(sct, ctx)
    );
  },

  "2.16.840.1.113730.1.1": (value, { row }) =>
    one(
      row("certTypes", { tags: readBits(expectTag(value, BIT_STRING), NETSCAPE_CERT_TYPE_FLAGS) })
    ),
  "2.16.840.1.113730.1.13": (value, { row }) =>
    one(row("comment", readAscii(expectTag(value, IA5_STRING)))),

  "1.3.6.1.4.1.311.20.2": (value, { row }) => one(row("templateName", readText(value))),

  "1.3.6.1.4.1.311.21.1": (value, { row }) => {
    const version = readInteger(expectTag(value, INTEGER));
    if (version < 0 || version > 0xffffffff) {
      throw new Error("Invalid CA version");
    }
    return [
      [
        row("certificateIndex", String(version % 0x10000)),
        row("keyIndex", String(Math.floor(version / 0x10000))),
      ],
    ];
  },

  "1.3.6.1.4.1.311.21.2": (value, { row }) =>
    one(
      row("previousCaCertificateHash", {
        hex: toUpperHex(contents(expectTag(value, OCTET_STRING))),
      })
    ),

  "1.3.6.1.4.1.311.21.3": (value, { row }) =>
    one(row("virtualBaseCrlNumber", readBigInt(expectTag(value, INTEGER)).toString())),

  "1.3.6.1.4.1.311.21.4": (value, { row, time }) => one(row("nextCrlPublish", time(value))),

  "1.3.6.1.4.1.311.21.7": (value, { row }) => {
    const template = new DerReader(value);
    const templateId = readOid(template.read(OBJECT_IDENTIFIER));
    const major = template.optional(INTEGER, readInteger) ?? 0;
    const minor = template.optional(INTEGER, readInteger) ?? 0;
    return [
      [
        row("templateId", oidText(templateId)),
        row("templateVersion", `${String(major)}.${String(minor)}`),
      ],
    ];
  },

  "1.3.6.1.4.1.311.21.10": (value, ctx) => policies(value, ctx, EKU_NAMES),

  "1.3.6.1.4.1.311.21.14": distributionPoints,

  "1.3.6.1.4.1.311.25.2": (value, { row }) => {
    const sequence = new DerReader(value);
    const { inner } = readOtherNameParts(sequence.read(context(0)));
    return one(row("sid", readAscii(expectTag(inner, OCTET_STRING))));
  },
};

const reasonName = (code: number) => CRL_REASON_CODES[code] ?? `reason_${String(code)}`;

function contextOf(i18n: I18nText): Context {
  return {
    i18n,
    row: rowOf<FieldKey>(i18n, "extension.fields"),
    time: (block) => formatDate(block && readStrictTime(block).date.toISOString(), i18n),
    yes: i18n.t("common.yes"),
  };
}

export function describeExtension(extension: PlainExtension, i18n: I18nText): ExtensionDisplay {
  const { extnID: oid, critical, value } = extension;
  const display: ExtensionDisplay = {
    oid,
    name: EXTENSION_NAMES[oid],
    critical,
    hex: toUpperHex(value),
    status: "unsupported",
  };
  try {
    const sections = DECODERS[oid]?.(readOne(value), contextOf(i18n));
    if (sections) {
      return { ...display, status: "parsed", sections: sections.filter((s) => s.length > 0) };
    }
  } catch (error) {
    display.status = "error";
    display.error = messageOf(error);
  }
  return { ...display, asn1: dumpAsn1(value) };
}

export interface EntryColumns {
  reason: string | null;
  invalidityDate: string | null;
}

export function entryColumns(extensions: readonly PlainExtension[], i18n: I18nText): EntryColumns {
  const columns: EntryColumns = { reason: null, invalidityDate: null };
  for (const { extnID, value } of extensions) {
    try {
      const block = readOne(value);
      if (extnID === "2.5.29.21") {
        columns.reason = reasonName(readInteger(expectTag(block, ENUMERATED)));
      } else if (extnID === "2.5.29.24") {
        columns.invalidityDate = contextOf(i18n).time(expectTag(block, GENERALIZED_TIME));
      }
    } catch {}
  }
  return columns;
}
