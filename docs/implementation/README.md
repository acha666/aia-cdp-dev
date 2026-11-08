# aia-cdp 实施计划：总则与索引

状态：切片 1–6 已完成（切片 1 = `main` 的 `0b391cc`；切片 2、3、4、5a、5b 见 `main` 上的 `Merge slice/2-catalog-import`、`Merge slice/3-downloads`、`Merge slice/4-publish`、`Merge slice/5a-api`、`Merge slice/5b-ui`，
切片 6 见切片 6 的 PR；它们的切片文件已删除，见 git 历史）。余下切片 7（迁移）；切片 8（S3）是远期计划（plan 决策 17）。owner 决策 D1–D12 已定，B1–B22 是规划默认值、可推翻（§0）；各切片未决事项列在
该切片的"开工前需 owner 确认"，汇总见附录 C。设计文档是 `docs/plan.md`；二者冲突时以本目录为准，并在同一分支回写 plan.md。

| 文件 | 内容 |
| --- | --- |
| `README.md`（本文，"总则"） | §0 决策与默认值；§1 顺序、分支与完成定义；§2 跨切片的通用约定 |
| `slice-7-migration.md` | 切片 7：迁移 |
| `slice-8-s3.md` | 切片 8：S3（远期计划） |
| `appendix-a-migration-inventory.md` | 附录 A：旧仓库逐文件的迁移处置 |
| `appendix-c-owner-questions.md` | 附录 C：待 owner 确认汇总 |
| `appendix-d-fixture-matrix.md` | 附录 D：夹具用例矩阵 |

工具链事实来自在 Node 24.22.0 上跑的六个 spike（hono-node、quality、web、docker、cloudflare、fixtures）。原始报告不在仓库里，
写"spike 验证"的事实以当时的版本为准。

引用约定：`§N` 指 `docs/plan.md` 的章节；`D`、`B` 编号见 §0；"总则 §N"指本文的章节；"切片 N 步骤 k"指该切片"步骤"下的第 k 条，
"切片 N 出口 k"指其"出口条件"第 k 条。切片 7、附录 A 与 plan §12 里的 `C`、`M` 编号和指向切片 1–5b 的引用来自已删除的文件（见 git 历史）。

## 0. 决策与默认值

owner 决策（逐项询问后确定：D1–D8 为 2026-10-18，D9、D10 为 2026-10-19 切片 1 开工前，D11、D12 为 2026-10-19 切片 2 开工前，D9 于 2026-10-23 改定；切片 2 另两项、切片 4 五项、切片 5a / 5b 两项（2026-10-20）按推荐默认确认，见附录 C）：

