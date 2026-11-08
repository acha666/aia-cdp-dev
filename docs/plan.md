# aia-cdp：新项目规划（2026-10-17）

状态：设计文档，2026-10-17 定稿，之后按 owner 决策与评审修订（经过见 git 历史）。切片 1–6 已完成（见 `main` 的合并提交）；余下切片 7（迁移），切片 8（S3）列为远期计划。
分步实施计划（每个未完成切片的步骤、测试、可执行的出口条件、待 owner 确认项）在 `docs/implementation/`；本文与之冲突时以后者为准，规则由各切片的
"文档同步"步骤写回本文。业务规则在 §6 一次列全。

## 0. 决策记录

| #   | 事项       | owner 决定（2026-10-17；之后的修订注明日期）                                           |
| --- | ---------- | -------------------------------------------------------------------------------------- |
| 1   | HTTP 与契约 | Hono + `@hono/zod-openapi`；前端用 `hc` 类型客户端                                  |
| 2   | 存储模型   | `config.json` + `catalog.json` + 内容寻址的不可变 blob；不用对象自定义元数据          |
| 3   | 管理通道   | 带独立管理令牌的 HTTP 管理接口；CLI 只是薄 HTTP 客户端                                |
| 4   | 首发后端   | memory、fs、R2；S3 兼容作为后续切片                                                   |
| 5   | 前端       | 2026-10-18 确认：Vue 3 + vue-router 5 + TanStack Query + shadcn-vue（Reka UI）+ Tailwind 4；不用 Pinia。见本文 §8 |
| 6   | 测试       | vitest                                                                                 |
| 7   | API        | `/api/v1`；下载 URL（`/ca/*`、`/crl/*`、`/dcrl/*`）由路径表配置，已签发证书里写死的 URL 不变 |
| 8   | 交付       | 2026-10-18：批次 1 = 实施计划（`docs/implementation/`）+ 本文修订 + 切片 1（已完成），之后每批一个切片 |
| 9   | Node       | 2026-10-18 定 Node 24 LTS 全面取代 Node 22；2026-10-24 改为 Node 26 LTS（EOL 2029-04-30）：`.nvmrc` = `26`、`engines.node` = `^26.0.0` + `engineStrict`、`@types/node` 26.x、Docker `ARG NODE_VERSION=26` 与 `node:26-slim`；Node 25 起不带 corepack，Docker 与本机用 `npm install -g pnpm@12` 引导 pnpm |
| 10  | 版本库     | 2026-10-18：`main` 放文档与已合入的切片，每个切片在 `slice/<n>-<name>` 分支开发、评审后本地 `--no-ff` 合并；每个 CI 任务都是本地可跑的 `pnpm run ci:<job>`。2026-10-19 建远端 `github.com/acha666/aia-cdp`，合并后推送，GitHub Actions 跑同一组脚本 |
| 11  | 切片 1 范围 | 2026-10-18：ObjectStore 端口、memory / fs / r2 适配器与一致性套件在切片 1（原在切片 2），`/api/v1/health` 在切片 1 就做真实的 store / configuration 检查 |
| 12  | shadcn-vue 风格 | 2026-10-18：`--style nova`、base color `neutral`、图标库 lucide（`@lucide/vue`） |
| 13  | 测试数据   | 2026-10-18：测试只用夹具脚本生成的合成 AD CS 风格夹具（fixtures spike 证明 CA Version / 模板名编码逐字节一致、扩展嵌套相同），仓库里不放真实 PKI 的证书与 CRL |
| 14  | 迁移源     | 2026-10-18：`~/aia-cdp/worker-aia-cdp` 本地分支 `parsing-2026-10-18` 的提交 `5b570aa`；只有附录 A 与切片 7 还引用它（`worker-aia-cdp@5b570aa:<path>`） |
| 15  | 检查与 devcontainer | 2026-10-23：检查只用常规的一套（§10）：`wrangler types` + `vue-tsc -b`（worker / node / web 三个程序）、ESLint 常规预设加一条 `src/web` 导入规则、`prettier --check`、knip（2026-10-25 加）、vitest、构建、OpenAPI 快照；撤回 2026-10-19 加的边界护栏（ESLint 分层规则、`typecheck:boundary`、Worker 包的 `"node:` 断言）。切片 1 建 devcontainer（Node 26 镜像、PowerShell feature、非 root、无 `act`） |
| 16  | 切片 2 两项 | 2026-10-19：不记证书路径改绑账本——V7 只与当前 config 比对，"先删再加"不拦截、由操作员负责，`applyConfig` 只写 `config.json`（§5.2）；`PUT /api/v1/admin/config` 缺可用前置条件回 428 `precondition_required`，不用 400（§7.2、§7.3） |
| 17  | 切片 6 | 2026-10-24：退役 = 从 `config.json` 删除目标，取消规则 V8，没有 retire 路由、命令与 catalog 字段（§5.2、§6）；证书删除保护：被 config 引用或作为任一目标 current 的 `verifier` 的证书不可删，不做删除后的复核与补偿（§5.5）；历史可列可下载（§7.2）；不写 `docs/api.md`、不补 operations.md 的部署等章节；S3（切片 8）列为远期计划 |

决策 5、8–16 即 implementation 总则 §0 的 D1–D12（5 = D1，9 = D2，10 = D3，14 = D4，11 = D5，12 = D6，13 = D7，8 = D8，15 = D9 + D10，16 = D11 + D12）。

决策 3 的连带效果：所有写入都经过服务进程。fs 后端只需要进程内互斥，不需要跨进程文件锁
（`proper-lockfile` 不再需要）；Cloudflare 部署不需要 R2 的 S3 API 令牌，S3 适配器只是"多实例 Node 可选"。

## 1. 目标与非目标

目标：

- 一份代码，两种运行时：Cloudflare Workers + R2；Node 26 + 本地磁盘（Docker）。
  共用一个 `createApp(deps)`，两个入口文件各十几行。
- 公开分发 CA 证书与 CRL（AIA/CDP）。公开 URL 由操作员配置，DER 是唯一权威，PEM 读取时派生。
- AD CS 上传 CRL 后自动验签、比较新鲜度并发布，返回 created / updated / unchanged 三种结果。
- 导入与删除证书、替换配置（删除目标即退役）、查看与下载历史都走带令牌的 HTTP 管理接口，CLI 包装这些接口。
- Web UI 浏览证书与 CRL 目标（总览 + 详情页）、上传 CRL。

非目标（明确不做）：

- 证书签发、私钥管理、证书链验证。
- 数据库、队列、后台任务、边缘缓存、插件系统、分页与游标（资源数以十计）。
- 对象自定义元数据；多个服务进程共享一个 fs 数据目录（多实例走 S3，远期计划）。
- CORS；公开 API 暴露 CRL 历史；full 与 delta CRL 的合并或相互校验。
- 运行时注入 `SITE_NAME`；HTTP 管理 UI（首发只有 CLI）。

## 2. 技术选型

版本为规划时 `npm view` 查到的最新版，并经工具链 spike 修正。依赖一律精确版本（`pnpm-workspace.yaml` `saveExact: true`），以提交的
`package.json` 与 `pnpm-lock.yaml` 为准，Docker、CI、全新克隆都用 `pnpm install --frozen-lockfile`；后续切片新增的包见 implementation 总则 §2.3。

| 领域          | 选型                                            | 版本                              | 说明                                                                                           |
| ------------- | ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 运行时        | Node 26 LTS（固定）、Cloudflare Workers          | —                                 | `.nvmrc` = `26`、`engines.node` = `^26.0.0` + `pnpm-workspace.yaml` `engineStrict: true`（不符即安装失败）、`node:26-slim`（决策 9） |
| 包管理        | pnpm 12                                         | ^12.15.0                          | 2026-10-23 起不精确锁定：`devEngines.packageManager` 给范围，实际版本记在 `pnpm-lock.yaml`：CI 的 `pnpm/setup` 直接装这个版本，其他途径装的 pnpm 12（`npm install -g pnpm@12`、devcontainer 镜像自带）自动切换到它；`pnpm-workspace.yaml` 设 `engineStrict`、`saveExact`、`allowBuilds` 与 `publicHoistPattern`；默认 `minimumReleaseAge` 1 天 |
| HTTP          | `hono`                                          | 4.13.13                           | 路由、自动 HEAD、`methodNotAllowed`（`hono/method-not-allowed`，hono ≥ 4.13.0）、`bodyLimit`、`bearerAuth`、`secureHeaders`；下载的 ETag / 304 手写，不用 `hono/etag`（§6） |
| Node 服务器   | `@hono/node-server`                             | 2.1.5                             | `serve()` + `serve-static`；替代手写 `node:http` 桥                                            |
| 校验与 OpenAPI | `@hono/zod-openapi` + `zod`                    | 1.6.3 / 4.6.7                     | 路由声明即 schema，处理器返回值按状态码类型检查；OpenAPI 文档运行时从路由表生成，另写出提交的 `docs/openapi.json` 作漂移基线（§7.3） |
| 类型化客户端  | `hono/client` 的 `hc<AppType>`                  | 随 hono                           | 前端类型从服务端路由推导；`init: { cache: "no-store" }`                                        |
| PKI           | `pkijs` + `asn1js`                              | 4.0.0 / 4.0.0                     | 证书、CRL 与常规扩展的解析、验签；详情采用尽力展示，仅为库缺陷和未支持的结构保留小型读取器 |
| 前端          | `vue`、`vue-router`、`@tanstack/vue-query`、`vue-i18n` | 3.5.44 / 5.4.0 / 5.104.5 / 11.4.16 | 不用 Pinia（决策 5）                                                                   |
| 前端构建      | `vite` + `@vitejs/plugin-vue`、`tailwindcss` + `@tailwindcss/vite`、`tw-animate-css`、`vue-tsc` | 8.3.5 / 6.0.10、4.3.3 / 4.3.3、1.4.0、3.3.13 | vite 8（Rolldown、默认 oxc 压缩）；`vue-tsc -b` 检查 worker / node / web 三个程序（§10） |
| UI 组件       | shadcn-vue（CLI，`--style nova`）+ `reka-ui` + `class-variance-authority` + `cn` + `@lucide/vue` + `vue-sonner` | 2.8.2 / 2.11.0 / 0.7.1 / 0.5.0 / 1.61.0 / 2.0.9 | 组件源码生成到 `src/web/components/ui/`；生成代码用 `cn` 包，取代 `clsx` + `tailwind-merge`；`@lucide/vue` 取代已弃用的 `lucide-vue-next`；`vue-sonner` 需 `import "vue-sonner/style.css"`；`@tanstack/vue-table` 不随 shadcn Table 安装，也没用上（吊销列表分页只是 `slice()`） |
| 前端工具      | `@vueuse/core`                                   | 15.0.0                            | reka-ui 2.11.0 仍依赖 `^14.1.0`，web 包里暂有两份（多约 0.4 kB gzip），reka-ui 跟上后自然合一；`useNow`（统一时钟快照，15 起间隔经 `scheduler` 传 `useIntervalFn`）、`useStorage`；复制不用 `useClipboard`（其 `execCommand` 退路失败也报成功） |
| 测试          | `vitest`、`@vue/test-utils`、`happy-dom`        | 5.0.5 / 2.5.1 / 21.0.4            | HTTP 用 `app.request()` 进程内测；R2 用 wrangler `getPlatformProxy`；夹具由脚本生成后入库（§10） |
| Cloudflare    | `wrangler`                                      | 4.152.0（精确锁定）               | `wrangler types` 生成绑定类型 `worker-configuration.d.ts`（不入库）；不装 `@cloudflare/workers-types`；`compatibility_date` 随 wrangler 一起升 |
| CLI           | `commander` + 内置 `fetch`                      | 15.0.0                            | 无传递依赖；声明式子命令、参数检查和自动帮助；`exitOverride` / 注入输出保留进程内测试与 0/1/2 退出码 |
| 后续          | `@aws-sdk/client-s3`                            | 3.1152.0                          | S3 适配器切片，仅进 Node bundle                                                                |
| 质量          | `typescript`；`eslint` + `@eslint/js` + `typescript-eslint` + `eslint-plugin-vue` + `vue-eslint-parser` + `jiti`；`prettier`；`knip` | 6.0.3；10.13.0 / 10.0.1 / 8.72.0 / 10.11.1 / 10.4.1 / 2.7.0；3.9.10；6.43.0 | `typescript` 精确锁 6.0.3（npm latest 7.0.2 超出 typescript-eslint 的 `<6.1.0`）；`jiti` 供 ESLint 10 加载 `eslint.config.ts`；`knip` 查未用的文件、导出与依赖（§10）；`@types/node` 26.6.5 |
| 开发前置      | OpenSSL CLI、bash、Docker Engine                 | OpenSSL ≥ 3.0（不是 LibreSSL）、Docker ≥ 25 | 只在开发与 CI 用：OpenSSL 只在重新生成测试夹具时需要，bash 用于夹具生成与冒烟脚本（`smoke:worker`、`ci:docker`）（§10，`pnpm test` 两者都不需要），Docker 构建镜像（`HEALTHCHECK --start-interval` 需要 25）；运行时都不需要 |

