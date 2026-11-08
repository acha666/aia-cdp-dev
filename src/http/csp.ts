import { secureHeaders } from "hono/secure-headers";

export const securityHeaders = secureHeaders({
  strictTransportSecurity: false,
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'self'"],
    formAction: ["'none'"],
  },
});