| # | 事项 | owner 决定 |
| --- | --- | --- |
| D1 | 前端（plan 决策 5） | Vue 3 + vue-router 5 + TanStack Query + shadcn-vue（Reka UI）+ Tailwind 4；不用 Pinia |
| D2 | Node | Node 26 LTS（EOL 2029-04-30；2026-10-24 取代 2026-10-18 定的 Node 24）：`.nvmrc` = `26`、`engines.node` = `^26.0.0`、`engineStrict`、`@types/node` 26.x、Docker `ARG NODE_VERSION=26` 与 `node:26-slim`；本机工具链见总则 §2.4 |
| D3 | Git | `main` 放文档与已合入的切片；每个切片在 `slice/<n>-<name>` 上开发，评审后本地 `--no-ff` 合并再推送。2026-10-19 起有远端 `github.com/acha666/aia-cdp`（public）：GitHub Actions 在推送 `main` 与 PR 时跑四个 `pnpm run ci:<job>`，与本机执行等价；出口条件仍可全部在本机验证 |
| D4 | 迁移源 | `~/aia-cdp/worker-aia-cdp` 本地分支 `parsing-2026-10-18` 的提交 `5b570aa`；只有附录 A 与切片 7 还引用它（`worker-aia-cdp@5b570aa:<path>`，§1.4） |
| D5 | 切片 1 的存储 | ObjectStore 端口、memory / fs / r2 适配器与一致性套件在切片 1（原在切片 2），`/api/v1/health` 在切片 1 就做真实的 store / configuration 检查；切片 2 保留 catalog/config schema 与条件写重试、`importCertificate`、`applyConfig`、管理路由与 CLI 的 import / config |
| D6 | shadcn-vue 风格 | `--style nova`、base color `neutral`、图标库 lucide（`@lucide/vue`） |
| D7 | 测试数据 | 测试只用夹具脚本生成的合成 AD CS 风格夹具（fixtures spike 证明 CA Version / 模板名编码逐字节一致、扩展嵌套相同）；仓库里不放真实 PKI 的证书与 CRL |
| D8 | 批次 1 | 本目录 + plan.md 修订 + 切片 1（已完成，见 §1.2） |
| D9 | 检查（2026-10-23 撤回 2026-10-19 加的边界护栏：core / http 的 ESLint 分层规则、`typecheck:boundary` 与其 canary、Worker 包的 `"node:` 断言） | 只用常规的一套：`wrangler types` + `vue-tsc -b`（worker / node / web 三个程序）、ESLint 常规预设加一条 `src/web` 导入规则、`prettier --check`、knip（2026-10-25 加）、vitest、构建、OpenAPI 快照（plan §10）。剩余风险见总则 §2.2 |
| D10 | devcontainer | 切片 1 建 `.devcontainer/devcontainer.json`：Node 26 镜像（自带 pnpm）、PowerShell feature（AD CS 助手）、非 root `remoteUser`、不装 `act`、OpenSSL ≥ 3.0 可生成夹具；容器内 Docker 可选；不以 root 生成文件 |
| D11 | 证书路径改绑（推翻推荐的改绑账本 `catalog.certificatePaths`） | 不记账本：V7 只与当前 config 比对，直接改绑拒绝，"先删再加"两步改绑不拦截，由操作员负责（证书下载 `immutable` 缓存一年，换 CA 证书用新路径）；`applyConfig` 只写 `config.json`。落实：plan §5.2 |
| D12 | `PUT /api/v1/admin/config` 缺可用前置条件（推翻推荐的 400 `bad_request`） | 428 + 新错误码 `precondition_required`：`If-Match` 与 `If-None-Match: *` 两者都缺、都有、或 `If-None-Match` 不是 `*`；不匹配仍是 412。落实：plan §7.2 / §7.3 |

规划默认值（全部可推翻；推翻时改本表与"落实"列指向的位置）：