`dependencies` 只放 Node 运行时要的包（`hono`、`@hono/zod-openapi`、`zod`、`@hono/node-server`，切片 2 起加 `pkijs`、`asn1js`）；
浏览器包、构建、测试、lint 工具都是 devDependencies（Docker 运行阶段只装生产依赖），shadcn-vue CLI 写进 `dependencies` 的包要挪走。

明确不用：`unstorage`（无条件写）、`@cloudflare/vitest-pool-workers`（R2 适配器几十行，
`getPlatformProxy` 一个测试够）、`ts-rest`（停更，锁 zod 3）、`aws4fetch`、`proper-lockfile`、
`srvx`、Express/Fastify（非 Workers 原生）、`hono/etag`（在处理器之后比较，做不到 304 不读 blob）、
`lucide-vue-next`（已弃用）、`clsx` + `tailwind-merge`（shadcn-vue 改用 `cn`）、`pinia`。

## 3. 仓库布局

```text
aia-cdp/
  package.json  pnpm-lock.yaml  pnpm-workspace.yaml  .nvmrc
  .gitignore  .gitattributes  .prettierignore  .dockerignore
  tsconfig.json  tsconfig.base.json  tsconfig.worker.json  tsconfig.node.json
  tsconfig.build.json  tsconfig.web.json
  wrangler.jsonc  .wrangler/types/worker-configuration.d.ts（`pnpm run types` 生成，不入库）
  Dockerfile  vite.config.ts  vitest.config.ts  eslint.config.ts  knip.json  components.json（shadcn-vue）
  .github/             workflows/ci.yml  workflows/docker-publish.yml  dependabot.yml
  .devcontainer/       devcontainer.json（决策 15）
  src/
    core/              纯 TS：不引用 node:*、process、R2Bucket
      pki/             解析、准入检查、验签、PEM 编解码（详情页在浏览器里也用它的解析器）
      summary.ts       导入与发布时写进 catalog 的证书 / CRL 摘要（§5.3），含 SKI / AKI、CRL 号的读取
      digest.ts        hex 与 SHA 摘要（服务端、CLI 与浏览器共用）
      store.ts         ObjectStore 端口
      catalog.ts       catalog.json / config.json 的 schema、读取、条件写与重试
      resources.ts     路径表解析、下载策略
      certificates.ts  importCertificate(deps, bytes) / deleteCertificate
      publish.ts       publishCrl(deps, bytes)（入口取一次 deps.now()）
      admin.ts         validateConfig / applyConfig
      history.ts       CRL 版本名与键（crlBlobKey / crlHistoryKey）、listHistory / getHistoryBlob
      views.ts         公共读接口：证书与 CRL 目标列表、按 SHA-256 取 blob
      health.ts        健康检查
    http/
      app.ts           createApp(deps) → OpenAPIHono；中间件与挂载顺序
      routes/          health.ts  certificates.ts  crls.ts  admin.ts  downloads.ts
      schemas.ts       API v1 的请求 / 响应 / 错误 schema
      errors.ts        ApiError、createErrorHandler（onError）、validationHook（defaultHook）→ 错误信封
      ui.ts            保留前缀与 UI 兜底（uiFallback）、onMethodNotAllowed、UI 缓存头（§4.4）
    storage/           memory.ts  fs.ts  r2.ts（s3.ts 后续）
    runtime/
      worker.ts        export default { fetch }
      node.ts          serve + SIGTERM / SIGINT
      node-ui.ts       serveStatic + index.html 兜底（Node 的 deps.ui）
      settings.ts      环境变量 schema（zod，两条运行时共用）
    cli/               薄 HTTP 客户端 aia
      aia.ts           入口：用法、参数解析与分派
      client.ts        服务访问：服务 URL、令牌来源与发送规则、带超时的请求、错误信封
      commands.ts      各子命令（import / publish 逐项报告加汇总行、config、history 等）
    web/               Vue UI（Vite root；按 §8 重建）
      client/          hc<AppType> 客户端（不得叫 api：dev server 会把 src/web 下的目录当 URL 服务）
      components/ui/   shadcn-vue 生成的组件（入库）
      x509/            详情页的显示映射：扩展、名称、算法字段、ASN.1 dump 与 OID 名称表
      lib/utils.ts     shadcn-vue 生成（cn）
  tests/
    core/  http/  storage/  integration/  web/
    helpers/           testDeps()、store 包装、readService / setupPublish（按运维流程建状态）
    fixtures/          generate-test-data.sh  pki.ts；产物 pki/ 入库
  scripts/             adcs-crl-uploader.ps1  seed-dev.ts
                       smoke.sh  worker-smoke.ts  docker-smoke.sh（切片 7 加 migrate-from-v2.ts）
  docs/                plan.md（本文）  implementation/（总则、未完成的切片、附录）  operations.md  openapi.json
  dist/                web/（vite build） server/（tsc -p tsconfig.build.json） worker/（dry-run）；不入库
```

不入库：`dist/`、`.wrangler/`（含生成的 `worker-configuration.d.ts`）、`.data/`、`.dev.vars*`、`node_modules/`。
`.gitattributes` 设 `*.sh text eol=lf` 与 `tests/fixtures/pki/** -text`（夹具逐字节比较）；`.dockerignore` 用白名单，`tests/fixtures`、`.dev.vars`、`.git` 进不了构建上下文。

模块约定（全仓 ESM、服务端相对导入写 `.ts`、只用可擦除语法、`src/web` 对服务端模块只许 `import type`（core/pki 与 core/digest.ts 除外）、core 与 http 只用 Web 标准全局）
见 implementation 总则 §2.1。tsconfig 拓扑（worker / node / web 三个程序加只发射的 `tsconfig.build.json`）见总则 §2.2：三套程序都编译
`src/core` 与 `src/http`，Worker 程序的类型只有 `worker-configuration.d.ts`。`eslint.config.ts` 只另加一条导入规则：`src/web` 对 `src/core`、`src/http`、
`src/storage`、`src/runtime` 只许 `import type`，例外是 `src/core/pki` 与 `src/core/digest.ts`（详情页在浏览器里解码 DER），Hono 只许 `hono/client`。core 与 http 不用 Node 全局、不导入 http / storage / runtime 是约定，没有专门的检查；
接受的剩余风险：某个依赖的类型声明引用了 node 时，core / http 里误用的 `process`、`Buffer` 也能通过 Worker 程序的类型检查，只有 `smoke:worker` 执行到的路径
会失败。R2 适配器按结构化类型 `R2BucketLike` 写，r2 一致性测试因此在 `tsconfig.node.json` 下编译。

## 4. 运行时与配置

### 4.1 Cloudflare Workers

- `wrangler.jsonc`：`name: "aia-cdp"`（`wrangler deploy` 会覆盖同一账号里的同名 Worker，名字不能与已有的 Worker 相同）；
  `main: src/runtime/worker.ts`；`compatibility_date: "2026-10-19"`（= wrangler 4.152.0 自带的 workerd，随 wrangler 一起升）；
  不设兼容标志（`nodejs_compat` 自 2026-08-04 起默认开启，真正的护栏是 tsconfig 的 `types`，§3）；
  `observability.logs.enabled: true`（§4.3）；`minify: true`；source maps 用 `wrangler deploy` 的默认（构建并上传）；
  `r2_buckets: [{ binding: "STORE" }]`，不写 `bucket_name`（自动置备；是否共用旧桶是切片 7 的 owner 项）；
  `assets: { directory: "dist/web", binding: "ASSETS", run_worker_first: true,
  not_found_handling: "single-page-application" }`（history 路由的兜底）。不写 `routes`、`build.command`、`vars`。
- 绑定类型：`wrangler types --env-file=/dev/null` 生成 `.wrangler/types/worker-configuration.d.ts`（不读 `.dev.vars`，结果确定），不入库；
  `pnpm run types` 在 check / typecheck / lint 之前重生成，ESLint 与 Prettier 排除它。
- 入口：按 `env` 缓存一个 app（`WeakMap<Env, AppType>`），`createApp({ store: new R2Store(env.STORE), now, settings,
  log: (record) => console.log(JSON.stringify(record)), ui: (req) => env.ASSETS.fetch(req) })`，`app.fetch(req, env, ctx)`；
  设置无效时每个请求返回 500 信封并记一行 error 日志。ASSETS 只经 `deps.ui` 调用，保留前缀与 UI 兜底规则在应用内（§4.4）：
  `/api/*` 与下载前缀的未命中不会被 SPA 兜底答成 200 HTML。
- 令牌是可选的 `wrangler secret`（`AIA_ADMIN_TOKEN` / `AIA_UPLOAD_TOKEN`），代码里类型为可选，不用 `secrets.required`；
  `AIA_MAX_UPLOAD_BYTES` 有默认值，需要时用 `vars`。入口把每个变量作为字符串交给 `parseSettings`：不是字符串的值（如写成 JSON 数字）
  取其 JSON 文本，`null` 视为未设，有效与否由 `parseSettings` 判定。
- 调用 wrangler CLI 的脚本（`types`、`dev:worker`、`ci:worker`）设 `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`（`wrangler types`、
  `wrangler dev` 不读 `send_metrics`，deploy 的 autoconfig 事件也不看它），`worker-smoke.ts` 与 `r2.test.ts` 在进程内设，CI 不另设；
  `wrangler deploy --dry-run --outdir dist/worker` 需要先有 `dist/web`（先 `vite build`）。不加 `deploy` 脚本（首次部署会自动置备新桶，部署按 `docs/operations.md` 手工执行），生产部署只在切片 7。

### 4.2 Node / Docker

