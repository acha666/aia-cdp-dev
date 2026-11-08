/**
 * Display names of OIDs.
 *
 * @packageDocumentation
 */

import {
  CURVE_NAMES,
  HASH_ALG_NAMES,
  KEY_ALG_NAMES,
  SIGNATURE_ALG_NAMES,
} from "../../core/pki/constants.ts";

/** Name attribute types, with the RFC 4514 short names where there are any. */
export const OID_DICTIONARY: Record<string, { short?: string; name: string }> = {
  "2.5.4.3": { short: "CN", name: "commonName" },
  "2.5.4.4": { short: "SN", name: "surname" },
  "2.5.4.5": { short: "serialNumber", name: "serialNumber" },
  "2.5.4.6": { short: "C", name: "countryName" },
  "2.5.4.7": { short: "L", name: "localityName" },
  "2.5.4.8": { short: "ST", name: "stateOrProvinceName" },
  "2.5.4.9": { short: "STREET", name: "streetAddress" },
  "2.5.4.10": { short: "O", name: "organizationName" },
  "2.5.4.11": { short: "OU", name: "organizationalUnitName" },
  "2.5.4.12": { name: "title" },
  "2.5.4.13": { name: "description" },
  "2.5.4.15": { name: "businessCategory" },
  "2.5.4.16": { name: "postalAddress" },
  "2.5.4.17": { name: "postalCode" },
  "2.5.4.18": { name: "postOfficeBox" },
  "2.5.4.20": { name: "telephoneNumber" },
  "2.5.4.41": { name: "name" },
  "2.5.4.42": { short: "GN", name: "givenName" },
  "2.5.4.43": { name: "initials" },
  "2.5.4.44": { name: "generationQualifier" },
  "2.5.4.45": { name: "x500UniqueIdentifier" },
  "2.5.4.46": { name: "dnQualifier" },
  "2.5.4.65": { name: "pseudonym" },
  "2.5.4.97": { name: "organizationIdentifier" },
  "1.2.840.113549.1.9.1": { short: "emailAddress", name: "emailAddress" },
  "1.2.840.113549.1.9.2": { name: "unstructuredName" },
  "1.2.840.113549.1.9.8": { name: "unstructuredAddress" },
  "0.9.2342.19200300.100.1.1": { short: "UID", name: "userId" },
  "0.9.2342.19200300.100.1.25": { short: "DC", name: "domainComponent" },
  "1.3.6.1.4.1.311.60.2.1.1": { name: "jurisdictionLocalityName" },
  "1.3.6.1.4.1.311.60.2.1.2": { name: "jurisdictionStateOrProvinceName" },
  "1.3.6.1.4.1.311.60.2.1.3": { name: "jurisdictionCountryName" },
};

export const MASK_GEN_ALG_NAMES: Record<string, string> = {
  "1.2.840.113549.1.1.8": "MGF1",
};

export const EKU_NAMES: Record<string, string> = {
  "2.5.29.37.0": "anyExtendedKeyUsage",
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.5": "ipsecEndSystem",
  "1.3.6.1.5.5.7.3.6": "ipsecTunnel",
  "1.3.6.1.5.5.7.3.7": "ipsecUser",
  "1.3.6.1.5.5.7.3.8": "timeStamping",
  "1.3.6.1.5.5.7.3.9": "OCSPSigning",
  "1.3.6.1.5.5.7.3.17": "ipsecIKE",
  "1.3.6.1.5.5.8.2.2": "ikeIntermediate",
  "1.3.6.1.4.1.311.10.3.1": "Microsoft Trust List Signing",
  "1.3.6.1.4.1.311.10.3.2": "Microsoft Time Stamping",
  "1.3.6.1.4.1.311.10.3.3": "Microsoft Server Gated Crypto",
  "1.3.6.1.4.1.311.10.3.4": "Encrypting File System",
  "1.3.6.1.4.1.311.10.3.4.1": "File Recovery",
  "1.3.6.1.4.1.311.10.3.11": "Key Recovery",
  "1.3.6.1.4.1.311.10.3.12": "Document Signing",
  "1.3.6.1.4.1.311.10.3.13": "Lifetime Signing",
  "1.3.6.1.4.1.311.10.5.1": "Windows Store",
  "1.3.6.1.4.1.311.20.1": "Certificate Request Agent",
  "1.3.6.1.4.1.311.20.2.2": "Smart Card Logon",
  "1.3.6.1.4.1.311.21.5": "Private Key Archival",
  "1.3.6.1.4.1.311.21.6": "Key Recovery Agent",
  "1.3.6.1.4.1.311.21.19": "Directory Service Email Replication",
  "1.3.6.1.4.1.311.54.1.2": "Remote Desktop Authentication",
  "1.3.6.1.4.1.311.61.1.1": "Kernel Mode Code Signing",
  "1.3.6.1.4.1.311.80.1": "Document Encryption",
  "2.16.840.1.113730.4.1": "Netscape Server Gated Crypto",
};