| # | 默认值（可推翻） | 落实 |
| --- | --- | --- |
| B1 | 精确锁 `typescript@6.0.3`（npm latest 7.0.2 超出 typescript-eslint 的 `<6.1.0`）、`wrangler@4.152.0`；pnpm 不精确锁定（2026-10-23 从 10.34.7 升到 12）：`devEngines.packageManager` = `^12.15.0`，实际版本记在 `pnpm-lock.yaml`；其余版本按 plan §2 | `package.json` |
| B2 | 包修正：`@lucide/vue` 取代 `lucide-vue-next`；生成代码用 `cn`；补 `tw-animate-css`、`@vitejs/plugin-vue`、`@tailwindcss/vite`、`vue-tsc`、`eslint-plugin-vue`、`vue-eslint-parser`、`jiti`；`vue-sonner` 需 `import "vue-sonner/style.css"`；浏览器包都是 devDependencies；`@tanstack/vue-table` 仅需要时加；`@vueuse/core` 跟最新 major，reka-ui 未跟上时允许两份 | `package.json` |
| B3 | 模块约定：相对导入带 `.ts`；`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` + `verbatimModuleSyntax` + `erasableSyntaxOnly`、每个程序显式列 `types`、`skipLibCheck`；服务端无路径别名，web 可用 `@/`；共享代码只用裸 `crypto` / `performance`、`Uint8Array<ArrayBuffer>`，core / http 无 `Buffer`、`process` | 总则 §2.1 |
| B4 | tsconfig 拓扑：解决方案式 `tsconfig.json` + base / worker / node / build / web；三套程序都编译 `src/core` 与 `src/http`；R2 适配器用结构化类型 `R2BucketLike` | 总则 §2.2 |
| B5 | `wrangler types --env-file=/dev/null` 生成的 `.wrangler/types/worker-configuration.d.ts` 不入库，`pnpm run types` 在 check / typecheck / lint 前重生成；ESLint、Prettier 排除它 | `package.json` |
| B6 | wrangler：`name: "aia-cdp"`（不与账号里已有的 Worker 同名）、`compatibility_date: "2026-10-19"`、无兼容标志、logs、`minify`（source maps 用 deploy 默认）、`STORE` 不写 `bucket_name`（共用旧桶与否是切片 7 的 owner 项）、assets `run_worker_first` + SPA；令牌是可选 secret；脚本关遥测；dry-run 前先建 `dist/web` | `wrangler.jsonc` |
| B7 | `createApp({ store, now, settings, log, sleep?, ui? })`（`sleep` 是 catalog 条件写重试的退避，测试注入，缺省用真实计时器）；保留前缀 `/api/`、`/ca/`、`/crl/`、`/dcrl/` 不进 UI 兜底（API JSON 404、下载纯文本 404）；末段带扩展名的路径不兜底；UI 缓存头由 app 设置（先复制 ASSETS 响应）；405 用 `hono/method-not-allowed`；不注册 `app.get("*")`；路由在首个请求前注册完 | `src/http/app.ts`、`src/http/ui.ts` |
| B8 | `secureHeaders({ strictTransportSecurity: false })`，其余默认；UI 另有 `contentSecurityPolicy`（`src/http/csp.ts`，无内联脚本，无 `'unsafe-inline'`） | `src/http/app.ts`、`src/http/csp.ts` |
| B9 | 下载不用 `hono/etag`，手写 `If-None-Match`（列表、`W/`、`*`）且先于读 blob；显式 `Content-Length`；`bearerAuth` 对畸形头回 400，进管理与上传的状态表 | `src/http/routes/` 的 `downloads.ts`、`admin.ts`、`crls.ts` |
| B10 | health：`{ status, checks: { store, configuration } }`；store 抛错 → 503 `unhealthy`；config 缺失 → 200 `degraded`；`config.json` 或 `catalog.json` 不是 JSON 或不合 schema → 200 `degraded`（`invalid`），不重跑 config 的其余规则；`no-store` | `src/core/health.ts` |
| B11 | OpenAPI 文档运行时从路由表生成并按进程 / isolate 缓存，`GET /api/v1/openapi.json` `max-age=300`；提交的 `docs/openapi.json` 是它的文件快照：`tests/http/openapi.test.ts` 用 `toMatchFileSnapshot` 查漂移，`pnpm run openapi`（只对该文件跑 `vitest -u`）重写；`src` 不导入该文件 | `src/http/app.ts`、`tests/http/openapi.test.ts` |
| B12 | 每请求一行 JSON（`method`、`path`、`status`、`ms`）；只输出 JSON；不记令牌、请求体与客户端 IP | 总则 §2.6 |
| B13 | Node：`settings.ts` 的 zod schema 照 plan §4.2；`PORT` 8080 显式传给 `serve()`；`*_FILE` 启动时读；无效即打印原因 exit 1；`server.on("error")` 与 SIGTERM / SIGINT 处理；`node --enable-source-maps dist/server/runtime/node.js` | `src/runtime/settings.ts`、`src/runtime/node.ts` |
| B14 | 适配器（D5）：memory sha256 ETag；fs 临时文件 + fsync + `rename`、按键互斥、拒 `..` 与绝对路径、递归 `list`；r2 `onlyIf` 用不带引号的 `R2Object.etag`、`put` 返回 `null` 即 `precondition-failed`、`list` 跟随游标；一致性套件 memory + fs 每次跑，r2 在 `AIA_TEST_R2=1` 下经 `getPlatformProxy`；store ETag 从不当 HTTP ETag | `src/storage/` |
| B15 | vitest 5 `projects` = node + web（happy-dom）；独立 `vitest.config.ts`；没有 `globalSetup`；HTTP 用 `createApp(...).request()` | `vitest.config.ts`、总则 §2.5 |
| B16 | 夹具：`tests/fixtures/generate-test-data.sh` 不带参数，固定日期 / 序列号 / CRL 号，每次完整重写 `tests/fixtures/pki/`（含 `manifest.json`），产物入库（`.gitattributes` `tests/fixtures/pki/** -text`），生成需要 OpenSSL ≥ 3.0；测试从文件或 manifest 读值、`now` = `manifest.now`；`.gitattributes` `*.sh text eol=lf` | `tests/fixtures/`、总则 §2.5 |
| B17 | ESLint 10 flat `eslint.config.ts`、typescript-eslint 8.72.0 projectService、eslint-plugin-vue、`consistent-type-imports` + `no-import-type-side-effects`、`--max-warnings 0`；`pnpm-workspace.yaml` 的 `engineStrict`、`saveExact`、`allowBuilds` 与 `publicHoistPattern`；Prettier 3 的配置在 `package.json` 的 `prettier` 字段，生成组件每次 `add` 后重排 | `eslint.config.ts`、`pnpm-workspace.yaml`、`package.json` |
| B18 | Docker：base → prod-deps ∥ build → runtime（`node:26-slim`、uid 1000、`/data`、`NODE_ENV=production`、exec 形式 CMD、HEALTHCHECK）；`ARG VITE_SITE_NAME`；白名单 `.dockerignore`；浮动基础标签 | `Dockerfile` |
| B19 | `.github/workflows/ci.yml` 四个任务 check / test / worker / docker 各用 `pnpm/setup` 装 Node、pnpm 与依赖后调 `pnpm run ci:<job>`；`docker-publish.yml` 在推送 `main` 与 `v*.*.*` 标签时把镜像推到 `ghcr.io`；dependabot 管 npm、github-actions、docker；`pnpm verify` = check + test + build | `.github/workflows/`、`package.json` |
| B20 | Web：Vite root `src/web`、`outDir` `dist/web`、`envDir` 仓库根；`shadcn-vue@2.8.2 init` 固定参数（不用 `--defaults`）；vue-router、vue-query、i18n `en` + `zh-CN`、主题、`VITE_SITE_NAME`、经 `hc<AppType>` 的客户端；客户端目录 `src/web/client/`；dev 代理键 `^/(?:api\|ca\|crl\|dcrl)/` | `vite.config.ts`、`src/web/` |
| B21 | 验签不用 PKIjs `crl.verify()`，改为对收到的 TBS 字节调 `pkijs.getCrypto(true).verifyWithPublicKey(...)`，在 CRL 级检查之后、按算法白名单（EdDSA 按 OID → `unsupported_algorithm`）；不调 `pkijs.setEngine` | `src/core/pki/verify.ts` |
| B22 | 未定的 owner 问题列在需要它的切片的"开工前需 owner 确认"，每项带推荐默认 | 附录 C |