| 变量                                 | 默认                 | 说明                                                 |
| ------------------------------------ | -------------------- | ---------------------------------------------------- |
| `PORT`                               | `8080`               |                                                      |
| `AIA_STORE`                          | `fs`                 | `fs`；后续 `s3`                                      |
| `AIA_DATA_DIR`                       | `/data`              | fs 根目录；一个服务进程对应一个目录                  |
| `AIA_STATIC_DIR`                     | `./dist/web`         | UI 构建产物                                          |
| `AIA_ADMIN_TOKEN` / `_FILE`          | 无                   | 未设置时管理接口返回 503 `admin_disabled`            |
| `AIA_UPLOAD_TOKEN` / `_FILE`         | 无                   | 未设置时上传不需要令牌                               |
| `AIA_MAX_UPLOAD_BYTES`               | `1048576`            | `bodyLimit`：CRL 上传与管理路由读的最大请求体（§5.5）；1 MiB ≈ 25 000 个吊销条目 |

启动（`src/runtime/node.ts`，设置 schema 在 `src/runtime/settings.ts`，纯 zod、Worker 与 Node 共用）：

- 用 zod 校验全部变量，字段与默认值按上表；`*_FILE` 在启动时读取（去掉一个结尾换行），`X` 与 `X_FILE` 同时设置报错；
  两个令牌须是 RFC 6750 `b64token`（字母、数字、`-._~+/`，末尾可接 `=`；`bearerAuth` 只从请求头读这种格式，其他字符的令牌
  永远 400）；无效即在 stderr 打印原因、exit 1。`AIA_DATA_DIR` 须是可读写目录，否则 JSON 错误日志 + exit 1。
- `serve({ fetch: app.fetch, port })`：`PORT` 显式传入（`@hono/node-server` 的默认是 3000），不传 hostname（`::` 双栈）；
  就绪日志一行 `listening`。`server.on("error")`（如端口被占用）→ JSON 日志 + exit 1；SIGTERM / SIGINT → `server.close()` 并立即关闭空闲连接，
  2 s 宽限后关闭其余全部连接（含请求头没发完的慢客户端，`close()` 会一直等它们）。
- `AIA_STATIC_DIR` 不必存在：没有 UI 构建时 UI 路径都是纯文本 404，health 不受影响（`dev:node` 的 UI 由 Vite dev server 提供）。
- 生产 `node --enable-source-maps dist/server/runtime/node.js`；开发与测试直接 `node src/runtime/node.ts`（type stripping）。

Dockerfile（`ARG NODE_VERSION=26`，基础镜像浮动标签 `node:26-slim`，trixie；digest 固定以后再定）：

- 阶段 base：`npm install -g pnpm@12`（Node 25 起不带 corepack），复制 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 后
  `pnpm --version`（切换到 `pnpm-lock.yaml` 记录的 pnpm，两个安装阶段共用）；prod-deps：`pnpm install --store-dir /pnpm/store --prod --frozen-lockfile --ignore-scripts`
  （store 缓存挂载；不写 `--store-dir` 时 pnpm 见挂载点在另一文件系统会改用 `/.pnpm-store`）；build：全量安装 + `vite build` +
  `tsc -p tsconfig.build.json`。`engineStrict` 让 `NODE_VERSION=24` 的构建在安装阶段失败。
- 阶段 runtime（`node:26-slim`）：`NODE_ENV=production`；只复制生产依赖、`dist/` 与 `package.json`（`"type": "module"` 需要它）；
  先建 `/data` 并 chown 给 `node`，再 `USER node`（uid 1000）与 `VOLUME /data`；`EXPOSE 8080`；
  exec 形式 `CMD ["node", "--enable-source-maps", "dist/server/runtime/node.js"]`；
  `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3`，用 `node -e` 的
  `fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health', { signal: AbortSignal.timeout(4000) })`，200 即健康（含 `degraded`）。
- `SITE_NAME` 只在 `vite build` 时通过 `VITE_SITE_NAME` 注入（Docker `ARG VITE_SITE_NAME`，无默认），空值用默认 `PKI AIA/CDP`；
  `%VITE_SITE_NAME%` 原样替换进 `index.html`、不做 HTML 转义，站名里不要写 `< > & "`。
- `.dockerignore` 用白名单（只放行清单、tsconfig、`vite.config.ts`、`src`）。bind mount 的 `/data` 须属 uid 1000。

静态资源：`src/runtime/node-ui.ts` 的 `createNodeUi(AIA_STATIC_DIR)` 作为 `deps.ui`：`serveStatic({ root })`，最后一段无扩展名的
路径回退 `index.html`（history 路由）；保留前缀、扩展名与缓存规则在应用内（§4.4），与 Workers 相同。反向代理不得对下载前缀做
HTTPS 跳转（AIA/CDP 客户端只走明文 HTTP）。

### 4.3 日志

一个自写的小中间件：每请求一行 JSON（method、path、status、ms），
每次发布 / 导入尝试一行（targetId 或 certificateId、outcome 或 reason、sha256；发布另有 kind、crlNumber、thisUpdate、expired、
attempts、ms、detail，字段见 `src/core/publish.ts` 的 `PublishLogRecord`；`detail` 可能引用上传的字节，截到 500 字符）。
Node 写 stdout，Workers 用 `console.log`（Workers Logs 自动收集）。只输出 JSON。不记录令牌、请求体和查询串；不记客户端 IP，
它由前面的边缘（Cloudflare）或反向代理的访问日志记录。

### 4.4 应用依赖、保留前缀与 UI 兜底（两条运行时共用）

`createApp(deps)` 返回 `OpenAPIHono`；`deps = { store, now, settings, log, sleep?, ui? }`（`sleep` 只给 catalog 条件写重试的退避，测试注入），`ui(req)` 是与平台无关的 UI 兜底
（Workers：`env.ASSETS.fetch`；Node：`serveStatic` + `index.html`）。应用不认识运行时 env；规则都在应用内，两条运行时一致：

| 请求 | 响应 |
| --- | --- |
| `/api`、`/api/*` 未命中 | JSON 信封 404 `not_found`，`no-store` |
| `/ca`、`/crl`、`/dcrl` 本身及其下未命中 | `text/plain` 404 `Not Found`，`no-store`（CryptoAPI 客户端） |
| 已注册路径、方法不符 | 405 + `Allow`：API 为信封（§7.3）；下载前缀为纯文本，`Allow: GET, HEAD` |
| 其他路径 GET / HEAD | `ui(req)`；ui 返回 404，或最后一段带扩展名（非 `.html`）而 ui 返回 HTML（SPA 兜底）→ 纯文本 404（缺失的 `/assets/x.js` 不变成 200 HTML） |
| 其他路径的其他方法；未注入 `ui` | 纯文本 404 |

- 保留前缀后须是 `/` 或路径结尾（`^/api(?:/|$)`、`^/(?:ca|crl|dcrl)(?:/|$)`）：`/crls/`、`/certificates/` 是 UI 路由，不是下载前缀；
  不带斜杠的 `/ca`、`/crl`、`/dcrl` 是下载路由（`/ca/*` 也匹配它），GET / HEAD 纯文本 404、其他方法纯文本 405。前缀与路由一样按
  原始路径匹配，不解码 `%2F`、不合并连续的 `/`。
- `secureHeaders`（§6，含 §8 的 CSP）由应用加在全部响应上，UI 响应也一样（先复制 ui 返回的响应），两条运行时的头相同。
- UI 缓存头由应用设置：`/assets/` 下最后一段带扩展名、非 HTML、状态 200 / 206 / 304 的哈希资源 → `public, max-age=31536000, immutable`，
  其余 UI 响应（`index.html`、SPA 兜底、ui 的错误状态）→ `no-cache`。先复制 ui 返回的响应再改头（workerd 绑定响应的头不可变）。
- 不注册 `app.get("*")`（会让未知路径的 POST 全变 405）；全部路由在 `createApp` 内、首个请求前注册完（SmartRouter 首个请求后冻结）。

## 5. 存储模型

### 5.1 对象布局（所有后端相同）

```text
config.json                                          操作员拥有；管理接口整体替换
catalog.json                                         服务拥有；导入与发布条件写
blobs/certificates/<sha256>.der                      不可变
blobs/crls/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber|none>-<sha256>.der   不可变；当前与历史共用
history/<targetId>/<与 blob 同名>.json                不可变；历史标记（被取代的 current、切片 7 导入的旧版本）
```

CRL 键的时间段是 `thisUpdate`（定宽，字典序即时间序），号段是十进制 CRL 号、无号时为 `none`；键只由 `crlBlobKey()`
（`src/core/history.ts`）生成。CRL Number 与 Delta 指示的内容至多 20 octet（RFC 5280 §5.2.3），更长的拒为 `invalid_crl`（`extension_value`），
所以号段至多 48 位十进制，最长的名字与 fs 适配器的临时文件 `.<名字>.<uuid>.tmp` 都远在单个名字 255 字节以内（R2 键上限 1024）。
键全部由服务生成（hex、uuid、十进制、固定名），不存在操作员命名的键，
因此不需要键编码、长度、大小写规则；三个适配器仍用 `assertStoreKey` 校验每个键（§5.4）。

### 5.2 `config.json`（操作员）

```jsonc
{
  "version": 1,
  "certificates": {
    "<sha256>": { "label": "Root CA" }
  },
  "targets": {
    "<uuid>": { "issuer": "<sha256>", "kind": "full", "label": "Issuing CA 1" },
    "<uuid>": { "issuer": "<sha256>", "kind": "delta", "label": "Issuing CA 1 delta" }
  },
  "paths": {
    "/ca/root-ca.crt": { "certificate": "<sha256>" },
    "/crl/issuing-ca-1.crl": { "target": "<uuid>" },
    "/dcrl/issuing-ca-1.crl": { "target": "<uuid>" }
  }
}
```

规则：

- 每条路径自动提供 PEM 变体 `<path>.pem`；路径表里只写 DER 路径。
- 路径必须以 `/ca/`、`/crl/`、`/dcrl/` 之一开头，且前缀与资源种类一致
  （`/ca/` → 证书，`/crl/` → full 目标，`/dcrl/` → delta 目标）。规范化后唯一。
- 被引用的证书必须已在 catalog 中；目标的签发者证书必须有 SKI；同一签发者同一 kind 只能有
  一个目标。
- 已有证书路径不能改绑到另一证书（证书下载是 `immutable` 缓存一年）：同一 `/ca/` 路径在当前 config 与新 config 中须指向同一
  证书。只与当前 config 比对，"先删再加"的两步改绑不检测，由操作员负责；更换 CA 证书用新路径。
- 已有目标不能改 `issuer` 或 `kind`；换签发者或种类用新 UUID（目标的 current 与全部 history 因此由同一张证书验证，删除保护覆盖历史，
  新鲜度不跨签发者比较；规则 V9，`src/core/admin.ts`）。
- 目标可以随时从 config 删除，删除即退役（原规则 V8 已取消，编号保留空缺）：下载、列表与上传都只认 config 里的目标，catalog 保留它
  最后的 current，作为历史与证书删除保护的依据。同一 UUID 加回 config 会重新提供删除前的 current，所以恢复发布用新 UUID。
  V9 与 V7 一样只与当前 config 比对：删掉目标后再以同一 UUID、另一签发者或种类加回不检测，由操作员负责（那样上一条的
  "同一张证书验证"与删除保护对该目标的历史不再成立）。
- 被 config 引用（`certificates`、目标的 `issuer`、路径）或作为任一目标 current 的 `verifier` 的证书不能删除（§7.2）。

### 5.3 `catalog.json`（服务）

