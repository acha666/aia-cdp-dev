# aia-cdp

Publishes the CA certificates and CRLs of a private PKI over HTTP, at the URLs that issued
certificates name in their Authority Information Access (AIA) and CRL Distribution Points
(CDP) extensions.

- CRLs are uploaded by the CA (or anyone holding the upload token) and published only after
  the issuer's signature verifies and the CRL is newer than the one being served.
- A web UI shows the certificates and CRLs, decoded in the browser.
- An admin API and the `aia` CLI import certificates and manage the configuration.

It runs on Cloudflare Workers with R2, or on Node.js 26 with a local directory (for example,
in the Docker image). See [docs/operations.md](docs/operations.md) for deployment.

## How it works

The service stores two JSON documents:

- `config.json`, written by the operator, says what is published:
  - `certificates`: labels for imported certificates, keyed by the SHA-256 of their DER;
  - `targets`: CRL targets, keyed by a UUID; each names an issuer certificate and a kind,
    `full` or `delta`;
  - `paths`: public paths, each serving a certificate or the current CRL of a target.
- `catalog.json`, written by the service, records the imported certificates and the
  current CRL of each target.

See [docs/config.example.json](docs/config.example.json).

### Downloads

`GET` or `HEAD` on a configured path returns the DER; `<path>.pem` returns the same object
as PEM. Paths start with `/ca/` (certificates), `/crl/` (full CRLs) or `/dcrl/` (delta
CRLs). Certificates are cached as immutable; CRLs are cached until their nextUpdate, for at
least one minute and at most one hour. A path whose target has no CRL yet returns 404.

### Publishing a CRL

`POST /api/v1/crls` takes one CRL, DER or PEM. It is published when:

1. it parses as an X.509 CRL whose two signature algorithm fields are identical;
2. its thisUpdate is at most 5 minutes in the future;
3. it covers all certificates of its issuer: no scoped Issuing Distribution Point and no
   indirect entries;
4. exactly one target of its kind (delta when it has a Delta CRL Indicator) has an issuer
   whose Subject Key Identifier equals the CRL's Authority Key Identifier;
5. the signature verifies with that issuer's key, using RSA PKCS #1 v1.5, RSASSA-PSS or
   ECDSA on P-256, P-384 or P-521, with SHA-1 or SHA-2;
6. it is newer than the target's current CRL: a higher CRL Number, or the same (or no) CRL
   Number and a later thisUpdate. A CRL with a CRL Number and one without cannot be compared.

Uploading the current CRL again is a no-op. Replaced CRLs stay available in the target's
history through the admin API. If `AIA_UPLOAD_TOKEN` is set, uploads need it as a bearer
token.

### Configuration rules

`PUT /api/v1/admin/config` replaces the whole config. It is rejected with the rules it breaks:

| Rule | Requirement                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| V1   | The document matches the schema.                                                                                 |
| V2   | A path is `/ca/`, `/crl/` or `/dcrl/` followed by segments of `A-Z a-z 0-9 . _ ~ -`, and does not end in `.pem`. |
| V3   | `/ca/` paths serve certificates, `/crl/` paths full targets and `/dcrl/` paths delta targets.                    |
| V4   | Every certificate it names is imported, and every target a path names exists.                                    |
| V5   | Every target's issuer has a Subject Key Identifier.                                                              |
| V6   | No two targets of the same kind have the same issuer, or issuers with the same Subject Key Identifier.           |
| V7   | A `/ca/` path keeps its certificate; publish another certificate under a new path.                               |
| V9   | A target keeps its issuer and kind; use a new target for another one.                                            |

Removing a target stops serving it and keeps its history. To serve that CRL again, add a
target with a new id.

## API

The API is under `/api/v1`. Its OpenAPI document is served at `/api/v1/openapi.json` and
committed as [docs/openapi.json](docs/openapi.json).

- Public: `GET /health`, `GET /certificates`, `GET /crls`, `GET /blobs/{sha256}`, and
  `POST /crls` (the upload).
- Admin, with `Authorization: Bearer <AIA_ADMIN_TOKEN>`: importing and deleting
  certificates, reading and replacing `config.json`, and listing and downloading CRL
  history. Without `AIA_ADMIN_TOKEN` the admin API answers 503.

Errors are JSON: `{ "error": { "code", "message", "details" } }`.

## CLI

```sh
export AIA_URL=https://pki.example.com
export AIA_ADMIN_TOKEN_FILE=~/.config/aia/admin-token

pnpm aia import root-ca.crt issuing-ca.pem   # a PEM bundle is imported block by block
pnpm aia new-target-id
pnpm aia config validate config.json         # offline
pnpm aia config apply config.json
pnpm aia publish issuing-ca.crl              # uses AIA_UPLOAD_TOKEN(_FILE), if set
pnpm aia history <targetId>
pnpm aia history <targetId> <sha256> --out old.crl
pnpm aia delete-certificate <id>
pnpm aia health
```

`--json` prints machine-readable results. A token is never sent over plain HTTP to a host
other than localhost unless `--allow-insecure-http` is given. Exit codes: 0 success,
1 failure, 2 usage error. The Docker image includes the CLI as `node dist/server/cli/aia.js`.

## Development

Requires Node.js 26 and pnpm 12.

```sh
pnpm install
AIA_ADMIN_TOKEN=dev pnpm run dev:node   # the server on :8787, storing in .data/
pnpm run dev:web                        # the UI with hot reload on :5173
AIA_URL=http://127.0.0.1:8787 AIA_ADMIN_TOKEN=dev pnpm run seed:dev   # test data
```

`pnpm run dev:worker` runs the Worker on :8787 instead, with its settings from `.dev.vars`
(copy `.dev.vars.example`). `pnpm run reset:dev` deletes the local data of both.

| Command              | Does                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm run check`     | Type check, lint, format check, unused-code check                |
| `pnpm test`          | All tests                                                        |
| `pnpm run build`     | Builds the UI to `dist/web` and the Node server to `dist/server` |
| `pnpm run openapi`   | Rewrites `docs/openapi.json` after an API change                 |
| `pnpm run fixtures`  | Regenerates the test PKI (needs OpenSSL 3)                       |
| `pnpm run ci:worker` | Builds the Worker and runs the smoke tests against it            |
| `pnpm run ci:docker` | Builds the image and runs the smoke tests against it             |

The code is in `src/`: `core` (domain logic and PKI parsing, shared by all runtimes),
`http` (the Hono app), `storage` (R2, disk and memory stores), `runtime` (Node and Worker
entry points), `cli`, and `web` (the Vue UI).

## License

[MIT](LICENSE)
