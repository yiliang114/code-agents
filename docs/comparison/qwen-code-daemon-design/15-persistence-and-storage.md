# 15 — 持久层（daemon 主线）

> [← 上一篇：实体模型与层级关系](./14-entity-model.md) · [下一篇：HA 高可用与故障恢复 →](./16-high-availability.md)

> **本章只讨论 qwen-code 主线 daemon 的持久化**——纯 JSON / JSONL 文件栈，不引入 SQLite / 任何 ORM。
>
> External SaaS 集成（orchestrator + 多租户）的持久化设计（SQLite → Postgres + S3 + 可选 Redis、Storage Adapter 抽象、8 张核心表 schema、drizzle-orm 选型、migration 工具链、安全字段加密、多 daemon 共享状态、性能基准等）已**全部集中到** [§22 Orchestrator 多租户与配额](./22-orchestrator-multi-tenancy.md)，减轻主线读者阅读负担。

## 一、TL;DR

| 层 | 持久化栈 | 用途 |
|---|---|---|
| **每 daemon instance** | transcript JSONL（per-daemon 一份）| LLM 对话历史 / fork-resume |
| **每用户**（settings / skills）| `~/.qwen/settings.json` + skill registry 文件 | OAuth credentials / MCP 注册 / theme |
| **External Orchestrator** 持久层 | SQLite / Postgres + S3 + 可选 Redis（[§22](./22-orchestrator-multi-tenancy.md)）| tenants / quota / audit / cross-daemon 聚合 |

**主线设计原则**：
- daemon building block **0 RDBMS 依赖**——沿用 Qwen Code 现有的纯文件栈
- 每 daemon instance 自己的 transcript JSONL，daemon 退出 fsync，无并发写问题
- daemon 主线 ~3 周 feature complete 中**持久层 0 新依赖**

## 二、当前 Qwen Code 持久化栈（事实基线）

```
~/.qwen/
├─ settings.json                  # 用户全局配置（model / theme / keymap）
├─ workspaces/
│   └─ <wsId>/
│       ├─ settings.json           # workspace 级 override
│       └─ permissions.json        # `alwaysAllow` 决策本地缓存
├─ transcripts/
│   └─ <sessionId>.jsonl           # 对话历史 + tool call + 结果（PR#3739 fork resume 基础）
├─ skills/                          # Skill registry（path-conditional 激活）
└─ tokens                           # Bearer token / OAuth credentials（OS keychain 优先）
```

| 数据 | 位置 | daemon 主线下保留？ |
|---|---|---|
| Session transcript | JSONL 文件（PR#3739）| **保留**——每 daemon 一份，daemon 退出 fsync |
| 用户 settings | settings.json | **保留**——人工编辑友好 |
| Skill registry | skills/ 目录 | **保留**——path-conditional 激活 daemon 内即时计算 |
| Workspace permissions | permissions.json | **保留**——daemon 启动加载，运行时只读 |
| OAuth credentials | `~/.qwen/` 文件 / OS keychain | **保留**——daemon 启动加载 |
| MCP server registry | settings.json | **保留**——daemon 启动加载 |

**优点**：零依赖、人工可读、git diff 友好、无 schema migration 痛苦。

**1 daemon = 1 session 模型下纯文件栈足够**——常见 RDBMS 痛点天然不出现：
- 多 client 并发写：settings 启动加载 / 运行时只读，无并发写
- 高频 audit append：daemon 不写 audit log（仅 External orchestrator 需要）
- token hash 查找：单 token bearer（多 token 在 orchestrator 层）
- quota 原子 increment：daemon 不做 quota（仅 External orchestrator 需要）

## 三、Daemon 主线持久化语义（per-daemon 单 session）

```
1 Daemon Instance = 1 Session
       │
       ├─ 启动时
       │  ├─ 加载 ~/.qwen/settings.json + workspaces/<wsId>/*
       │  ├─ 加载 OAuth credentials（OS keychain 或 ~/.qwen/）
       │  └─ 如果 sessionId 存在：load transcripts/<sessionId>.jsonl 重建状态（PR#3739 fork resume）
       │
       ├─ 运行时
       │  ├─ 持续 append-only 写 transcripts/<sessionId>.jsonl
       │  ├─ FileReadCache / Permission cache 都在内存（daemon 退出释放）
       │  └─ settings.json 保持只读（用户级修改需 daemon 重启）
       │
       └─ 退出时
          ├─ fsync transcript JSONL
          └─ daemon-global cleanup（kill child processes / fd / memory）
```

**关键性质**：
- **0 RDBMS 依赖**——主线不需要 SQLite / better-sqlite3 / drizzle-orm 等
- **单写者无并发**——一个 daemon 一个 transcript JSONL，append-only 无锁
- **fork resume 自然成立**——transcript JSONL 即"事件流持久化"，新 daemon 从中重建（PR#3739 已实现）
- **Crash 安全**——append-only + 启动时容忍尾部不完整记录（最多丢最后一条 partial event）

## 四、何时需要外部 RDBMS？（→ External Reference Architecture）

主线 daemon **不需要**。下列场景由 [§22 Orchestrator 多租户与配额](./22-orchestrator-multi-tenancy.md) 完整设计：