```jsonc
{
  "version": 1,
  "certificates": {
    "<sha256>": {
      "key": "blobs/certificates/<sha256>.der",
      "size": 1234,
      "importedAt": "2026-10-17T00:00:00.000Z",
      "summary": { "subjectCN": "…", "issuerCN": "…", "serialNumber": "…", "notBefore": "…",
                   "notAfter": "…", "subjectKeyId": "…", "authorityKeyId": "…", "sha1": "…" }
    }
  },
  "targets": {
    "<uuid>": {
      "current": {
        "sha256": "…", "key": "blobs/crls/<uuid>/<thisUpdate>-<crlNumber>-<sha256>.der", "size": 4567,
        "publishedAt": "…", "verifier": "<sha256>",
        "summary": { "crlNumber": "42", "baseCrlNumber": null, "thisUpdate": "…",
                     "nextUpdate": "…", "revokedCount": 1, "sha1": "…", "nextPublish": null }
      }
    }
  }
}
```

catalog 只存当前指针，大小与资源数成正比，不随发布次数增长。历史 = `history/<uuid>/` 下的标记
（被取代的 current 原样记录，或切片 7 导入的旧版本；键名与 blob 同名，自带 `thisUpdate`、CRL 号与摘要）∪ catalog 的 `current`；
`blobs/crls/<uuid>/` 下没有标记的孤儿 blob（发布竞争失败或崩溃留下）不算历史。管理接口各 `list` 一次两个前缀即可列出，
不逐个读对象。发布写的标记体是被取代的 `current` 记录原样，不带时间（切片 7 的导入另带 `importedAt`）；发布写了
标记而 catalog 写输掉时，被标记的版本仍是 current，列历史时按版本名把标记与 current 合并成一条。标记不记取代时间：create-only 的
标记可能来自最终 `concurrent_update` 的调用，那时写下的时间之后永远改不掉；某版本被取代的时间就是取代它的那一版的 `publishedAt`。
目标从 config 删除后，catalog 里它的 current 仍在，历史照常列出与下载，只是没有条目标为 current（`src/core/history.ts`）。

格式（`src/core/catalog.ts`）：证书 id、`sha1`、key id 小写 hex（key id 与 CN 缺失为 `null`），target id
小写 UUID；`serialNumber` 大写 hex，保留 INTEGER 内容字节的前导 `00`；时间为 `toISOString()`（含 `.000Z`）；
CRL 号十进制字符串、按 BigInt 比较；`revokedCount` 是非空整数（发布时总能解析）；`nextPublish` 取 AD CS Next CRL
Publish（`1.3.6.1.4.1.311.21.4`），缺失或读不出一个 RFC 5280 时间为 `null`（它只影响 UI 的状态，不拒绝 CRL）。

### 5.4 端口与适配器

```ts
export interface ObjectStore {
  get(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  put(key: string, bytes: Uint8Array, opts?: {
    ifMatch?: string;      // 替换：当前 ETag 必须相等
    ifNoneMatch?: "*";     // 创建：键必须不存在
  }): Promise<{ ok: true; etag: string } | { ok: false; reason: "precondition-failed" }>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;   // 仅管理接口
  delete(key: string): Promise<void>;                                // 仅管理接口
}
```

ETag 对调用方不透明，只回传给同一后端；HTTP 层的 `ETag` 永远来自内容摘要，store ETag 从不外露，HTTP `If-Match` 的值也从不
传进适配器。端口、三个适配器与一致性套件在切片 1 交付（决策 11）。三个适配器的 `get` / `put` / `delete` 先调同一个
`assertStoreKey`：`/` 分段，每段 `[A-Za-z0-9_-][A-Za-z0-9._-]*`，拒绝空键、空段、`.`、`..`、点开头、绝对路径、`\`、NUL（同时是 fs 的
路径穿越防护）；`list` 先调 `assertStorePrefix`：`""` 或一个以上合法段加结尾 `/`（如 `blobs/`、`history/<uuid>/`），其余拒绝。

| 适配器 | 条件写                                                                 | ETag            | 规模    |
| ------ | ---------------------------------------------------------------------- | --------------- | ------- |
| memory | 先算摘要，再同步完成比较与写入（中间有 `await` 时并发 CAS 会双赢）；读写都复制字节 | 内容 SHA-256    | ~40 行  |
| fs     | 按键的进程内互斥段里读当前文件摘要、判条件，再 `mkdir` recursive 建键的目录、同目录临时文件 + fsync + `rename` + fsync 该目录；`list` 用递归 `readdir`，只认每段都是键段名的路径（点开头的临时文件与杂物不是键），读不了的子目录让 `list` 失败；被打断的写入留下的临时文件不清理 | 内容 SHA-256    | ~80 行  |
| r2     | `onlyIf: { etagMatches }` / `{ etagDoesNotMatch: "*" }`，返回 `null` 即前置条件失败；其他异常（含单键写速率）原样抛出；`list` 跟随游标；桶按结构化类型 `R2BucketLike` 写 | `R2Object.etag`（不带引号；带引号的 `httpEtag` 传回 `etagMatches` 会抛错） | ~60 行  |

一致性套件（缺失键、put/get、`ifNoneMatch`、`ifMatch` 成功 / 过期 / 缺失键、同一 `ifMatch` 并发 5 次
恰好一次成功、递归前缀列表、delete、非法键）对 memory 与 fs 每次运行；r2 在 `AIA_TEST_R2=1`（`pnpm run test:r2`，
`ci:worker` 包含它且要求 passed）下经 `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 运行，结束时
`await dispose()`。

### 5.5 写入顺序

`publishCrl(deps, bytes)`，入口取一次 `deps.now()` 作本次的时间快照（与 `importCertificate` 同形），与 HTTP 无关：

1. 按字节识别 PEM/DER，得到 DER 与 `sha256`。
2. 读 `config.json` 与 `catalog.json`（各一次 `get`，记下 catalog 的 ETag）。`sha256` 等于某个已配置目标的 `current.sha256` →
   200 `unchanged`，不解析、不验签、不写。
3. 头部：外层 SEQUENCE 须是定长 DER 且恰好覆盖全部字节（否则 `der` / `trailing_bytes`）；TBSCertList 里的吊销列表只按它的 TLV
   头切出、不解码，其余字段拼回后解析（asn1js 默认限额，未签名部分须为严格 DER，读出的字段须与切分一致）。读出 AKI、CRL 号、delta 指示与
   时间，再做 CRL 级检查：外层算法与 TBS 内的字节不同、`thisUpdate` 超前 5 分钟以上、未识别的关键扩展、作用域 IDP，各是独立
   拒绝原因。每次调用至多做一次。
4. 用 AKI 在 catalog 的证书摘要里找 SKI 相等的证书，再在 config 里找绑定它且 kind 匹配的目标。
   无 AKI `keyIdentifier` 或找不到证书是 `issuer_not_found`，证书存在但无目标是 `target_not_configured`；两个匹配目标只会来自绕过
   规则 V6 手写的 config，按服务端故障 500。
5. 读签发者 DER（按已知键），用目标配置的签发者对收到的原始 TBSCertList（含吊销列表）验签（同 SKI 的续期证书不影响选择）。
6. 与 `targets[id].current` 比较：按 catalog 里的 `crlNumber` / `thisUpdate` 摘要判新鲜度，不必再读当前 DER；`stale_crl`、`conflict`、
   `non_orderable` 到此结束。
7. 只有将成为 `created` / `updated` 的 CRL 才完整解码（吊销条目逐条解码，各用 asn1js 默认限额，嵌套深度仍从 CRL 算起），
   检查吊销条目的扩展，生成带 `revokedCount` 的摘要。每次调用至多做一次。
8. `put` blob（内容寻址，`ifNoneMatch: "*"`，已存在即视为成功，幂等）。
9. 若有旧 `current`，先 create-only 写它的 history 标记（§5.1）；再 `put catalog.json` 带 `ifMatch` 更新 `current`。
   失败则重读 config 与 catalog 回到第 2 步（重新找目标并验签），重试三次（共 4 次尝试，250 ms、500 ms、
   1 s 退避），之后返回 `concurrent_update`。
10. 返回 `created`（之前无 current）或 `updated`。

`AIA_MAX_UPLOAD_BYTES` 限制请求体（读体前按 `Content-Length` 拒绝，流式体逐块计数），因而也限制能发布的 CRL 的大小：完整解码只落在
已验签的 CRL（第 7 步）上，未验签的上传最多花去缓冲请求体、一次哈希、头部解码与一次验签。工具本身不做限速，
限速交给前面的平台（Cloudflare、反向代理）。大 CRL 的实测见 `docs/operations.md`"容量"。

第 8 步后崩溃只留下一个无人引用、不进历史的 blob，无害；第 9 步 catalog 写成功即完成，不存在"权威写成功但
派生写失败"的状态。第 1–7 步的拒绝与 `unchanged` 零写入；输掉的竞争只留下本次 blob 与旧 current 的标记（§5.3）。R2 对单键每秒一次写
的限制只落在 `catalog.json` 上：超限报错不是前置条件失败，服务端不重试（500），AD CS 助手顺序上传并按 `-UploadIntervalMs` 间隔。

config 与 catalog 是两个对象，catalog 的条件写不覆盖 config。每次尝试都重读两者再解析目标，剩下的窗口是发布读到 config 之后、
catalog 写成功之前目标被删（`config apply`）：catalog 会留下 config 里已没有的目标的 current（无路径引用、不可下载，与删除目标后
的状态相同）。删除证书在 catalog 的同一次条件写里检查引用（config 与 catalog 的 `verifier`），与发布的竞争由这次条件写排除；与
`config apply` 交错（apply 读到证书仍在，随后证书被删）不复核也不补偿。不为这些加跨对象锁：管理操作（导入、改配置、删除证书）单人
串行，删目标前先停该 CA 的发布任务。

`importCertificate` 同理：解析、生成完整摘要、写 blob、条件更新 catalog；重复导入 `unchanged`。
`applyConfig` 校验 §5.2 规则后用 `ifMatch` 替换 `config.json`，首次用 `ifNoneMatch: "*"`；只写 `config.json`，不写 catalog，
状态规则按开头读到的 catalog 判定、不重查。

### 5.6 读取

公开读路由每个请求各 `get` 一次 `config.json` 与 `catalog.json`（两个小对象），`/blobs/{sha256}` 再读它的一个 blob；列表不读 blob，
也不 `list`。服务端不为读取解码证书或 CRL：详情页取 DER 在浏览器里解码（§8）。config / catalog 指向的东西撑不住（blob 缺失、目标的签发者不在 catalog）→ 普通 500
（日志里是 `unhandled_error`）；config / catalog 无效或 store 抛错也是 500，绝不当作空列表或 404。
进程内按 ETag 备忘、5 秒 TTL 是唯一允许的优化，默认关闭，切片 5a 实测后不开：两份对象的读取与解析在亚毫秒级（夹具部署 memory
约 0.05 ms、fs 约 0.3 ms，放大 20 倍约 1 ms）；R2 的真实延迟在切片 7 演练 B 再看。写路径永远直读，不经备忘。

## 6. 领域规则

- 身份：证书 `certificateId` = DER 的 SHA-256；CRL 目标 `targetId` = 创建时分配的 UUID；
  内容版本 = `contentSha256`。CN、文件名不参与身份、授权和路径。