## 1. 顺序、分支与完成定义

### 1.1 顺序与依赖

| 切片 | 分支 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 1 | `slice/1-skeleton` | 骨架、存储端口与适配器（已完成） | — |
| 2 | `slice/2-catalog-import` | catalog/config 与导入（已完成） | 1 |
| 3 | `slice/3-downloads` | 下载（已完成） | 1、2 |
| 4 | `slice/4-publish` | 发布与 AD CS 助手（已完成） | 1–3 |
| 5a | `slice/5a-api` | API 与客户端（已完成） | 1–4 |
| 5b | `slice/5b-ui` | UI（已完成） | 1、4、5a |
| 6 | `slice/6-admin-docs` | 管理补全（已完成） | 1–5b |
| 7 | `slice/7-migration`，收尾 `slice/7-cleanup` | 迁移（`slice-7-migration.md`） | 1–6 |
| 8 | `slice/8-s3` | S3，远期计划（`slice-8-s3.md`） | 1、2、5a、6；owner 确认要做 |

```text
1 ──► 2 ──► 3 ──► 4 ──► 5a ──► 5b ──► 6 ──► 7 ──► 7-cleanup
                                       │
                                       └──► 8（远期，与 7 无先后）
```

严格串行：每个切片都改 `src/http/app.ts`、`src/http/errors.ts`、`docs/openapi.json` 或 `package.json` 的脚本，从最新 `main` 切分支，
上一个切片合入后再开下一个；依赖列只说明"用到谁的产物"，不表示可以并行。

