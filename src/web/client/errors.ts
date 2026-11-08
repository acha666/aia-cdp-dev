export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ResponseLike = Pick<Response, "ok" | "status" | "text">;

type SuccessBody<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

export async function unwrap<R extends ResponseLike>(res: R): Promise<SuccessBody<R>> {
  const body = await readJson(res);
  if (res.ok) {
    return body as SuccessBody<R>;
  }
  const error = (
    body as { error?: { code?: unknown; message?: unknown; details?: unknown } | null } | null
  )?.error;
  if (typeof error?.code !== "string" || typeof error.message !== "string") {
    throw invalidResponse(res.status);
  }
  throw new ApiError(res.status, error.code, error.message, error.details);
}

export const apiFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw noResponse(error, init?.signal);
  }
};

async function readJson(res: ResponseLike): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw noResponse(error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(res.status);
  }
}

function invalidResponse(status: number): ApiError {
  return new ApiError(status, "invalid_response", "The response is not the API's JSON");
}

function noResponse(error: unknown, signal?: AbortSignal | null): unknown {
  if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
    return error;
  }
  return new ApiError(0, "network", "No response from the server", undefined, { cause: error });
}
