# Operations

## Settings

| Variable               | Default      | Meaning                                                              |
| ---------------------- | ------------ | -------------------------------------------------------------------- |
| `AIA_ADMIN_TOKEN`      | unset        | Bearer token of the admin API; the admin API is disabled while unset |
| `AIA_UPLOAD_TOKEN`     | unset        | Bearer token for CRL uploads; uploads are open while unset           |
| `AIA_MAX_UPLOAD_BYTES` | `1048576`    | Largest accepted request body                                        |
| `PORT`                 | `8080`       | Node only: listening port                                            |
| `AIA_DATA_DIR`         | `/data`      | Node only: the store directory                                       |
| `AIA_STATIC_DIR`       | `./dist/web` | Node only: the built web UI                                          |

On Node, `AIA_ADMIN_TOKEN_FILE` and `AIA_UPLOAD_TOKEN_FILE` read a token from a file
instead. Tokens may contain letters, digits and `- . _ ~ + /`, optionally ending in `=`
(for example, `openssl rand -hex 32`). Invalid settings stop the Node server at startup and
make the Worker answer every request with 500.

`VITE_SITE_NAME` sets the site name in the UI when it is built (default `PKI AIA/CDP`). It is
inserted into the HTML as is, so it must not contain `< > & "`.

Serve the API over HTTPS. Clients fetch AIA and CDP URLs over plain HTTP, so the download
paths must stay reachable without TLS: do not redirect `/ca/`, `/crl/` and `/dcrl/` to
HTTPS.

## Docker

The image `ghcr.io/acha666/aia-cdp` (linux/amd64) is published from `main` as `:main`, and
from tags `vX.Y.Z` as `:X.Y.Z`, `:X.Y` and `:latest`. It runs as uid 1000, listens on 8080
and keeps all data in `/data`.

```sh
docker run -d --name aia-cdp -p 8080:8080 -v aia-data:/data \
  -e AIA_ADMIN_TOKEN_FILE=/run/secrets/admin-token \
  -v ./admin-token:/run/secrets/admin-token:ro \
  ghcr.io/acha666/aia-cdp:main
```

A bind-mounted data directory must belong to uid 1000 (or run the container with
`--user` set to its owner); otherwise the server logs `data_dir_unusable` and exits. Only
one container may use a data directory at a time.

To build the image with another site name:
`docker build --build-arg VITE_SITE_NAME='Example PKI' -t aia-cdp .`

The health check calls `/api/v1/health`, which reports `degraded` until a config is
applied. The CLI is in the image:
`docker exec -e AIA_URL=http://127.0.0.1:8080 aia-cdp node dist/server/cli/aia.js health`.

## Cloudflare Workers

`wrangler.jsonc` deploys a Worker named `aia-cdp` (replacing any Worker of that name in the
account), with an R2 bucket bound as `STORE` and the built UI from `dist/web`. The first
deploy creates the bucket.

```sh
pnpm run build:web
pnpm exec wrangler secret put AIA_ADMIN_TOKEN
pnpm exec wrangler secret put AIA_UPLOAD_TOKEN   # optional
pnpm exec wrangler deploy
```

Set `AIA_MAX_UPLOAD_BYTES`, if needed, as a variable in `wrangler.jsonc`. Logs go to
Workers Logs. The Free plan's 10 ms of CPU per request is too little for CRLs with more
than a few hundred entries.

## First setup

1. Import the CA certificates: `aia import root-ca.crt issuing-ca.crt`. The output lists
   their ids.
2. Write a config: a label per certificate, a target per CRL to publish (`aia new-target-id`
   makes an id), and the paths that your certificates' AIA and CDP URLs name. Check it
   with `aia config validate config.json`.
3. Apply it: `aia config apply config.json`.
4. Upload the current CRLs: `aia publish *.crl`, or let the CA upload them.

To change the config later, edit the file and apply it again; the whole document is
replaced. To serve a renewed CA certificate, import it and add a new `/ca/` path.

## Uploading CRLs from AD CS

[`scripts/adcs-crl-uploader.ps1`](../scripts/adcs-crl-uploader.ps1) (PowerShell 7) uploads
the CRLs in a folder that the CA publishes to, oldest first, and remembers what the service
accepted in a ledger so that unchanged files are not sent again.
`Get-Help ./adcs-crl-uploader.ps1 -Full` lists its parameters.

1. Install PowerShell 7 on the CA and put the script where only administrators can write.
2. Use a CRL publication folder of the CA as `-SourceDir`: its default `CertEnroll` folder,
   or a file location added to the CA's CDP extension, for example
   `C:\ProgramData\PKI\crl-uploader\CertEnroll\<CaName><CRLNameSuffix><DeltaCRLAllowed>.crl`,
   with publishing of CRLs and delta CRLs enabled.
3. Put the upload token, if any, in a file that only administrators and the task's account
   can read, and pass it as `-UploadTokenFile`.
4. Run the script as a scheduled task under a low-privilege account, triggered by the CA's
   CRL publication and also hourly to retry failures, with "do not start a new instance"
   if one is running.

The task's result is 1 when a file failed; `upload.log` says why. A `stale_crl` failure
means the folder holds a CRL older than the published one; it fails on every run until the
file is removed. After restoring or replacing the service behind the same URL, delete the
ledger, or files the old service accepted are not sent again.

## Limits

- `AIA_MAX_UPLOAD_BYTES` (1 MiB by default) fits a CRL of about 25 000 entries. Publishing
  needs about 21 MB of heap plus 0.6 MB per 1 000 entries; raise the Node heap
  (`--max-old-space-size`) along with the limit.
- R2 accepts about one write per second to `catalog.json`. An upload that exceeds it fails
  with 500 and should be retried; the AD CS script pauses between uploads.
- The service does not rate-limit requests; leave that to Cloudflare or a reverse proxy.

## Data

The store holds:

- `config.json` and `catalog.json`;
- `blobs/certificates/<sha256>.der`;
- `blobs/crls/<targetId>/<thisUpdate>-<crlNumber>-<sha256>.der`, every published CRL;
- `history/<targetId>/<same name>.json`, a marker for each replaced CRL.

Back up the whole directory or bucket. Blobs never change once written.

## Logs

Logs are JSON lines with `level` and `msg`: one `request` record per request, one `publish`
record per CRL upload (with the target, CRL Number and outcome or rejection reason), and
`error` records with details for internal errors. They contain no tokens, request bodies or
client addresses.
