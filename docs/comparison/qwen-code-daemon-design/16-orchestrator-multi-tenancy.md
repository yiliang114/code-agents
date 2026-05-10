# 16 — Orchestrator 多租户与配额（External Reference Architecture）

> [← 上一篇：单 vs 多 Session 设计深度对比](./15-single-vs-multi-session-design.md) · [回到 README](./README.md)

> **不在 qwen-code 主线 scope**——本章是给 qwen-code 开发者的"大致方向"指引：当外部商业平台 / k8s operator / 云厂商基于 qwen-code daemon building block 搭 SaaS 时，**orchestrator 层**应该长什么样。
>
> 主线只承诺 daemon building block；下面是平台层蓝图。

## 一、Layer 模型

| 层 | 职责 | 实施方 |
|---|---|---|
| **Daemon Instance**（主线）| 1 session 状态 + tool 执行 + Shell sandbox | qwen-code 项目 |
| **Orchestrator**（External）| spawn / route daemon、AuthN/AuthZ、quota、audit、持久化 | 外部商业平台 |

**核心思想**：[§02 §2](./02-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session" 模型把租户复杂度从 daemon 内挤出到 orchestrator 层——daemon 进程不感知租户，每个 daemon 只服务一个 tenant 的一个 session，进程级隔离自然成立。

**Daemon 主线持久化基线（对比基线）**：每 daemon 一份 transcript JSONL（PR#3739）+ `~/.qwen/settings.json` / skills / OAuth credentials 启动加载、运行时只读。**0 RDBMS 依赖**——并发写 / audit 查询 / quota 原子 / hash lookup 这些 RDBMS 痛点在 1 daemon = 1 session 模型下天然不出现。下面 SQLite/Postgres/drizzle-orm 全部是 orchestrator 层关切。

## 二、Orchestrator 4 件事

| # | 职责 | 含义 |
|---|---|---|
| 1 | **AuthN**（认证）| 入口校验 client 身份。常见 4 模式：Bearer token / OIDC（Google/Azure/Okta）/ mTLS / cookie session |
| 2 | **AuthZ**（授权）| `tenant → workspaces` 映射 + scope 路由策略（`single` / `user` / `thread`）。决定哪个 client 能 spawn / attach 哪个 daemon |
| 3 | **Quota**（配额）| per-tenant LLM token quota + 并发 daemon 数限制。原子 increment 走 Redis sliding-window + reservation 模式 |
| 4 | **Audit**（审计）| 每 daemon spawn / kill / shell 调用都写一条 audit log（合规 / 排错 / 安全审计）|

每件事在 orchestrator 入口 middleware 层做，daemon 层完全不感知。

## 三、Tenant 抽象

```
Tenant
├─ id
├─ name
├─ workspaces: WorkspaceAccess[]   ← 哪些 workspace 属于此 tenant
├─ quota: { llmTokens, concurrentDaemons, ... }
└─ auditChannel: 'jsonl' | 'syslog' | 'otel' | 'kafka'
```

**关键不变量**：daemon 启动时 orchestrator 把 `tenantId` 作为 ENV 注入；daemon 内部不读不写不传播 tenant 概念。Daemon crash 重启由 orchestrator 重新决定 tenant 绑定——天然刷新。

## 四、持久化栈大致方向

orchestrator 需要 RDBMS 是因为它有 daemon 主线没有的痛点：

| 数据 | 痛点 | 推荐栈 |
|---|---|---|
| permission_decisions | 多 client 并发写文件 race | SQLite（`INSERT ... ON CONFLICT` + WAL）|
| audit_log | 高频 append + 复合条件查询 | SQLite → Postgres（按规模升级）|
| tokens | hash lookup + 索引（每 HTTP 请求 1 次）| SQLite + index |
| tenant_quotas | 极高频原子 increment | Redis（+ Postgres 周期性 backup）|
| workspaces / sessions / tenants | 关系型查询、UNIQUE 约束 | SQLite / Postgres |

**渐进路径**（按部署规模选）：

```
单机 self-host        ── SQLite（zero-conf，better-sqlite3）
中等 SaaS（< 100 租户）── SQLite + Redis（quota 走 Redis）
大规模 SaaS / 多 region── Postgres（Patroni HA）+ Redis Sentinel + S3（transcript blob）
```

**ORM 选型建议 drizzle-orm**——SQLite ↔ Postgres 同一份 schema，零迁移成本。

**核心表 8 张**（粗略）：`tenants` / `tokens` / `workspaces` / `sessions` / `permission_decisions` / `audit_log` / `background_tasks` / `tenant_quotas`。

## 五、4 个 Phase（演进路径）

| Phase | 工作量 | 内容 |
|---|---|---|
| **Phase 1** | ~3-4w | Tenant 抽象 + AuthN（Bearer/OIDC）+ Quota engine + Audit log + SQLite |
| **Phase 2** | ~2-3w | Sandbox（OS user / Linux namespace / Container，[§09](./09-multi-tenancy-and-sandbox.md)）|
| **Phase 3** | ~2-3w | HA（multi-pod sticky / Postgres Patroni / Redis Sentinel / SSE Last-Event-ID 跨 pod 重连）|
| **Phase 4** | ~3-4w | Multi-region / cross-geo + cross-daemon shared state via Redis pub/sub |

合计 ~10-14w 把 daemon building block 包装成完整 SaaS。

## 六、与 OpenCode / Claude Code 对比

| 维度 | OpenCode | Claude Code | Qwen daemon + Orchestrator |
|---|---|---|---|
| Multi-tenancy 位置 | daemon 内 | 不支持 | **orchestrator 层** |
| 隔离 | 应用层 ALS | 单进程单用户 | **OS process（每 daemon）** |
| 持久化 | drizzle + SQLite | 纯文件 | 主线纯文件 + orchestrator 用 drizzle |
| 适用规模 | 大 SaaS（共享 daemon）| 个人 | 个人 / 中等 / 大 SaaS（按 phase 演进）|

## 七、关键权衡

- **OS 进程级隔离免费**：daemon 之间天然不共享内存 / fd / cwd —— 不需要 daemon 内 ACL middleware
- **代价**：每 daemon 30-50MB baseline、cold start ~1-3s。N ≥ 50 时投资源池化（用户级 LSP / 共享 MCP）
- **渐进引入**：单机 SQLite 起步，规模上升再切 Postgres，schema 不变（drizzle 跨 dialect）

## 八、一句话总结

**Orchestrator 是平台层（不在 qwen-code 项目 scope）**——把 N 个 daemon 实例编排成多租户 SaaS。Daemon 主线 0 RDBMS / 0 ACL / 0 quota；orchestrator 引入 SQLite/Postgres + drizzle + Redis 处理 tenant / quota / audit / 跨 daemon 状态。Phase 1-4 ~10-14w 完整 SaaS 蓝图——qwen-code 开发者不需要实现，只需要 daemon building block 协议稳定让外部能基于它搭 orchestrator。

---

[← 上一篇：单 vs 多 Session 设计深度对比](./15-single-vs-multi-session-design.md) · [回到 README](./README.md)