export const EXTENSION_NAMES: Record<string, string> = {
  "2.5.29.9": "Subject Directory Attributes",
  "2.5.29.14": "Subject Key Identifier",
  "2.5.29.15": "Key Usage",
  "2.5.29.16": "Private Key Usage Period",
  "2.5.29.17": "Subject Alternative Name",
  "2.5.29.18": "Issuer Alternative Name",
  "2.5.29.19": "Basic Constraints",
  "2.5.29.20": "CRL Number",
  "2.5.29.21": "CRL Reason Code",
  "2.5.29.23": "Hold Instruction Code",
  "2.5.29.24": "Invalidity Date",
  "2.5.29.27": "Delta CRL Indicator",
  "2.5.29.28": "Issuing Distribution Point",
  "2.5.29.29": "Certificate Issuer",
  "2.5.29.30": "Name Constraints",
  "2.5.29.31": "CRL Distribution Points",
  "2.5.29.32": "Certificate Policies",
  "2.5.29.33": "Policy Mappings",
  "2.5.29.35": "Authority Key Identifier",
  "2.5.29.36": "Policy Constraints",
  "2.5.29.37": "Extended Key Usage",
  "2.5.29.46": "Freshest CRL",
  "2.5.29.54": "Inhibit anyPolicy",
  "2.5.29.60": "Expired Certificates on CRL",
  "1.3.6.1.5.5.7.1.1": "Authority Information Access",
  "1.3.6.1.5.5.7.1.3": "Qualified Certificate Statements",
  "1.3.6.1.5.5.7.1.11": "Subject Information Access",
  "1.3.6.1.5.5.7.1.12": "Logotype",
  "1.3.6.1.5.5.7.1.24": "TLS Feature",
  "1.3.6.1.5.5.7.48.1.5": "OCSP No Check",
  "1.3.6.1.4.1.11129.2.4.2": "Signed Certificate Timestamp List",
  "1.2.840.113549.1.9.15": "S/MIME Capabilities",
  "2.16.840.1.113730.1.1": "Netscape Certificate Type",
  "2.16.840.1.113730.1.13": "Netscape Comment",
  "1.3.6.1.4.1.311.20.2": "Certificate Template Name",
  "1.3.6.1.4.1.311.21.1": "CA Version",
  "1.3.6.1.4.1.311.21.2": "Previous CA Certificate Hash",
  "1.3.6.1.4.1.311.21.3": "CRL Virtual Base",
  "1.3.6.1.4.1.311.21.4": "Next CRL Publish",
  "1.3.6.1.4.1.311.21.7": "Certificate Template Information",
  "1.3.6.1.4.1.311.21.10": "Application Policies",
  "1.3.6.1.4.1.311.21.11": "Application Policy Mappings",
  "1.3.6.1.4.1.311.21.12": "Application Policy Constraints",
  "1.3.6.1.4.1.311.21.14": "CRL Self CDP",
  "1.3.6.1.4.1.311.25.2": "NTDS CA Security Extension",
  "1.3.6.1.4.1.311.10.9.1": "Cross-Certificate Distribution Points",
};

export const KEY_USAGE_FLAGS = [
  "digitalSignature",
  "nonRepudiation",
  "keyEncipherment",
  "dataEncipherment",
  "keyAgreement",
  "keyCertSign",
  "cRLSign",
  "encipherOnly",
  "decipherOnly",
];

export const REASON_FLAGS = [
  "unused",
  "keyCompromise",
  "cACompromise",
  "affiliationChanged",
  "superseded",
  "cessationOfOperation",
  "certificateHold",
  "privilegeWithdrawn",
  "aACompromise",
];

