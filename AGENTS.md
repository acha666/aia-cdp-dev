# AGENTS.md

Notes for coding agents working in this repository. [README.md](README.md) describes what the
service does and [docs/operations.md](docs/operations.md) how it is deployed; read them first.

## Setup and commands

Node.js 26 and pnpm 12. Node runs the TypeScript sources directly (`node src/...ts`), so
there is no build step for development, scripts or tests.

| Command              | Use                                                              |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm run check`     | Type check (`vue-tsc -b`), ESLint, Prettier check, knip          |
| `pnpm test`          | All Vitest tests (projects `node` and `web`)                     |
| `pnpm run verify`    | `check`, `test` and `build`; run before finishing a change       |
| `pnpm run format`    | Prettier over the repository                                     |
| `pnpm run openapi`   | Rewrites `docs/openapi.json`; run after any API or schema change |
| `pnpm run fixtures`  | Regenerates `tests/fixtures/pki` (needs OpenSSL 3)               |
| `pnpm run ci:worker` | Worker dry-run build, smoke test and R2 tests                    |

Run one file with `pnpm vitest run tests/core/publish.test.ts`. ESLint runs with
`--max-warnings 0`, and knip fails on unused files, exports and dependencies, so remove
what a change leaves unused.

## Layout

- `src/core`: domain logic, independent of the runtime. `pki/` parses and verifies
  certificates and CRLs (pkijs, asn1js); `catalog.ts`, `publish.ts`, `admin.ts`,
  `certificates.ts`, `history.ts` change the stored state; `store.ts` is the `ObjectStore`
  contract.
- `src/http`: the Hono app (`app.ts`), routes in `routes/`, Zod OpenAPI schemas in
  `schemas.ts`, the error envelope in `errors.ts`.
- `src/storage`: `ObjectStore` backends: R2, disk (`fs.ts`) and memory.
- `src/runtime`: entry points for Node (`node.ts`) and the Worker (`worker.ts`), and the
  environment settings shared by both (`settings.ts`).
- `src/cli`: the `aia` CLI (Commander), a client of the HTTP API.
- `src/web`: the Vue 3 UI (vue-router, TanStack Query, vue-i18n, Tailwind 4).
  `components/ui` holds shadcn-vue components trimmed to the variants the app uses.
- `tests/`: mirrors `src/` (`core`, `http`, `storage`, `web`) plus `integration`;
  shared helpers in `tests/helpers`, the test PKI in `tests/fixtures/pki`.

## Language

- Docs, comments, code, and anything that reaches a remote, such as commit messages and
  pull request descriptions, are in English.
- In conversation, follow the user's stated preference, or else the language the user writes
  in.

## Remote changes

- Do not push, open, update, comment on or merge pull requests, or make any other change to
  a remote, unless the user asks for it explicitly and unambiguously.
- If the user has not asked for a push or a pull request, at most ask whether to go ahead
  and push.
- Pull requests are squash-merged by default.
- When an agent monitors a pull request or other interaction on its own, add a short note at
  the bottom, such as "Created and monitored by an LLM agent".

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `refactor:`, `docs:`, `test:`, `build:`, `chore:`, with an optional scope such as
  `fix(pki):`).
- Commit messages and changelog entries say briefly what changed. Leave out what was found,
  synced or corrected along the way.
- Claude: do not add Claude as a co-author (`Co-Authored-By`) or sign commits or pull
  requests in any other way.

## Docs and tests

- When updating docs after a change, do not add a description of the change itself; it
  breaks the structure and flow of the document. Leave the docs alone unless the change
  makes them wrong or incomplete.
- Do not write tests for one-off local fixes, do not test defensively, and do not write
  tests that will not fail in the foreseeable future.