| 场景 | 数据 | 推荐栈 | §22 详细文档 |
|---|---|---|---|
| 多 daemon 聚合 audit log | 每 tool call 写一条 | SQLite / Postgres | [§六 Audit log](./22-orchestrator-multi-tenancy.md#六audit-log) + [§十三 Schema](./22-orchestrator-multi-tenancy.md#十三完整-schema-设计) |
| Per-tenant quota counter | 高频原子 increment | Redis（+ Postgres backup）| [§五 Quota engine](./22-orchestrator-multi-tenancy.md#五per-tenant-quota-引擎) |
| Multi-token + per-token user-id | hash lookup + 索引 | SQLite / Postgres | [§四 AuthN](./22-orchestrator-multi-tenancy.md#四authentication--authorization) |
| Cross-daemon session metadata | sessionId → daemonUrl 映射 | Redis / Postgres | [§三 Tenant 抽象](./22-orchestrator-multi-tenancy.md#三tenant-抽象在-orchestrator-中) |
| 多 region / 跨地理 SaaS | Postgres logical rep | Postgres + S3 cross-region | [§七 Phase 4](./22-orchestrator-multi-tenancy.md#七saas-实施-4-个-phaseexternal-reference) |
| 8 张核心表完整 schema | tenants / tokens / workspaces / sessions / permission_decisions / audit_log / background_tasks / tenant_quotas | drizzle-orm 跨 dialect | [§十三 Schema](./22-orchestrator-multi-tenancy.md#十三完整-schema-设计) |
| Storage Adapter 抽象 | 跨阶段平滑切换 | TypeScript interface | [§十一 Storage Adapter](./22-orchestrator-multi-tenancy.md#十一storage-adapter-抽象设计) |
| ORM 选型（drizzle-orm）| typed schema + 多 dialect | TypeScript | [§十二 ORM 选型](./22-orchestrator-multi-tenancy.md#十二orm-选型drizzle-orm) |
| Migration 工具链 | drizzle-kit | scripts/migrate-* | [§十五 迁移与升级](./22-orchestrator-multi-tenancy.md#十五迁移与升级) |
| 多 daemon 共享状态 | sessionId → daemon mapping + 故障转移 | Redis pub/sub + Postgres | [§十四 Phase 4 多 daemon 共享](./22-orchestrator-multi-tenancy.md#十四external-phase-4-多-daemon-共享状态架构) |
| 安全字段加密 | OAuth tokens / API keys | AES-GCM + envelope encryption | [§十六 安全考虑](./22-orchestrator-multi-tenancy.md#十六安全考虑) |
| 性能基准 | SQLite WAL / Postgres connection pool | benchmark | [§十七 性能基准](./22-orchestrator-multi-tenancy.md#十七性能基准推测) |

**判断条件**：当部署形态从"单 daemon 自己"演进到"多 daemon + 中心化协调"时引入 RDBMS——这是 External Reference Architecture 范畴。

## 五、与 OpenCode / Claude Code 持久层对比

| 维度 | OpenCode | Claude Code | Qwen Daemon 主线 |
|---|---|---|---|
| ORM | drizzle-orm | N/A | **N/A**（主线不引入；External 用 drizzle-orm，见 [§22](./22-orchestrator-multi-tenancy.md)）|
| 默认存储 | SQLite | local files | **JSON + JSONL 文件**（与 Claude Code 风格相同）|
| Transcript 存储 | SQLite blob | local files | **JSONL 文件**（PR#3739）|
| 多 daemon 共享状态 | ❌ | ❌ | ❌ 主线；✓ External Phase 4 ([§22](./22-orchestrator-multi-tenancy.md))|
| 跨 region 支持 | ❌ | ❌ | ❌ 主线；✓ External Phase 4 multi-region |

**Qwen daemon 主线 = Claude Code 风格（纯文件，零依赖）；External SaaS = OpenCode 风格（drizzle + SQLite/Postgres）**。

## 六、一句话总结

**Qwen Code daemon 主线（Stage 1/1.5/2）持久化纯 JSON + JSONL 文件，0 RDBMS 依赖**——每 daemon 一份 transcript JSONL（PR#3739 fork resume 基础），settings.json / skills / OAuth credentials 启动加载、运行时只读。**1 daemon = 1 session 模型下，常见 RDBMS 痛点（并发写 / audit 查询 / quota 原子 / hash lookup）天然不出现**。  
**External SaaS 集成需要 RDBMS 时**（多 daemon audit 聚合 / per-tenant quota / multi-token / cross-daemon session metadata 等），完整设计在 [§22 Orchestrator 多租户与配额](./22-orchestrator-multi-tenancy.md)——SQLite → Postgres + S3 + 可选 Redis 渐进、drizzle-orm 跨 dialect、8 张核心表 schema、完整 migration 工具链。  
**设计哲学**：让数据形态决定存储；daemon building block 永远纯文件；orchestrator 集成按真实痛点引入 RDBMS。

---

[← 上一篇：实体模型与层级关系](./14-entity-model.md) · [下一篇：HA 高可用与故障恢复 →](./16-high-availability.md)