### 1.2 批次 1

D8：批次 1 = 本目录（当时为单文件 `docs/implementation.md`）+ plan.md 修订 + 切片 1，2026-10-19 完成（`main` 的 `0b391cc`）。
之后每批一个切片；开工前先确认附录 C 中该切片的 owner 项，未答复就按推荐默认实施并在合并说明里写明。

### 1.3 完成定义（每个切片）

1. 在该切片分支上全部提交，`git status` 干净；从 `main` 的最新提交切出（必要时 rebase）。
2. `pnpm run verify` 通过（= `check` + `test` + `build`）。
3. 该切片"出口条件"逐条执行通过；合并前四个 `pnpm run ci:<job>`（`ci:check`、`ci:test`、`ci:worker`、`ci:docker`）全过：本机执行，或推送
   切片分支并开 PR 由 GitHub Actions 执行（同一组脚本，D3）。需要人工的出口（`wrangler dev` 冒烟、Windows 助手验证、
   浏览器检查、生产操作）把命令与输出摘要写进合并提交说明，或写进出口条件指定的文档。
4. 改了路由的切片：`pnpm run openapi` 重新生成并提交 `docs/openapi.json`；`tests/http/openapi.test.ts` 以文件快照比对，有漂移即失败。
5. 改了 plan 规则的切片：同一分支里同步 `docs/plan.md`（各切片的"文档同步"步骤）。
6. 评审通过后在本地合入 `main`（`git merge --no-ff slice/<n>-<name>`，保留切片边界）并 `git push origin main`；不部署，生产部署只在切片 7。
7. 改了 `tests/fixtures/generate-test-data.sh`：`pnpm run fixtures` 重新生成整树，与脚本一起提交（总则 §2.5）。

### 1.4 迁移源与引用

- 迁移源固定为 `worker-aia-cdp@5b570aa`（D4），只在附录 A 与切片 7 引用，写 `worker-aia-cdp@5b570aa:<path>[:<行>]`，行号相对该提交。
  处置用附录 A 的词：原样迁入（migrate-as-is）、迁后改（migrate-adapt）、重写（rewrite）、仅参考（reference-only）、不迁（drop）。
- 读取不切换旧仓库的分支：`GIT_OPTIONAL_LOCKS=0 git -C ~/aia-cdp/worker-aia-cdp show 5b570aa:<path>`；原样迁入的文件用它写出，
  再按总则 §2.1 改导入。旧仓库只读：不提交、不切分支、不在里面安装依赖或跑构建。
- 现有部署跑的旧仓库 `main` = `0ea3130`（切片 7 称 Gen B）引用写 `worker-aia-cdp@0ea3130:<path>`，只用于切片 7 说明迁移，不作迁移源。

## 2. 通用约定

切片正文只写本节以外的细节；二者冲突时以本节为准并修正切片。

### 2.1 模块与导入（B3）

