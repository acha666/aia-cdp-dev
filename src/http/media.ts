import { createMiddleware } from "hono/factory";
import { ApiError } from "./errors.ts";

function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "" ? undefined : type;
}

export function mediaTypeGate(accepted: readonly string[], message: string) {
  return createMiddleware(async (c, next) => {
    const type = mediaType(c.req.header("Content-Type"));
    if (type === undefined || !accepted.includes(type)) {
      throw new ApiError(415, "unsupported_media_type", message, {
        received: type ?? null,
        accepted,
      });
    }
    await next();
  });
}