- 验证：AKI/SKI 匹配 + 签名验证。CRL 没有 AKI `keyIdentifier` → `issuer_not_found`（`details.reason = "missing_aki"`）；
  keyIdentifier 为空也找不到证书（导入拒绝空 SKI）→ `issuer_not_found`；
  外层 `signatureAlgorithm` 与 TBS 内 `signature` 收到的字节不同（OID 或参数）→ `invalid_crl`（`signature_algorithm_mismatch`；
  比较收到的字节而不是重编码，外层不在签名之内）。
  校验范围：验签通过的 CRL 一定出自 CA，TBS 里写了什么是 CA 的事；本服务只查签名覆盖不到、任何人都能改的部分（外层 SEQUENCE、
  `signatureAlgorithm`、`signatureValue` 须为严格 DER：标签与长度是 DER 形式、需要内容的类型不为空；外层算法与签名内的一致；
  ECDSA 签名为 DER），自己依赖的字段（AKI、CRL 号、`thisUpdate`、IDP 作用域）能否读出，以及常见配置问题（时钟）。TBS 内部与
  吊销条目只要求能解码（asn1js 无解码错误），不查 DER 形式与 RFC 5280 时间格式，也不下钻扩展值。证书只由管理员导入，同样只要求能
  解码、读得出摘要字段，不比较外层算法。所以没有人能改写 CRL 的未签名部分造出先成为 current 的变体。ECDSA 签名本身可延展：`(r, n − s)` 是另一份 OpenSSL 也验得过的合法 CRL，
  谁先上传谁成为 current，CA 的原始字节随后得 `conflict`（只是 409 的麻烦，不是完整性问题）。上传按目标配置的签发者验签，同 SKI 的
  其他证书不参与。不比较签发者名称、不检查 `cRLSign` 和签发者有效期。
  验签方式（B21）：先过 CRL 级的扩展与时钟策略，再在任何密码学调用之前按 OID 白名单判定：sha1/256/384/512WithRSAEncryption、RSASSA-PSS
  （参数是 SEQUENCE、哈希是这四种之一；其余字段在签名之内，只有 CA 能写错）、ecdsa-with-SHA1/256/384/512（签发者曲线 P-256 / P-384 / P-521）；
  SHA-1 接受（分发服务不是校验器）；名单外（Ed25519 / Ed448、SHA-224、DSA、SM2、MD5 等）→ `unsupported_algorithm`。参数与签名值
  同样先查：PKCS#1 v1.5 / ECDSA 的参数须缺省或 NULL，PSS 参数不合上述条件、`id-RSASSA-PSS` 受限密钥、名单外曲线或显式曲线参数 →
  `unsupported_algorithm`；签名族与签发者密钥不符、BIT STRING 有未用位、ECDSA 签名不是严格 DER → `invalid_signature`（PKIjs 会放过
  非严格 DER 的 ECDSA 签名）。最后对收到的 TBS 字节调
  `pkijs.getCrypto(true).verifyWithPublicKey(tbsView, signatureValue, issuerSpki, signatureAlgorithm)`。不用 PKIjs
  `crl.verify()`：它比较签发者名称，并对其自有名单外的关键扩展静默返回 false；
  不调 `pkijs.setEngine`（pkijs 从 `globalThis.crypto` 自动初始化）。细则见 `src/core/pki/verify.ts`。
- 新鲜度：先比字节（与某个已配置目标的 current 相等 → `unchanged`，§5.5 第 2 步），再比 CRL 号，再比 `thisUpdate`；号相等且
  `thisUpdate` 相等但字节不同 → `conflict`；CRL 号只在一侧存在 → `non_orderable`；更旧 → `stale_crl`。号按 BigInt、时间按 epoch ms
  比较（不比字符串）；同号而 `thisUpdate` 更晚 → `updated`，两侧都无号只比 `thisUpdate`；`nextUpdate` 不参与；full 与 delta 目标各比各的
  （AD CS 两者共用一个号计数器）；只读 catalog 的 `current.summary`，不读当前 DER（`compareFreshness`，`src/core/publish.ts`）。
- 时钟：注入的 `now` 是唯一时间源；`thisUpdate` 超前 5 分钟以上拒绝 `not_yet_valid`（恰好 5 分钟接受）；
  `nextUpdate` 已过去的 CRL 接受并记录日志。
- 扩展详情（浏览器端，`src/web/x509/extensions.ts`）仅用于展示，不重复执行上传准入校验：优先使用 PKIjs 模型；不再统一拒绝 BER 编码、空 GeneralNames 列表或额外字段，按具体展示解码器读取。
  仍要求值恰好占满输入，避免只显示前缀；保留整数精度、有效时间和 SCT 完整性检查，无法可靠读取时显示原始 hex / ASN.1。
  名称约束、分发点原因位、CA Version 等存在已复现库缺陷的结构继续使用小型读取器；展示 CRL Number 不套用上传的非负与 20 字节限制。
- 扩展：只读服务自己用到的几个（CRL 号、delta 指示、AKI、AD CS Next CRL Publish、IDP），其余扩展不论是否关键都接受，原始字节
  留在 blob 里并在详情中展示（关键扩展该怎么处理是依赖方的事）。`2.5.29.28`（IDP）不论关键性都读：
  只含 `distributionPoint` 接受（AD CS 的 CDP 选项），含其他任何字段（`onlyContains*`、`onlySomeReasons`、`indirectCRL`）即作用域 CRL，
  拒绝 `scoped_crl_unsupported`；值不是 SEQUENCE 才是 `invalid_crl`。同一扩展出现两次不拒绝，读取时取第一个。
  条目扩展在验签之后、完整解码时检查（§5.5 第 7 步）：只有 certificateIssuer（间接 CRL）→ `scoped_crl_unsupported`。
  策略表见 `src/core/pki/crl-policy.ts`。
- delta 与 base 相互独立：记录并展示 `baseCrlNumber`，不与已发布 full CRL 对账。
- 下载：路径表命中 → 资源 → catalog 的 current → 先用摘要生成 `ETag`（DER `"<sha256>"`，
  PEM `"<sha256>-pem"`）→ `If-None-Match` 命中直接 304、HEAD 直接回头（都不读 blob）→ 否则读 blob，DER 原样、PEM 现场派生。
  `If-None-Match` 手写比较（逗号列表、`W/`、`*`），在读 blob 之前；不用 `hono/etag`（它在处理器之后比较）。
  `Content-Length` 显式设置（两条运行时的 HEAD 都不会自动带）。目标存在但未发布 → 404。
  下载前缀上的 404 / 405 是纯文本（§4.4）。路径表命中而存储撑不住（引用失效、blob 缺失）→ 普通 500，不报 404。
  `Content-Disposition: attachment; filename="<路径最后一段>"`，原样写入（路径来自 config，V2 只允许 `[A-Za-z0-9._~-]`）；`Last-Modified` 取 `importedAt` /
  `publishedAt`，不评估 `If-Modified-Since`。
- 内容类型：DER 证书 `application/pkix-cert`，DER CRL `application/pkix-crl`，
  PEM `application/x-pem-file`。
- 缓存：证书 `public, max-age=31536000, immutable`；CRL `public, max-age=clamp(nextUpdate − now,
  60 s, 3600 s), must-revalidate`，无 `nextUpdate` 时 300 s；API JSON `no-store`；
  `openapi.json` `max-age=300`；UI 哈希资源 `immutable`，`index.html` `no-cache`（两条运行时都由应用设置，§4.4）。
- 安全头：`secureHeaders({ strictTransportSecurity: false })`，其余 Hono 默认（`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: SAMEORIGIN`、`Cross-Origin-Resource-Policy: same-origin` 等）落在全部响应上。不发 HSTS：应用不知道自己是否
  在 TLS 之后，AIA/CDP 下载按设计走明文 HTTP，HSTS 留给 Cloudflare / 反向代理决定。另加 UI 的 `Content-Security-Policy`（§8），
  同样落在全部响应上，对 JSON 与下载没有作用。
- 退役：从 config 删除目标与它的路径。路径 404，列表与详情不再有它，上传按 `target_not_configured` 拒绝；历史 blob 与标记保留，
  仍可经管理接口列出与下载。恢复发布用新 UUID（§5.2）。目标当前 CRL 的验证者证书不可删除，目标删除后也一样（§5.2）。
- 上传安全：`bodyLimit` 永远开；可选 `AIA_UPLOAD_TOKEN`；未验签的字节不完整解码（§5.5）。工具本身不做限速，限速交给前面的平台
  （Cloudflare、反向代理），文档写明。

## 7. HTTP API v1

### 7.1 公开路由

| 方法与路径                        | 用途                                                   | 状态                                                    |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `GET /api/v1/health`              | `{ status, checks: { store, configuration } }`：`status` healthy / degraded / unhealthy；`store` ok / error；`configuration` ok / missing / invalid（store 出错时 unknown）；`no-store`。`invalid` = `config.json` 或 `catalog.json` 不是 JSON 或不合 schema（config 的其余规则只在 apply 时检查，health 不重跑） | 200（含 degraded：配置缺失或无效）；store 抛错 503 unhealthy |
| `GET /api/v1/certificates`        | 完整数组（无分页），按 id 排序；每项 `{ id, label, importedAt, size, summary, downloads, targets }`：`label` 来自 config（未配置为 `null`），`summary` 是 catalog 的证书摘要，`targets` 是以它为签发者的 `{ targetId, kind, label }` | 200 / 500 |
| `GET /api/v1/crls`                | 每个 config 目标一项，按 `targetId` 排序：`{ targetId, kind, label, issuer: { id, label, subjectCN }, downloads, current }`，`current` 为 `{ sha256, size, publishedAt, verifier, summary }`（`summary` 含 `nextPublish`）或 `null` | 200 / 500 |
| `GET /api/v1/blobs/{sha256}`      | catalog 证书（`sha256` 即其 id）或 config 目标的 current CRL 的 DER，原样返回（`application/pkix-cert` / `application/pkix-crl`），`public, max-age=31536000, immutable`；历史版本与 config 已删目标的 current 不在此列（404）；`sha256` 为 64 位 hex，大写规范化。详情页的其余字段都从它在浏览器里解码 | 200 / 400 / 404 / 500 |
| `POST /api/v1/crls`               | 上传 CRL：原始请求体（`application/pkix-crl` / `application/x-pem-file` / `application/octet-stream`），不收 multipart | 201 created；200 updated / unchanged；400 / 401 / 409 / 413 / 415 / 422 / 500 |
| `GET /api/v1/openapi.json`        | 运行时从路由表生成（`getOpenAPI31Document`），按进程 / isolate 缓存；与提交的 `docs/openapi.json` 一致（§7.3） | 200，`public, max-age=300`               |

上传成功体：

```json
{ "outcome": "created", "target": "<uuid>", "kind": "full", "sha256": "…",
  "crlNumber": "42", "baseCrlNumber": null, "thisUpdate": "…", "nextUpdate": "…",
  "issuer": "<sha256>",
  "downloads": ["/crl/issuing-ca-1.crl", "/crl/issuing-ca-1.crl.pem"] }
```

`thisUpdate` 必填、`nextUpdate` 可空；`issuer` 是目标配置的签发者证书 id；200 与 201 是同一个 schema；字节与 current 相同的 200 `unchanged`
不解析、不验签（§5.5 第 2 步）。媒体类型忽略参数与
大小写，内容一律按字节识别（DER 或一个 X509 CRL PEM 块）。失败的状态与 `details`：