- 全仓 ESM（`"type": "module"`）。服务端代码（`src/core`、`src/http`、`src/storage`、`src/runtime`、`src/cli`、`scripts`、`tests` 中除
  `tests/web` 外）相对导入写 `.ts` 后缀、不用路径别名；`tsc -p tsconfig.build.json` 按 `rewriteRelativeImportExtensions` 改写为 `.js`，
  开发与测试由 Node 26 直接运行 `.ts`（type stripping）。
- 只用可擦除语法（`erasableSyntaxOnly`）：不写 enum、namespace、构造参数属性，私有状态用 `#field`；纯类型导入写 `import type`
  （`verbatimModuleSyntax`；ESLint `consistent-type-imports` 分开写 + `no-import-type-side-effects`）。
- `src/web` 走 Bundler 解析，可用 `@/` 别名、导入不带后缀（shadcn-vue 生成代码如此）；web 对 `src/core`、`src/http`、`src/storage`、
  `src/runtime` 只许 `import type`（`AppType`），例外是详情页解码 DER 用的 `src/core/pki` 与 `src/core/digest.ts`；Hono 只许 `hono/client`（`eslint.config.ts` 里唯一的导入规则）。
- core 与 http 只用 Web 标准全局：裸 `crypto`、`performance`、`TextEncoder`，类型写 `typeof crypto`；交给 WebCrypto 的字节为
  `Uint8Array<ArrayBuffer>`；不出现 `Buffer`、`process`、`node:*`。core 不导入 http、storage、runtime、hono。这两条是约定，
  只由 worker 程序的类型检查部分兜住（总则 §2.2）。
- zod：core 只 `import { z } from "zod"`，对外 schema 用 `.meta({ id })` 命名；`.openapi()`、`createRoute` 只在 http，`z` 从
  `@hono/zod-openapi` 取。全依赖树只允许一份 zod。

### 2.2 tsconfig 拓扑（B4）

| 文件 | 用途 |
| --- | --- |
| `tsconfig.json` | 解决方案式：`files: []`，references 依次 worker、node、web；另带 `compilerOptions.paths {"@/*": ["./src/web/*"]}`（shadcn-vue 只读这个文件） |
| `tsconfig.base.json` | 共享严格选项、B3 的模块选项与 `noEmit` |
| `tsconfig.worker.json` | ES2024 无 DOM，类型只有 `worker-configuration.d.ts`：`src/core`、`src/http`、`src/storage/r2.ts`、`src/runtime/{worker,settings}.ts` |
| `tsconfig.node.json` | `types: ["node"]`：src 的 Node 图、`src/cli`、`scripts`、`tests`（除 `tests/web`）、根配置文件 |
| `tsconfig.build.json` | 继承 node，只发射 `src` 的 Node 图：`rootDir: src` → `dist/server`，`rewriteRelativeImportExtensions`；不进根 references |
| `tsconfig.web.json` | vue-tsc：`src/web` + `tests/web`，DOM，Bundler |

三套程序都编译 `src/core` 与 `src/http`（web 经 `import type { AppType }`）：Worker 程序里没有 `@types/node`，core / http 直接用到
`process`、`Buffer` 或 `node:*` 就编译失败；Node 程序里没有 `R2Bucket`、`Env`。剩余风险：某个依赖的类型若带
`/// <reference types="node" />`，Node 全局在 Worker 程序里也合法，core / http 里误用的 `process`、`Buffer` 照样通过类型检查，只有
`smoke:worker` 在它跑到的路径上能发现。每个被 lint 的文件都要落在某个被引用的 tsconfig 里（typescript-eslint projectService）。
不开 `noUnused*`（未用的变量与导入由 ESLint 报）。逐文件选项见各 tsconfig。

### 2.3 版本锁定（B1、B2）

- 依赖一律精确版本（`pnpm-workspace.yaml` 的 `saveExact`、`engineStrict`），提交 `pnpm-lock.yaml`；Docker、CI、全新克隆都用
  `pnpm install --frozen-lockfile`。