export const NETSCAPE_CERT_TYPE_FLAGS = [
  "sslClient",
  "sslServer",
  "smime",
  "objectSigning",
  "reserved",
  "sslCA",
  "smimeCA",
  "objectSigningCA",
];

export const CRL_REASON_CODES: Record<number, string> = {
  0: "unspecified",
  1: "keyCompromise",
  2: "cACompromise",
  3: "affiliationChanged",
  4: "superseded",
  5: "cessationOfOperation",
  6: "certificateHold",
  8: "removeFromCRL",
  9: "privilegeWithdrawn",
  10: "aACompromise",
};

export const HOLD_INSTRUCTION_NAMES: Record<string, string> = {
  "1.2.840.10040.2.1": "holdInstructionNone",
  "1.2.840.10040.2.2": "holdInstructionCallIssuer",
  "1.2.840.10040.2.3": "holdInstructionReject",
};

export const ACCESS_METHOD_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.48.1": "ocsp",
  "1.3.6.1.5.5.7.48.2": "caIssuers",
  "1.3.6.1.5.5.7.48.3": "timeStamping",
  "1.3.6.1.5.5.7.48.5": "caRepository",
};

export const POLICY_QUALIFIER_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.2.1": "cps",
  "1.3.6.1.5.5.7.2.2": "userNotice",
};

export const CERTIFICATE_POLICY_NAMES: Record<string, string> = {
  "2.5.29.32.0": "anyPolicy",
  "2.23.140.1.1": "CA/Browser Forum EV",
  "2.23.140.1.2.1": "CA/Browser Forum DV",
  "2.23.140.1.2.2": "CA/Browser Forum OV",
  "2.23.140.1.2.3": "CA/Browser Forum IV",
  "2.23.140.1.3": "CA/Browser Forum EV Code Signing",
  "2.23.140.1.4.1": "CA/Browser Forum Code Signing",
  "2.23.140.1.31": "CA/Browser Forum Onion EV",
  "1.3.6.1.4.1.311.21.10": "Microsoft Application Policies",
};

export const OTHER_NAME_TYPES: Record<string, string> = {
  "1.3.6.1.4.1.311.20.2.3": "userPrincipalName",
  "1.3.6.1.4.1.311.25.1": "ntdsReplication",
  "1.3.6.1.5.2.2": "krb5PrincipalName",
  "1.3.6.1.5.5.7.8.3": "permanentIdentifier",
  "1.3.6.1.5.5.7.8.5": "xmppAddr",
  "1.3.6.1.5.5.7.8.7": "srvName",
  "1.3.6.1.5.5.7.8.9": "smtpUtf8Mailbox",
};

export const TLS_FEATURE_NAMES: Record<number, string> = {
  5: "status_request",
  17: "status_request_v2",
};

export const QC_STATEMENT_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.11.1": "id-qcs-pkixQCSyntax-v1",
  "1.3.6.1.5.5.7.11.2": "id-qcs-pkixQCSyntax-v2",
  "0.4.0.1862.1.1": "QcCompliance",
  "0.4.0.1862.1.2": "QcLimitValue",
  "0.4.0.1862.1.3": "QcRetentionPeriod",
  "0.4.0.1862.1.4": "QcSSCD",
  "0.4.0.1862.1.5": "QcPDS",
  "0.4.0.1862.1.6": "QcType",
};

/** Every name above by OID, for the ASN.1 dump. */
export const KNOWN_OID_NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OID_DICTIONARY).map(([oid, entry]) => [oid, entry.name])),
  ...SIGNATURE_ALG_NAMES,
  ...KEY_ALG_NAMES,
  ...HASH_ALG_NAMES,
  ...MASK_GEN_ALG_NAMES,
  ...EKU_NAMES,
  ...EXTENSION_NAMES,
  ...CURVE_NAMES,
  ...HOLD_INSTRUCTION_NAMES,
  ...ACCESS_METHOD_NAMES,
  ...POLICY_QUALIFIER_NAMES,
  ...CERTIFICATE_POLICY_NAMES,
  ...OTHER_NAME_TYPES,
  ...QC_STATEMENT_NAMES,
  "1.3.6.1.4.1.311.25.2.1": "ntdsObjectSid",
};

/** Looks an OID up in `names`, then among the name attribute types. */
export const oidName = (oid: string, names?: Record<string, string>): string | undefined =>
  names?.[oid] ?? OID_DICTIONARY[oid]?.name;