| 状态 | 码与 `details` |
| --- | --- |
| 400 | `bad_request`：空体，畸形 `Authorization`（B9） |
| 401 | `unauthorized` + `WWW-Authenticate`（只在设了 `AIA_UPLOAD_TOKEN` 时） |
| 409 | `stale_crl`、`conflict`、`non_orderable`：`{ current: { sha256, crlNumber, thisUpdate } }`；`concurrent_update`：无 |
| 413 | `payload_too_large`（`AIA_MAX_UPLOAD_BYTES`，无 `Content-Length` 的流式体也算） |
| 415 | `unsupported_media_type`：`{ received, accepted }`，`received` 为小写、不带参数的媒体类型，缺失或空头为 `null` |
| 422 | `invalid_crl` `{ reason }`；`not_yet_valid` `{ thisUpdate }`；`scoped_crl_unsupported` `{ oid, serialNumber? }`（序列号只对条目扩展）；`issuer_not_found` `{ reason: "missing_aki" }` 或 `{ authorityKeyId }`；`target_not_configured` `{ kind, certificates }`；`invalid_signature`、`unsupported_algorithm` `{ algorithm }` |
| 500 | `internal`，不含异常文本（OpenAPI 里上传与五条公开读路由声明 500，管理路由不声明） |

OpenAPI 的 `security` 为 `[{}, { uploadBearer: [] }]`：令牌可选。

### 7.2 管理路由（`Authorization: Bearer <AIA_ADMIN_TOKEN>`）

| 方法与路径                                            | 用途                                            | 状态                        |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| `POST /api/v1/admin/certificates`                     | 导入证书（PEM/DER，原始请求体）                   | 201 created / 200 unchanged / 422 |
| `DELETE /api/v1/admin/certificates/{id}`              | 删除未被引用的证书（blob 一并删除）；引用来源见 §5.2，列在 `details.references`（`{ object, path }`） | 204 / 404 / 409 `referenced` 或 `concurrent_update` |
| `GET /api/v1/admin/config`                            | 当前 `config.json` 与 `ETag`                     | 200 / 404（尚未配置）       |
| `PUT /api/v1/admin/config`                            | 整体替换；`If-Match` 与首次的 `If-None-Match: *` 恰好一个；请求体不合 schema 直接 422（V1），不先查前置条件 | 200 / 412 / 422 `config_invalid` / 428 `precondition_required`（缺可用前置条件） |
| `GET /api/v1/admin/crls/{targetId}/history`           | `{ targetId, configured, entries }`：历史条目（history 标记 ∪ current，§5.3；thisUpdate、CRL 号、sha256、size、是否 current），新的在前；已从 config 删除的目标 `configured: false` | 200 / 404（不在 config 且没有历史） |
| `GET /api/v1/admin/crls/{targetId}/history/{sha256}`  | 下载一条历史的 DER（`application/pkix-crl`，`attachment; filename="<sha256>.crl"`，原样返回，不重算摘要） | 200 / 404                   |

未设置 `AIA_ADMIN_TOKEN` 时全部管理路由返回 503 `admin_disabled`（先于鉴权与读体）。令牌比较用 Hono
`bearerAuth`（常量时间）：令牌缺失或错误 → 401 + `WWW-Authenticate`；`Authorization` 头畸形时 `bearerAuth` 回 400，统一包成
`bad_request` 信封。因此每条管理路由的状态表另含 400 / 401 / 503，上传路由在设置 `AIA_UPLOAD_TOKEN` 时同样有 400 / 401（B9）。

### 7.3 信封、错误、中间件

- 成功：直接返回资源体，不包 `{ data }`。
- 失败：`{ "error": { "code": "…", "message": "…", "details"?: … } }`，共用一个 `ErrorResponse` schema；HTTP 状态码在抛错处明确指定，`code` 和 `details` 不再按状态码细分 schema。
- 错误码：`bad_request`、`unauthorized`、`not_found`、`method_not_allowed`、
  `payload_too_large`、`unsupported_media_type`、`admin_disabled`、`precondition_failed`、`precondition_required`、
  `config_invalid`、`referenced`、`invalid_crl`、`invalid_certificate`、`not_yet_valid`、
  `scoped_crl_unsupported`、`unsupported_algorithm`、
  `issuer_not_found`、`target_not_configured`、`invalid_signature`、
  `stale_crl`、`conflict`、`non_orderable`、`concurrent_update`、`internal`。`details.reason`：`invalid_certificate` / `invalid_crl` 为 `der`、`trailing_bytes`、
  `time`、`structure`、`extension_value`、`pem_label`、`pem_blocks`、`pem_base64`，`invalid_crl` 另有 `signature_algorithm_mismatch`；
  `issuer_not_found` 为 `missing_aki`（否则 `details.authorityKeyId`）。
- 中间件顺序：`secureHeaders({ strictTransportSecurity: false })`（§6）→ 请求日志 →
  `methodNotAllowed({ app, onMethodNotAllowed })`（`hono/method-not-allowed`，hono ≥ 4.13.0；`onMethodNotAllowed` 产出
  `method_not_allowed` 信封 + `Allow`，GET 路由自动含 HEAD；下载前缀为纯文本，§4.4）→
  `/api/v1/admin/*` 的 `bearerAuth` → `POST /api/v1/crls` 的路由级 middleware（可选 `bearerAuth` → 媒体类型闸 → `bodyLimit`，都在
  zod-openapi 的校验器之前，匿名或类型不符的上传不读体）→
  路由 → `app.onError` 统一 500 信封，不泄漏异常文本。`bearerAuth`、`bodyLimit` 等抛出的 `HTTPException` 由 `onError` 换成
  信封（库文本换成自己的文案，保留 `bearerAuth` 的 `WWW-Authenticate`）。处理器抛错时日志依次是该操作自己的一行（如
  `publish` 的 `reason: "internal"`）→ `unhandled_error` → `request`。
- OpenAPI（B11）：`GET /api/v1/openapi.json` 在运行时由路由表生成（`getOpenAPI31Document`），每个 app 实例首次请求时序列化并缓存，
  `max-age=300`。提交的 `docs/openapi.json` 是它的文件快照，漂移检查只有一处：`tests/http/openapi.test.ts` 用
  `toMatchFileSnapshot` 比对运行时文档（两空格缩进、末尾换行）与该文件，改了路由就 `pnpm run openapi`（只对这个文件跑
  `vitest -u`）重新生成并提交。服务端不读该文件：从 `src` 导入它会越出 `rootDir: src`，Node 产物与 Worker 包都找不到。

### 7.4 CLI

`aia` 读取 `AIA_URL` 与当前命令的令牌：管理命令用 `AIA_ADMIN_TOKEN(_FILE)`，`publish` 用 `AIA_UPLOAD_TOKEN(_FILE)`（可无，服务端只在
设了令牌时要求）；`--token-file` 优先于两个变量，指当前命令的令牌。令牌只经 `https://` 发送，或经 `http://` 发往回环主机（`localhost`、
`127.0.0.0/8`、`[::1]`：Docker exec 与开发）；带令牌而 URL 是其他主机的 `http://` 是用法错误（退出 2，不发任何请求），除非加
`--allow-insecure-http`（对应助手的 `-AllowInsecureHttp`）：生产主机为 AIA/CDP 下载提供明文 HTTP 且不跳转，`AIA_URL=http://<主机>`
能连上服务并把令牌明文发出。不带令牌的命令（`health`、服务端未设令牌时的 `publish`）不检查。子命令：
`import <file...>`、`config show | validate <file> | apply <file>`、`new-target-id`（打印
`crypto.randomUUID()`：目标 UUID 由工具分配，没有建目标接口）、`publish <file...>`
（走公开上传路由，逐个文件发原始体，`Content-Type: application/octet-stream`，服务端按字节识别；created / updated / unchanged
之外都算该文件失败）、`history <targetId>`（列历史）、`history <targetId> <sha256> --out <file>`（把一条历史的 DER 写进文件）、
`delete-certificate <id>`（被引用时逐行列出引用来源，退出 1）、`health`。`config validate` 离线只跑静态规则（V1–V3、V4 / V6 的静态部分，
与服务端共用不带 context 的 `validateConfig`），不连服务、不要令牌；状态与迁移规则（V4–V7、V9 的其余部分）由服务端在
apply 时判定，以服务端为准。参数解析、子命令分发、参数数量检查和帮助由 `commander` 的命令树生成；每次 `main()` 新建实例，
输出与退出处理可注入，不在库内终止进程。`createClient` 按命令解析 URL 与令牌，保留代理路径前缀，统一认证头、超时、响应读取和错误处理；
命令只提供 `/api/v1` 下的相对路径。批量上传按文件和 PEM 块顺序发送，失败不中断后续项，边处理边累计统计；文本模式逐项输出，
只有 `--json` 保存完整结果数组。输出为每个文件（块）一行加汇总行，或 `--json`；退出码 0 成功、1 失败（或服务不健康）、2 用法错误。

## 8. 前端

owner 已确认（决策 5、12）：Vue 3 + Tailwind 4 加组件库。

- 基座：`vue-router`（history 模式）；`@tanstack/vue-query`（列表 `useQuery`，`staleTime: 0`，4xx 不重试、5xx 与网络失败重试一次；DER 不会变，`staleTime: Infinity`，可走浏览器缓存；
  上传 `useMutation` 成功后先 `cancelQueries` 再全量 `invalidateQueries`）；shadcn-vue 生成的组件（Reka UI 原语，`--style nova`、
  base color `neutral`，源码在 `src/web/components/ui/`，生成代码用 `cn`）；`@vueuse/core`（`useNow`、`useStorage`；
  复制走 `src/web/utils/clipboard.ts`：Clipboard API，退回 `execCommand("copy")` 并检查其结果，都不行给 toast）；
  `vue-sonner`（复制失败的 toast，顶部居中，`src/web/main.ts` 需 `import "vue-sonner/style.css"`）；
  `@lucide/vue`（取代已弃用的 `lucide-vue-next`）；`tw-animate-css`。不用 Pinia：服务端数据归 vue-query，UI 偏好归 `useStorage`。
  浏览器包全部是 devDependencies（§2）。
- 路由：`/`（总览）、`/certificates/:id`（小写 64 位 hex）、`/crls/:targetId`（小写 UUID），区分大小写；其余路径与格式不符的 id 进
  NotFound 页，不发请求。详情页懒加载；`document.title` = `<页面> · <站名>`。链接打开的页面从顶部开始，前进 / 后退回到
  原滚动位置。未知 UI 路径由 §4.4 的 UI 兜底返回应用（Workers `not_found_handling: "single-page-application"`，Node 回退
  `index.html`）；保留前缀与末段带扩展名的路径不兜底。
- 总览：统计条五格，都由客户端从两个列表算——证书数、CRL 目标数（full / delta）、已发布数、吊销条目（已发布 full CRL 的合计，没有时
  "未知"）、需关注（stale + expired + unknown 的目标数，按徽标的同一时钟与规则算）；证书表（显示名 = 标签 ?? 主体 CN、
  签发者、有效期与剩余时间、状态、DER / PEM 下载，按显示名排序）；CRL 目标表（标签与签发者、类别徽标（证书蓝、full 紫、delta 绿）、
  CRL 号、thisUpdate – nextUpdate、吊销数、状态、下载；未发布显示"未发布"、吊销数 "—"；按标签排序，同名 full 在前）；上传卡片
  （拖放、选择文件或粘贴 PEM，都经 hc 的 `$post` 把文件作为原始请求体（`init.body`）发送，`Content-Type: application/octet-stream`，服务端按字节识别；created / updated / unchanged 是三句成功文案，附 CRL 号与下载路径；
  错误按 `error.code` 映射 i18n，带 `details.reason` 时附原因，显示为行内 Alert；可选上传令牌只存内存，`unauthorized` 时自动展开）。
  骨架屏只在首次加载显示。手机宽度（`sm` 以下）两张表只显示名称 / 标签、类别与状态，其余列在详情页。
