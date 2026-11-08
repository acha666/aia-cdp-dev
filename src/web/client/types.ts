import type { InferResponseType } from "hono/client";
import type { api } from "./api";

type V1 = typeof api.api.v1;

export type CertificateList = InferResponseType<V1["certificates"]["$get"], 200>;
export type CertificateListItem = CertificateList[number];

export type CrlTargetList = InferResponseType<V1["crls"]["$get"], 200>;
export type CrlTargetListItem = CrlTargetList[number];

export type PublishedCrl = InferResponseType<V1["crls"]["$post"], 200 | 201>;
