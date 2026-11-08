import { QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/vue-query";
import { markRaw } from "vue";
import type { Certificate } from "pkijs";
import type * as Parsers from "../../core/pki/parsers.ts";
import type { WholeCrl } from "../../core/pki/parsers.ts";
import { api } from "./api";
import { ApiError, unwrap } from "./errors";

const v1 = api.api.v1;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  const final = error instanceof ApiError && error.status >= 400 && error.status < 500;
  return !final && failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 0, retry: shouldRetry } },
  });
}

function blobQuery<T extends object>(
  sha256: string,
  code: "invalid_certificate" | "invalid_crl",
  parse: (parsers: typeof Parsers, der: Uint8Array) => T
) {
  return queryOptions({
    queryKey: ["blob", sha256],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const parsers = import("../../core/pki/parsers.ts");
      const res = await v1.blobs[":sha256"].$get(
        { param: { sha256 } },
        { init: { signal, cache: "default" } }
      );
      if (!res.ok) {
        await unwrap(res);
      }
      const der = new Uint8Array(await res.arrayBuffer());
      try {
        return markRaw(parse(await parsers, der));
      } catch (error) {
        throw new ApiError(422, code, `GET blob ${sha256}`, undefined, { cause: error });
      }
    },
  });
}

export const queries = {
  certificates: () =>
    queryOptions({
      queryKey: ["certificates"],
      queryFn: async ({ signal }) =>
        unwrap(await v1.certificates.$get(undefined, { init: { signal } })),
    }),
  crls: () =>
    queryOptions({
      queryKey: ["crls"],
      queryFn: async ({ signal }) => unwrap(await v1.crls.$get(undefined, { init: { signal } })),
    }),
  certificateBlob: (sha256: string) =>
    blobQuery<Certificate>(sha256, "invalid_certificate", (parsers, der) =>
      parsers.parseCertificate(der)
    ),
  crlBlob: (sha256: string) =>
    blobQuery<WholeCrl>(sha256, "invalid_crl", (parsers, der) => parsers.parseCRL(der)),
};

export interface UploadCrlInput {
  file: File;
  token: string;
}

export function useUploadCrl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, token }: UploadCrlInput) =>
      unwrap(
        await v1.crls.$post(undefined, {
          headers: {
            "Content-Type": "application/octet-stream",
            ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
          },
          init: { body: file },
        })
      ),
    onSuccess: () => {
      void client.cancelQueries().then(() => client.invalidateQueries());
    },
  });
}
