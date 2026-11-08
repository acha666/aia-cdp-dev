import { secureHeaders } from "hono/secure-headers";

/**
 * Security headers for every response. HSTS is left to the TLS terminator in front of the
 * service, since the downloads must also work over plain HTTP. `style-src 'self'` suffices
 * because the UI libraries set styles through the CSSOM, which CSP does not govern.
 */
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