- pnpm 由 `devEngines.packageManager`（`^12.15.0`）约束，实际版本记在 `pnpm-lock.yaml`：`pnpm/setup` 直接装它，其他途径装的 pnpm 12
  自动切换到它（Node 25 起不带 corepack，Docker 与本机用 `npm install -g pnpm@12`）；pnpm 默认
  `minimumReleaseAge` 为 1 天，发布不满一天的版本不会被解析，lockfile 里有这种版本时安装失败。`typescript` 锁 `6.0.3`、`wrangler` 锁 `4.152.0`；dependabot 忽略
  `typescript` ≥ 6.1 与 `@types/node` 的 major 升级。`compatibility_date` 随 wrangler 一起升。
- 版本见 `package.json`。`pkijs@4.0.0`、`asn1js@4.0.0` 是 dependencies（asn1js 是 pkijs 4 的 peer，两者一起升）；切片 8 加
  `@aws-sdk/client-s3`（dependencies，开工时 `npm view` 复核版本）。
- `dependencies` 只放 Node 运行时要的包（Docker 运行阶段只装 `--prod`）；浏览器包、构建、测试、lint 工具都是 devDependencies；
  shadcn-vue CLI 写进 `dependencies` 的包用 `pnpm add -D <包>@<版本>` 挪走。

### 2.4 脚本命名（D3、B19）

- `pnpm run ci:<job>` 是 CI 任务的可执行定义；`.github/workflows/ci.yml` 的每个任务只装依赖并调用它，本机与 GitHub Actions 跑的是
  同一组脚本：
  - `ci:check` = `check` = `typecheck`（`types` + `vue-tsc -b` 查 worker / node / web）+ `eslint --max-warnings 0` + `prettier --check` + `knip`；
  - `ci:test` = `test` + `build`；
  - `ci:worker` = `build:web` + `wrangler deploy --dry-run` + `smoke:worker` + `test:r2`；
  - `ci:docker` = `bash scripts/docker-smoke.sh`；
  - 切片 8 加 `ci:s3`。
- 组合：`verify` = `check` + `test` + `build`；`types` 在 `typecheck`、`lint` 之前重生成 `worker-configuration.d.ts`。
- 命名为"动作[:变体]"：`build:web`、`dev:node`、`smoke:worker`、`test:r2`。完整表见 `package.json`。不加 `deploy` 脚本。
- TypeScript 脚本直接 `node scripts/<名>.ts`；shell 脚本一律 `bash <脚本>`（owner 的交互 shell 是 zsh）；调用 wrangler CLI 的脚本（`types`、
  `dev:worker`、`ci:worker`）带 `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`（`wrangler types` / `dev` 不读 `send_metrics`），
  `worker-smoke.ts` 与 `r2.test.ts` 在进程内设。
- Node 26 必须在 PATH 最前（否则命令会静默跑在主机自带的 Node 20 上、过不了引擎检查）；owner 本机：每个 shell 先
  `export PATH=$HOME/.local/opt/node-26/bin:$PATH`，pnpm 用 `npm install -g pnpm@12` 装进这份 Node 一次。不以 root 在工作树里跑
  pnpm、夹具脚本或容器。

### 2.5 测试布局与夹具（B15、B16、D7）

- vitest 5 `projects`：`node`（`tests/**/*.test.ts`，除 `tests/web`）与 `web`（happy-dom，`tests/web`）；没有 `globalSetup`。用例按层放在
  `tests/core`、`tests/http`、`tests/storage`、`tests/integration`、`tests/web`；`tests/helpers/` 放共享辅助，`tests/fixtures/` 放夹具脚本、
  产物与读取辅助。
- HTTP 用例走 `createApp({ store: new MemoryStore(), now, … }).request()`，不起端口；只有真实 socket 才看得到的差异（HEAD 的
  `Content-Length`、传输编码、信号处理）放 `tests/integration`。
