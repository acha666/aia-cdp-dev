export const toHex = (input: ArrayBuffer | Uint8Array) =>
  Array.from(input instanceof Uint8Array ? input : new Uint8Array(input), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

export const toUpperHex = (input: ArrayBuffer | Uint8Array) => toHex(input).toUpperCase();

export const toDigestInput = (input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> =>
  input instanceof Uint8Array && input.buffer instanceof ArrayBuffer
    ? (input as Uint8Array<ArrayBuffer>)
    : new Uint8Array(input);

async function digestHex(algorithm: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest(algorithm, toDigestInput(data)));
}

export function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return digestHex("SHA-256", data);
}

export function sha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return digestHex("SHA-1", data);
}