- 状态规则（徽标、相对时间与"需关注"共用一个每分钟一跳的 `useNow` 时钟；owner 确认，附录 C 切片 5b 第 2 项）：
  证书 `not-yet-valid`、`valid`、`expiring`（剩余不足有效期的 10%：根 20 年 → 2 年，签发 CA 10 年 → 1 年；`now == notAfter` 仍在有效期内）、
  `expired`；CRL 目标 `unpublished`（无 current）、`unknown`（无 nextUpdate）、`not-yet-valid`（now < thisUpdate：服务端拒收超前 5 分钟以上的
  thisUpdate（§6），所以只在浏览器时钟落后于服务端或在那 5 分钟内出现；不计入"需关注"）、`expired`（now > nextUpdate）、`stale`（带 AD CS
  Next CRL Publish 时 now 超过它 1 h；不带时（如离线 OpenSSL 根 CRL）thisUpdate → nextUpdate 剩余不足 20%）、否则 `current`。证书与 CRL
  的日期颠倒（notAfter < notBefore、nextUpdate ≤ thisUpdate）是 `unknown`，从不显示为有效；catalog 保证日期本身合法，不再另判缺失或无法解析。
- 详情：页面取列表（catalog 事实：标签、导入 / 发布时间、大小、文件指纹、下载路径、目标链接）与 `/blobs/{sha256}` 的 DER，DER 在浏览器里
  用 core/pki 的解析器（`parseCertificate` / `parseCRL`，asn1js + PKIjs，随第一个详情懒加载）解码，再由 `src/web/x509/` 直接映射成显示行，
  没有中间 JSON 投影；列表里没有这个 id 显示"不存在"，DER 解不开显示"不是有效的证书 / CRL"。证书页 Tabs = 概览（主体 / 签发者 DN 表含
  `rfc4514`、有效期、序列号、公钥摘要、签名算法含参数与签名值 hex、文件指纹、unique ID、它作为签发者的 CRL 目标链接）/ 扩展 / PEM（有
  `.pem` 路径时）。CRL 目标页头 = 标签、类别、状态、签发者链接、下载；Tabs = 概览（CRL 号与 base 号、thisUpdate / nextUpdate / Next CRL
  Publish、算法、指纹、签发者 DN）/ 吊销列表 / 扩展；未发布目标（`current: null`）只有页头与"未发布"，不取 DER，不显示 0 或"未知"。
  扩展是 Accordion（关键在前）：每个已知 OID 的值解码成若干区段（`src/web/x509/extensions.ts`，41 种；分发点、策略、SCT 这类重复元素
  各占一段），每段是一张标签 / 值表，值只有文本、十六进制、等宽行、标签四种，各由 `ValueView` 用一种样式画出，概览页的表也用它；
  未识别或解码失败显示解析错误、ASN.1 结构 dump 与原始 hex。吊销列表：序列号、吊销时间、原因、失效起始；有条目扩展的行
  可展开，用同一个扩展 Accordion 列出全部条目扩展（保留指令、关键标记、未解码的扩展）；表头吸顶，超过 200 行按 200 行一页 `slice()`
  分页，0 条显示空状态（不用 `@tanstack/vue-table`）。
- 客户端：`const api = hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch })`，vue-query 的 `queryFn` 写
  `unwrap(await api…$get(…))`：2xx 返回 hc 推断类型的体，否则抛 `ApiError { code, message, status, details }`（v1 信封的码；非 JSON 或
  非信封为 `invalid_response`；拿不到响应为 `network`、`status: 0`，由 `apiFetch` 产出）；响应体类型从 `src/web/client/types.ts` 取；错误码显示 `errors.<code>` 的文案（vue-i18n 的 `te()` 判断有无，没有则 `errors.unknown`），
  每个服务端码都有文案由 tests/web/locales.test.ts 检查。客户端目录是 `src/web/client/`：
  Vite `root: src/web` 时 dev server 会把 `src/web` 下的目录当 URL 服务，叫 `api` 会与 `/api/` 冲突（`ca`、`crl`、`dcrl` 同理）。
  web 从服务端导入的值只有 core/pki（解析器、DER 读取、扩展读取与算法名称表）和 core/digest.ts，其余只许 `import type`（`AppType`）；
  Hono 只导入 `hono/client`（ESLint 规则，§3）。
- 下载链接来自 API 的 `downloads`（`.pem` 结尾标 PEM，其余 DER；多条 DER 路径时另显示文件名）；未发布目标的路径在发布前是 404，
  不给链接（"—"）。
- `SITE_NAME` 只来自 `import.meta.env.VITE_SITE_NAME`（页头与页面标题）；页脚是 OpenAPI 文档链接与语言选择。
- i18n：`en` 与 `zh-CN`（完整翻译）；语言取存储的选择（`locale-preference`）→ 浏览器语言中第一个受支持的 → `en`，可切换并记住，
  `<html lang>` 跟随。亮 / 暗只跟随系统（`prefers-color-scheme`，纯 CSS，没有切换按钮与内联脚本）。
- CSP：`secureHeaders` 的 `contentSecurityPolicy`，同一个 app 下发，两条运行时一致：
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`，没有 `'unsafe-inline'` 与 `'unsafe-eval'`（组件经 CSSOM
  设样式，vue-i18n 11 不用 eval）。
- 不设 UI 体积预算。
- 构建到 `dist/web`（Vite `root: src/web`、`build.outDir` = `<repo>/dist/web`、`envDir` = 仓库根），两条运行时都从这里提供。
  dev 代理键用锚定正则 `^/(?:api|ca|crl|dcrl)/`（字符串键 `/crl` 会吞掉 SPA 路由 `/crls/`）。
- shadcn-vue 在切片 1 初始化：`pnpm dlx shadcn-vue@2.8.2 init --base reka --style nova --icon-library lucide --base-color neutral
  --font inter --yes --no-rtl --no-pointer`（永不用 `--defaults`，它等于 `--preset nova --template nuxt`），之后删掉 `main.css` 的
  Google Fonts `@import` 与 `components.json` 的 `font` 键；`components.json`、生成文件与 lockfile 一并入库（registry 是线上的，
  重跑 `add` 可能得到不同代码），生成代码按仓库 Prettier 风格重排；`add` 生成的 `index.ts` 再导出全部部件，没用上的删掉（否则 knip 报未用导出）。
  web spike 用 `vega` 风格验证过 init + Vite 8 + Tailwind 4.3，`nova` 在切片 1 首次生成。nova 组件的 `data-open:`、`data-active:` 等状态变体
  定义在 shadcn-vue 包自带的 CSS 里，CLI 不导入它，`main.css` 抄了其中用到的 5 个 `@custom-variant`。

## 9. AD CS 助手

`scripts/adcs-crl-uploader.ps1` 要点（安装、计划任务与 Windows 验证记录见 `docs/operations.md`）：
仅 PowerShell 7；按字节识别（首字节 `0x30` → `application/pkix-crl`，含 X509 CRL PEM 块 → `application/x-pem-file`，都不是即失败、
不上传），`Invoke-RestMethod -Method Post -Body <bytes> -SkipHttpErrorCheck` 发原始体，不按扩展名判格式、
不调 `certutil`；`-UploadTokenFile`（令牌从受保护文件读，不进任务命令行与日志；带令牌而 URI 为 `http://` 时拒绝，除非
`-AllowInsecureHttp`）；按 `outcome` / `error.code` 判定，created / updated / unchanged 都算成功；本地账本 `published.json`（文件路径 →
被接受字节的 sha256，连同接受它们的 `-UploadUri`）跳过已发布文件，缺失、损坏或属于另一个 URI 时按空处理（同一 URI 上恢复或回滚服务后
删除它）；网络与 TLS 错误记整条异常链；从未被接受的文件返回 `stale_crl` 算失败（CA 产出了比已发布更旧的东西）；
以 `FileShare.Read` 读、`IOException` 重试（CA 可能正在写）；两次上传之间隔 `-UploadIntervalMs`（R2 单键写速率，§5.5）；单文件失败
不影响其余；SourceDir 或令牌文件缺失在任何上传之前退出 1；退出码 0 / 1；事件 68/69/70 触发与定时补扫不变（`MultipleInstances IgnoreNew`）。
2026-10-20 用 Windows 上的 PowerShell 7.6 对本机 Node 服务手动验证过（不是真实 CA）；生产 CA 上的运行在切换时验证（§12）。

## 10. 测试与 CI

布局与夹具规则见 implementation 总则 §2.5（B15、B16、决策 13），脚本见 `package.json`。检查只用常规的一套（决策 15）。

- 类型：`pnpm run typecheck` = `wrangler types` 后 `vue-tsc -b`，按 `tsconfig.json` 的 references 检查 worker、node、web 三个程序，
  一次报出全部错误；各程序 `noEmit`，`.tsbuildinfo` 写到 `node_modules/.tmp`。
- Lint 与格式：ESLint 常规预设（`@eslint/js`、`typescript-eslint`、`eslint-plugin-vue`），另加一条导入规则：`src/web` 对 `src/core`、`src/http`、
  `src/storage`、`src/runtime` 只许 `import type`（`src/core/pki` 与 `src/core/digest.ts` 除外），Hono 只许 `hono/client`；`prettier --check`。
- 未用代码：knip（`knip.json`，默认模式，测试也算入口）报未用的文件、导出与依赖；类型导出不报（`rules.types` 关），
  `src/web/lib/utils.ts`（`components.json` 的 `utils` 别名）不报未用文件。
- vitest 5 两个 `projects`：`node`（`tests/` 下除 `tests/web` 外的 `*.test.ts`，node 环境）与 `web`（`tests/web`，happy-dom）；独立的
  `vitest.config.ts`（不继承 `vite.config.ts` 的 `root`），没有 `globalSetup`。HTTP 测试通过
  `createApp({ store: new MemoryStore(), now, … }).request()` 进程内运行，不起端口；只有真实 socket 才看得到的差异
  （HEAD 的 `Content-Length`、传输编码、信号）放 `tests/integration`。OpenAPI 的漂移检查是 `tests/http/openapi.test.ts` 的文件快照（§7.3）。
- 夹具：`tests/fixtures/generate-test-data.sh`（`pnpm run fixtures`，不带参数）每次完整重写 `tests/fixtures/pki/`，
  产物入库；改了脚本由开发者重新生成并提交。契约：日期、序列号、CRL 号固定；私钥、CSR、CA 库只在 `mktemp -d` 临时目录，退出即删，
  产物含 `PRIVATE KEY` 即失败；产出证书、CRL、`invalid/`、`manifest.json`（`now = 2026-01-04T00:00:00Z`、声明值、期望结果、场景）。
  生成需要 bash 与 OpenSSL ≥ 3.0（不是 LibreSSL）；`pnpm test` 只读入库的文件，两者都不需要。测试里的摘要、key id、序列号、大小一律从文件或
  manifest 读（每次重新生成都换密钥，ECDSA / PSS 签名与摘要全变），`now` 注入 `manifest.now`。场景覆盖 created / updated / unchanged / stale /
  conflict / non_orderable / 坏签名 / 伪造 AKI / 未知关键扩展 / 作用域 IDP / 未来 `thisUpdate` / 过期 / delta / EdDSA / PSS /
  无 AKI / 畸形时间 / SHA-1 / AD CS 形态（用例矩阵见 implementation 附录 D）。不用真实 PKI 的证书与 CRL（决策 13）。