- 存储一致性套件对每个适配器跑同一组用例；r2 只在 `AIA_TEST_R2=1`（`pnpm run test:r2`）下经
  `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 跑，`ci:worker` 包含它且要求 passed。
- 夹具只来自 `tests/fixtures/generate-test-data.sh`：不带参数，每次完整重写 `tests/fixtures/pki/`（`pnpm run fixtures`），产物入库
  （`.gitattributes` `-text`，`full-01.crlf.pem` 故意是 CRLF）；私钥只在脚本的临时目录。重新生成需要 bash 与 OpenSSL ≥ 3.0（不是
  LibreSSL）；`pnpm test` 只读入库的产物，不需要 bash 与 OpenSSL，运行时也不需要。
- 断言里的摘要、key id、序列号、大小、签名一律从夹具文件或 `manifest.json` 读（`tests/fixtures/pki.ts` 的 `manifest`、`NOW`、
  `fixture()`），不写字面量——每次重新生成都换密钥，ECDSA / PSS 签名与摘要全变；时间注入 `manifest.now`（`2026-01-04T00:00:00Z`）。
- 不放真实 PKI 的工件（D7）；切片 7 盘点下载的线上对象只放 gitignore 的 `.migration/`。

### 2.6 错误信封、状态码与日志（plan §4.3、§7.3、B12）

- 失败体 `{ "error": { "code", "message", "details"? } }`，共用一个 `ErrorResponse` schema，code 为字符串、details 为可选数据；HTTP 状态码在抛错处明确指定；成功体直接返回资源，不包
  `{ data }`。异常文本与栈只进日志；未预期错误一律 500 `internal` + 固定文案。
- `details.reason` 词表：`invalid_certificate` / `invalid_crl` 用 `der`、`trailing_bytes`、`time`、`structure`、`extension_value`、
  `pem_label`、`pem_blocks`、`pem_base64`、`signature_algorithm_mismatch`（只用于 CRL：外层与 TBS 签名算法收到的字节不同）；`issuer_not_found` 另有
  `missing_aki`。
- 头：API JSON（含错误）`Cache-Control: no-store`；`/api/v1/openapi.json` `public, max-age=300`。HTTP `ETag` 永远来自内容 sha256
  （下载 DER `"<sha256>"`、PEM `"<sha256>-pem"`，管理 config `"<sha256(存储字节)>"`）；store ETag 只回传给同一适配器，绝不外露（B14）。
- 保留前缀与 UI 兜底的完整规则见 plan §4.4：`/api/*` 未命中 → JSON 404 `not_found`；`/ca/`、`/crl/`、`/dcrl/` 下未命中 → `text/plain` 404
  `Not Found`，方法不符 → `text/plain` 405 + `Allow: GET, HEAD`（CryptoAPI 客户端）；其余 405 走 `onMethodNotAllowed` 的信封 + `Allow`。
- 鉴权：管理令牌未配置 → 503 `admin_disabled`（先于鉴权与读体）；令牌缺失或错误 → 401 + `WWW-Authenticate`；`Authorization` 畸形 →
  400 `bad_request`（B9）。上传令牌可选，未设置时上传不鉴权。
- 日志只经 `deps.log(record)`，运行时把每条记录写成一行 JSON 对象（Node 写 stdout，Workers `console.log`），必有 `level` 与 `msg`；`msg` 为事件名：
  `request`（每请求恰好一行，`method`、`path`、`status`、`ms`）、`import`、`publish`、`unhandled_error`（500 的异常）、`listening`、`shutdown`、
  `closed`、`invalid_settings`、`data_dir_unusable`、`health_store_error` 等。只输出 JSON，没有给人读的格式。永不记录令牌、请求体与查询串。
- 不记客户端 IP：需要时由边缘（Cloudflare）或反向代理的访问日志记录。