- 存储一致性：同一套用例对 memory 与 fs 每次运行；r2 在 `AIA_TEST_R2=1`（`pnpm run test:r2`）下经
  `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 运行，`ci:worker` 包含它且要求 passed 而不是 skipped。
- Node 端到端：在临时目录起真实服务与 fs 存储，经 CLI 导入、应用配置、上传，再查下载（GET 与 HEAD）与静态 UI。
- Worker：`wrangler deploy --dry-run --outdir dist/worker`（先 `build:web`）；`smoke:worker`（`scripts/worker-smoke.ts`）用 `createTestHarness`
  运行 dry-run 产物，经进程内 CLI（`main()`，与 `seed-dev.ts` 相同）`aia import` 与 `config apply` 导入并应用配置，跑与运行时无关的
  `scripts/smoke.sh`（health、一次证书下载与 304、一次原始体 CRL 上传及其下载、读路由、UI），再在 workerd 上发布并验签（RSA PKCS#1 v1.5、
  RSASSA-PSS、SHA-1、坏签名）。`wrangler dev` 冒烟是切片出口里的人工步骤。
- Web：组件与逻辑在 vitest `web` 项目；`tests/http/app.test.ts` 查 UI、JSON 与下载响应都带同一 CSP。
- Docker（`scripts/docker-smoke.sh`）：构建镜像、启动、健康检查 `healthy` 而 API 报 `degraded`、uid 1000、经镜像内 CLI `aia import` 与
  `config apply` 后 health `healthy`，再跑 `scripts/smoke.sh`，`docker stop` < 5 s。
- CI：`.github/workflows/ci.yml` 四个任务，每个只用 `pnpm/setup` 装 Node（`.nvmrc`）、pnpm（`devEngines`）与依赖，再调用 `pnpm run ci:<job>`：`ci:check` = typecheck + ESLint + `prettier --check` + knip；
  `ci:test` = test + build；`ci:worker` = `build:web` + `wrangler deploy --dry-run` + `smoke:worker` + `test:r2`；`ci:docker` =
  `scripts/docker-smoke.sh`。`.github/dependabot.yml` 管 npm、github-actions、docker。GitHub Actions 在推送 `main` 与 PR 时运行（决策 10），
  本机执行的是同一组脚本。`pnpm verify` = check + test + build。
- 镜像发布：`.github/workflows/docker-publish.yml` 在推送 `main` 与 `v*.*.*` 标签时用 docker/metadata-action + build-push-action
  构建同一个 Dockerfile（linux/amd64）并以 `GITHUB_TOKEN` 推送到 `ghcr.io/acha666/aia-cdp`：`main` → `:main`，`vX.Y.Z` → `:X.Y.Z`、`:X.Y`、`:latest`。

## 11. 实施切片

每个切片一个分支 `slice/<n>-<name>`，从最新 `main` 切出，评审后本地 `git merge --no-ff` 合入 `main` 再推送；不部署（生产部署只在切片 7）；
严格串行（决策 10、11）。未完成切片（7、8）的步骤、测试、可在本机执行的出口条件与"开工前需 owner 确认"见 `docs/implementation/` 下的切片文件，
完成定义见总则 §1.3；下表的出口条件只是摘要，以切片文件为准。切片 1–6 已完成，它们的切片文件已删除（见 git 历史）。

| 切片 | 内容                                                                                                              | 出口条件                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1 骨架与存储 | 依赖、tsconfig 拓扑（§3）、devcontainer（决策 15）、ObjectStore 端口 + memory/fs/r2 适配器 + 一致性套件（决策 11）、`createApp`（真实 health、运行时 `openapi.json`、保留前缀与 UI 兜底）、Worker 与 Node 入口、Dockerfile、vitest、夹具脚本、日志中间件、`ci:*` 脚本与 CI 工作流、shadcn-vue 占位 UI | 已完成 |
| 2 catalog 与导入 | catalog/config schema 与条件写重试、`src/core/pki`、`importCertificate`、`applyConfig`、管理路由 import/config、CLI import/config/health | 已完成 |
| 3 下载 | 路径表解析、下载路由、PEM 派生、ETag/304/`Content-Length`/`Cache-Control`、纯文本 404/405                         | 已完成 |
| 4 发布 | `publishCrl`、history 标记、上传路由、三种结果与拒绝原因、`bodyLimit`/`bearerAuth`、发布日志、`aia publish`、AD CS 助手重写 | 已完成 |
| 5a API 与客户端 | 列表 / 详情 / 统计路由、OpenAPI 补全、`hc` 类型导出、PKI 摘要构建器（41 种扩展的解析，回归用合成 AD CS 风格夹具，决策 13） | 已完成 |
| 5b UI | §8 的路由、组件库、vue-query、总览与详情页、上传、zh-CN、CSP；`shadcn-vue init` 在切片 1 已完成 | 已完成 |
| 6 管理补全 | 历史列表与下载、证书删除的路由与 CLI；退役改为从 config 删除目标（取消 V8）；UI 展示吊销条目的全部扩展。README 重写、`docs/api.md` 与 operations.md 的其余章节按决策 17 不做 | 已完成 |
| 7 迁移 | `scripts/migrate-from-v2.ts`、临时历史导入路由、在非生产环境演练、生产切换（含替换 AD CS 助手）、`slice/7-cleanup` 删临时路由 | 路径表每条 URL 返回与旧 URL 相同的 DER 摘要（或 `advanced`）；旧对象未删；CryptoAPI 冒烟通过；回滚手册验证过（implementation 切片 7） |
| 8 S3（远期） | `storage/s3.ts`（`@aws-sdk/client-s3`，`IfMatch` / `IfNoneMatch`）、`pnpm run ci:s3`（MinIO）与可选 CI 任务、多实例部署说明；远期计划（决策 17），owner 确认要做才开工 | 一致性测试对 MinIO 绿（implementation 切片 8）                                               |

## 12. 从现有部署迁移

现有部署跑的是 `worker-aia-cdp@0ea3130`（Gen B），更早的对象来自 Gen A，两代的归档名都不含摘要且同名覆盖，所以历史迁移是
**尽力而为**，不是确定性的；旧仓库分支 `parsing-2026-10-18`（含 `5b570aa`，称 Gen C）的归档键从未部署（C9）。旧助手把 v1 响应记为失败，
切换时必须换脚本，只改 `UploadUri` 不够（C10）。旧桶键布局、探测名集、盘点通道、归属规则与切换步骤以 implementation 切片 7 为准，
下文只保留轮廓。

新服务与旧 Worker 技术上可以共用同一个 R2 桶：新布局的前缀（`config.json`、`catalog.json`、
`blobs/`、`history/`）与旧前缀（`ca/`、`crl/`、`dcrl/`，其下有 `by-keyid/`、`archive/`）不相交，旧对象原样不动。推荐默认不共用：
新 Worker `aia-cdp` 自动置备独立的桶，旧桶零写入，回滚无数据风险（implementation 切片 7 开工前需 owner 确认第 2 项）。

`scripts/migrate-from-v2.ts` 是 HTTP 客户端加本地解析验签（复用 `src/core/pki`），不写旧 R2（盘点通道见 implementation 切片 7
开工前需 owner 确认第 1 项，推荐只用 HTTP）：

1. 从旧服务 `GET /api/v2/certificates` 与 `/ca/<file>` 取每张证书的 DER，
   `POST /api/v1/admin/certificates` 导入，记录 id。
2. 从旧服务 `GET /api/v2/crls` 取每个 full / delta CRL 的当前对象，签发者只按字节验签确定（键名与 metadata 不参与归属），
   为每个（签发者, kind）生成一个 target UUID，按旧 URL 生成 `config.json` 的路径表，
   `PUT /api/v1/admin/config`。
3. 对每个当前 CRL `POST /api/v1/crls`（正常发布路径，期待 created）。
4. 历史（尽力而为）：现有归档是 Gen A/B 的 `<folder>/archive/<名>-<crlNumber>.crl`，无摘要、同名覆盖（Gen C 的
   `crl/archive/<base>-<crlNumber>-<sha256>.crl` 从未部署）；脚本按可预测的名字逐号
   HTTP 探测、与 `/api/v2/stats` 对账，按字节归属与验签，按 CRL 号与 `thisUpdate` 顺序经仅迁移期使用的管理路由
   `POST /api/v1/admin/crls/{targetId}/history` 写入 blob 与 history 标记（不动 current；切片 7 加、`slice/7-cleanup` 删）。
   被同名覆盖的旧版本不可恢复，写进迁移报告。见 §13 #9。
5. 校验：对路径表逐条 GET 旧站与新站，比较 `sha256`（新站已按正常发布前进的记为 `advanced`）；history 列表等于计划的历史集。

切换：暂停 AD CS 计划任务 → 把自定义域 / 路由指到新 Worker（Node 部署则改 DNS 或代理）→
替换助手脚本（旧脚本读不懂 v1 响应，C10）并把 `UploadUri` 改为 `/api/v1/crls`、放好上传令牌文件 → 恢复任务 → 观察一次
`updated` 或 `unchanged`；域内机器上 `certutil -verify -urlfetch` 冒烟。
回滚：路由指回旧 Worker `aia-cdp-worker`，换回旧助手脚本与 `/api/v2/crls`，旧对象一直都在。确认稳定后再手工删除旧对象
（独立桶方案删旧 Worker 与整个旧桶）。

## 13. 本文自行取的默认值（可推翻）

1. 成功响应直接返回资源体，不包 `{ data }`。
2. CRL 上传与证书导入只收原始请求体，不收 multipart。
3. 未设置管理令牌时管理路由返回 503，而不是 404。
4. 公开路径只允许 `/ca/`、`/crl/`、`/dcrl/` 三个前缀；PEM 变体自动派生，不单独配置。
5. 证书路径不允许改绑（只与当前 config 比对，"先删再加"不检测，§5.2）；`config.json` 整体替换而不是逐条增删接口。
6. 公开 API 的 `DELETE /admin/certificates/{id}` 保留在首发里（约 30 行）。
7. 进程内 config/catalog 备忘默认关闭。
8. Node 侧用 `tsc -p tsconfig.build.json` 编译到 `dist/server`，不做单文件打包。
9. 历史迁移尽力而为：现有 Gen A/B 归档无摘要且同名覆盖，按可预测名 HTTP 探测 + stats 对账 + 按字节归属，按 CRL 号顺序迁入（C9），
   见 §12 与 implementation 切片 7。
10. i18n 只有 `en` 与 `zh-CN` 两种 locale，都完整翻译。
11. 项目目录 `~/aia-cdp/aia-cdp`，仓库名 `aia-cdp`；本文件路径 `docs/plan.md`。
12. 其余规划默认值（版本锁定、`worker-configuration.d.ts` 不入库、不发 HSTS、保留前缀与 UI 兜底、手写 ETag / 304、health 形状、运行时
    OpenAPI、夹具入库、浮动 Docker 基础标签、不加 `deploy` 脚本等）是 implementation 总则 §0 的 B1–B22，落实位置见该表；CRL blob 键、
    历史定义与重试次数见 §5，`revokedCount` 非空与 stats 不含时间字段见 §5.3、§7.1。
