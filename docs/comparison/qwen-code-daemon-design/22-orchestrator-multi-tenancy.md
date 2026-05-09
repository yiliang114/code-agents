# 22 — Orchestrator 多租户与配额

> [← 上一篇：单 vs 多 Session 设计深度对比](./21-single-vs-multi-session-design.md) · [回到 README](./README.md)

> [§03 §2](./03-architectural-decisions.md#2-状态进程模型) "1 Daemon Instance = 1 Session" 模型下，daemon 进程不感知租户——multi-tenancy 概念全部在 orchestrator 层。本章设计 orchestrator 的 Tenant 抽象、AuthN/AuthZ、配额引擎、审计日志、SaaS 路线图。Shell sandbox 见 [§11](./11-multi-tenancy-and-sandbox.md)。

## 一、TL;DR

| Layer | 职责 | 在哪 |
|---|---|---|
| **Orchestrator** | tenant 路由 / spawn daemon / quota / audit / OIDC | `qwen-coordinator` 进程 |
| **Daemon Instance** | 单一 session 状态 + tool 执行 + Shell sandbox | 每 session 一个 process |
| **Shell Sandbox** | 命令执行隔离 | daemon 进程内（[§11](./11-multi-tenancy-and-sandbox.md)）|

**核心设计**：tenant 信息**不进入 daemon 进程内部**——orchestrator 在 spawn daemon 时绑定 tenant id，daemon 只服务那个 tenant 的一个 session，进程级隔离自然消除 daemon 内 cross-tenant 问题。Tenant ACL / quota / audit 等都在 orchestrator 层做。

| 维度 | 设计 |
|---|---|
| Tenant 抽象 | `Tenant` 类在 orchestrator，daemon 不感知 |
| 认证 | Bearer token / OIDC / mTLS（在 orchestrator 入口）|
| 授权 | tenant → workspaces 映射 + scope 路由策略 |
| 配额 | per-tenant LLM token quota + 并发 daemon 数 |
| 审计 | 每 daemon spawn / kill / shell 调用都写 audit log（聚合到 orchestrator）|
| SaaS 实施 Phase | Phase 1（多租户）→ Phase 2/3（沙箱）→ Phase 4（完整 SaaS）|

## 二、为什么 multi-tenancy 在 orchestrator 而非 daemon

[§03 §2 决策](./03-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session" 模型把 multi-tenancy 复杂度从 daemon 内挤出到 orchestrator 层：

| 维度 | 单 daemon 多 tenant 模型（旧）| Orchestrator + 单 session daemon（当前）|
|---|---|---|
| Tenant 隔离 | 应用层（AsyncLocalStorage `tenantId`）| **OS process 边界**（每 daemon 一个 tenant 的一个 session）|
| 跨 tenant 数据泄漏 | session/cache key 必须加 tenantId 前缀 | **不可能**（不同 daemon 进程互不可见）|
| Shell sandbox | 与 tenant 绑定，per-tenant 配置 | sandbox 在 daemon 内，tenant 信息已固化 |
| Quota | daemon 内 quota engine + Redis | orchestrator 层统计 + 决策 |
| Audit log | daemon 内写入 | daemon 写入本地 + orchestrator 聚合 |
| OIDC / SSO | daemon 入口 ACL middleware | orchestrator 入口（daemon 不感知）|
| Daemon 复杂度 | 高（cross-tenant 状态管理）| **低**（每 daemon 自给自足）|

**直接收益**：daemon 代码不需要处理 tenantId / ACL / quota——它只服务一个用户。orchestrator 是新加层，问题域清晰，与现有 core 业务逻辑解耦。

## 三、Tenant 抽象（在 orchestrator 中）

```ts
// packages/coordinator/src/tenant/Tenant.ts （新建）
export interface Tenant {
  id: string                          // 'alice@company.com' / OIDC sub
  displayName: string
  
  // 授权
  workspaces: WorkspaceAccess[]       // 哪些 workspaces 可访问
  scopes: SessionScope[]              // 'single' / 'user' / 'thread'
  
  // 配额
  quota: TenantQuota
  
  // Sandbox 配置（[§11](./11-multi-tenancy-and-sandbox.md) ShellSandbox 类型）
  sandbox: {
    type: 'none' | 'os-user' | 'namespace' | 'container' | 'remote'
    osUid?: number; osGid?: number     // os-user 时
    cgroupPath?: string                // namespace 时
    image?: string                     // container 时
    remote?: RemoteSandboxConfig       // remote 时
  }
  
  // Audit
  auditChannel: 'jsonl-local' | 'syslog' | 'opentelemetry' | 'kafka'
}

export interface WorkspaceAccess {
  workspaceId: string
  permissions: ('read' | 'write' | 'spawn-shell' | 'spawn-monitor')[]
}

export interface TenantQuota {
  maxConcurrentDaemons: number       // 同时跑几个 daemon
  llmTokensPerHour: number            // LLM 调用 token 上限
  llmTokensPerDay: number
  shellCallsPerHour: number
  storageBytes: number                // workspace + transcript 总大小
}
```

orchestrator 启动时从 settings.json / Postgres / Identity Provider 加载 Tenant 列表。

## 四、Authentication & Authorization

### 4.1 认证（AuthN）

```ts
// orchestrator HTTP middleware
app.use(async (req, res, next) => {
  const tenant = await authenticateRequest(req)
  if (!tenant) return res.status(401).json({ error: 'unauthenticated' })
  req.tenant = tenant
  next()
})

async function authenticateRequest(req): Promise<Tenant | null> {
  // 优先级：mTLS > Bearer token > OIDC cookie
  const auth = req.headers['authorization']
  
  if (req.connection.encrypted && req.client.authorized) {
    // mTLS 已验证（企业部署）
    return await tenantFromClientCert(req.client.getPeerCertificate())
  }
  
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7)
    return await tenantFromBearerToken(token)
  }
  
  if (req.cookies?.session_token) {
    return await tenantFromOidcSession(req.cookies.session_token)
  }
  
  return null
}
```

### 4.2 授权（AuthZ）

```ts
// orchestrator 在 spawn daemon 前检查
async function authorizeSpawn(tenant: Tenant, req: SpawnDaemonRequest): Promise<void> {
  // 1. workspace 访问权限
  const ws = tenant.workspaces.find(w => w.workspaceId === req.workspaceId)
  if (!ws) throw new ForbiddenError('workspace not authorized')
  
  // 2. scope 是否允许
  if (!tenant.scopes.includes(req.scope)) {
    throw new ForbiddenError(`scope ${req.scope} not allowed for tenant`)
  }
  
  // 3. 配额检查
  const usage = await quotaEngine.getUsage(tenant.id)
  if (usage.concurrentDaemons >= tenant.quota.maxConcurrentDaemons) {
    throw new QuotaExceededError('max concurrent daemons reached')
  }
  if (usage.llmTokensThisHour >= tenant.quota.llmTokensPerHour) {
    throw new QuotaExceededError('hourly LLM token quota exceeded')
  }
  
  // 4. 写 audit log
  await auditLog.record(tenant.id, 'spawn', req)
}
```

### 4.3 OIDC / SSO 集成

```yaml
# orchestrator settings.yaml
auth:
  modes: ['oidc', 'bearer', 'mtls']  # 多种并存
  
  oidc:
    issuer: https://auth.company.com
    clientId: qwen-coordinator
    clientSecret: ${OIDC_CLIENT_SECRET}
    tenantIdClaim: 'sub'            # OIDC claim → Tenant.id 映射
    workspaceClaim: 'qwen:workspaces' # custom claim
  
  bearer:
    tokenStore: postgres            # 多 token 存储
    
  mtls:
    caCert: /etc/qwen/ca.pem
    tenantIdFromCN: true           # cert CN → Tenant.id
```

## 五、Per-tenant Quota 引擎

### 5.1 Quota 维度

```ts
interface QuotaUsage {
  concurrentDaemons: number          // 当前活跃 daemon 数
  llmTokensThisHour: number
  llmTokensThisDay: number
  shellCallsThisHour: number
  storageBytesUsed: number
}
```

### 5.2 Quota 存储与原子性

**Redis** 存 sliding-window counters（per-tenant）：

```ts
class RedisQuotaEngine {
  async incrementLlmTokens(tenantId: string, tokens: number): Promise<QuotaCheck> {
    // Lua 脚本：原子读取 + 检查 + 递增 + 设置 TTL
    const result = await redis.eval(LUA_INCR_AND_CHECK, [
      `quota:${tenantId}:llm:hour:${currentHourBucket()}`,
      `quota:${tenantId}:llm:day:${currentDayBucket()}`,
    ], [
      tokens,
      tenant.quota.llmTokensPerHour,
      tenant.quota.llmTokensPerDay,
      3600,    // hour TTL
      86400,   // day TTL
    ])
    
    return parseQuotaResult(result)
  }
}
```

### 5.3 daemon 端配额上报

每 daemon 在 LLM 调用前向 orchestrator 报"我要用 N tokens"：

```ts
// daemon 内 LLM client wrapper
class QuotaAwareLlmClient {
  async generate(messages, options) {
    const estimatedTokens = estimateTokens(messages)
    
    // 预扣
    const reservation = await this.coordinator.reserveQuota({
      sessionId: this.sessionId,
      tokens: estimatedTokens,
    })
    
    if (!reservation.granted) {
      throw new QuotaExceededError(reservation.reason)
    }
    
    try {
      const response = await this.upstreamLlm.generate(messages, options)
      
      // 实扣（差额结算）
      await this.coordinator.confirmQuota({
        reservationId: reservation.id,
        actualTokens: response.usage.totalTokens,
      })
      
      return response
    } catch (err) {
      await this.coordinator.cancelReservation(reservation.id)
      throw err
    }
  }
}
```

### 5.4 优雅降级

quota 接近上限时 orchestrator 可以：

| 行为 | 触发条件 |
|---|---|
| **拒绝新 spawn** | concurrentDaemons ≥ quota | 返回 429 + retry-after |
| **拒绝新 LLM 调用** | tokens 超限 | session-internal error，让 LLM 决策（如 truncate context）|
| **降级到便宜模型** | tokens 接近上限 | orchestrator 在 spawn 时强制 model = 便宜版 |
| **冻结新 shell 调用** | shellCalls 超限 | 仅允许 read-only 命令 |

## 六、Audit Log

### 6.1 Audit log 内容

每个关键事件写入 audit log（orchestrator 维护，daemon 异步推送）：

```ts
interface AuditEvent {
  id: string
  timestamp: ISO8601
  tenantId: string
  sessionId?: string
  daemonId?: string
  
  type: 'auth.login' | 'auth.token-issued' | 'auth.token-revoked'
       | 'session.created' | 'session.terminated' | 'session.idle-evicted'
       | 'tool.shell-spawn' | 'tool.shell-exit' | 'tool.file-write' | 'tool.permission-granted'
       | 'quota.exceeded' | 'quota.warning'
  
  details: Record<string, unknown>   // 事件具体内容
  outcome: 'success' | 'denied' | 'error'
  
  // 不记敏感数据：tool args 中的 file content 不写 / LLM prompt 不写 / token 不写
}
```

### 6.2 Audit channels

```yaml
auditChannels:
  # JSONL 本地文件（默认 / self-host）
  - kind: jsonl-local
    path: /var/log/qwen/audit-{date}.jsonl
    rotate: daily
    retention: 90d
  
  # Syslog（企业 SIEM）
  - kind: syslog
    facility: AUTHPRIV
    server: syslog.company.com:514
    format: rfc5424
  
  # OpenTelemetry（云原生）
  - kind: opentelemetry
    endpoint: otel-collector:4317
    exporter: otlp-grpc
    attributes:
      service.name: qwen-coordinator
  
  # Kafka（高吞吐 SaaS）
  - kind: kafka
    brokers: [kafka1:9092, kafka2:9092]
    topic: qwen-audit-events
    schema: avro+confluent-registry
```

### 6.3 GDPR / 合规要求

| 要求 | 实现 |
|---|---|
| Right to Access（用户取自己的数据）| `GET /coordinator/users/:id/audit?since=...` |
| Right to Erasure（删除）| `DELETE /coordinator/users/:id` → 标记 audit 为 redacted（不真删，符合监管）|
| 数据最小化 | tool args / file content / LLM prompts **不进 audit**——仅记 metadata |
| 数据驻留 | per-tenant 配置 audit 写到哪个 region 的存储 |
| 加密 | audit channel 必须 TLS（syslog → TLS / kafka → TLS）|

## 七、SaaS 实施 4 个 Phase（External Reference）

> 本节描述外部集成方实施 SaaS 平台层的渐进路径。**不是 qwen-code 主线 Stage**——qwen-code 主线只做 Stage 1/1.5/2（[§08](./08-roadmap.md)）；下面 Phase 是给商业平台 / k8s operator / 云厂商的实施参考。

```
Phase 1 (~1-2 周)：Orchestrator 多租户基础
  └─ Tenant 抽象 + 配置加载
  └─ Bearer token 认证 + 单 token 多 user
  └─ 基础 quota（concurrent daemons + llm tokens）
  └─ Audit JSONL local
  └─ workspace allowlist
  └─ 适合：同公司团队 trusted multi-user

Phase 2 (~2-3 周)：+ Shell sandbox
  └─ §11 ShellSandbox 4 种本地实现
  └─ Monitor tool 走 sandbox 接口
  └─ 适合：半信任多用户（学校 / 大型团队 / consulting）

Phase 3 (~2 周)：+ 远程 sandbox
  └─ RemoteSandbox（SSH-based 起步）
  └─ Workspace 同步策略（NFS / rsync）
  └─ 适合：daemon vs shell 不同机器场景

Phase 4 (~1-2 月)：完整 SaaS
  └─ OIDC / SSO 集成
  └─ Quota engine（Redis + Lua 原子）+ 优雅降级
  └─ Audit channels（syslog / opentelemetry / kafka）
  └─ k8s native deployment（daemon per pod + sandbox worker pool）
  └─ Postgres state + Redis cache + S3 transcript backup
  └─ 多 region / 跨地理调度
  └─ Console / billing dashboard
  └─ 适合：完全不信任 SaaS 用户
```


---

> **§八-§十七 持久化栈细节**：以下章节回答"orchestrator 层使用什么存储栈支撑上面 §三-§七 的多租户语义"，是从原 §15 整体迁移过来的——qwen-code 主线 daemon 不引入 SQLite / ORM（详见 [§15](./15-persistence-and-storage.md)）。如果只关心多租户语义本身可以跳到 [§十八 与 OpenCode / Claude 对比](#十八与-opencode--claude-code-多租户对比)。

## 八、引入 SQLite 的边界（External Phase 1 orchestrator 层）

### 8.1 决策原则：让数据形态决定存储

不是按 stage 切换，而是按数据特性。下表把每类数据按特性归类：

| 数据 | 并发写频率 | 查询模式 | 推荐存储 | 引入时机 |
|---|---|---|---|---|
| settings.json / tenant.json | 低（人工编辑）| key 直接读 | **JSON 文件** | 永远（沿用现状）|
| Session transcript | 中（每条消息）| 顺序读 / fork resume | **JSONL** | 永远（沿用 PR#3739）|
| Skill registry | 启动时一次 | 内存 lookup | **内存 + JSON 索引** | 永远 |
| OAuth credentials | 低 | key 直接读 | **JSON + 加密** | 永远 |
| **permission_decisions** | 高（多 client 并发）| 复合键查询 | **SQLite** | **External Phase 1** |
| **audit_log** | 极高（每 tool call）| 按 tenant + time 范围 | **SQLite** | **External Phase 1** |
| **tokens** | 低写 / 高读 | hash lookup + 索引 | **SQLite** | **External Phase 1** |
| **background_tasks meta** | 中 | 按 status / session 过滤 | **SQLite** | **External Phase 1** |
| **workspaces meta** | 低写 | UNIQUE 约束防 race | **SQLite** | **External Phase 1+**（多租户起）|
| **tenant_quotas** | 极高（每次 tool call increment）| 原子 +1 | **SQLite** → Redis | **External Phase 1+** |

### 8.2 4 类数据为什么必须升级到 SQLite（External Phase 1）

**a) `permission_decisions` —— 文件 race condition**

[决策 §6 多 client 并发](./03-architectural-decisions.md) 下，多 client 可能同时记录 `alwaysAllow` 决策：

```
T=0   Client A 收到 'Bash(npm test)' 权限请求 → user 选 alwaysAllow
T=0   Client B 几乎同时收到 'Bash(git status)' 权限请求 → user 选 alwaysAllow
T=1   两 client 都 read settings.json → 修改 → write
      → 后写赢，前者决策丢失
```

JSON 文件无 ACID。SQLite `INSERT ... ON CONFLICT` + WAL 解决。

**b) `audit_log` —— 查询性能**

`audit_log.jsonl` 100MB+ 后：
- `grep tenant_id=t-alice` 全文扫 → 秒级
- 按时间范围筛 → 慢
- WHERE tenant + time + tool_name 复合条件 → 不可行

SQLite `idx_audit_tenant_ts` 复合索引 → ms 级。

**c) `tokens` —— hash lookup**

每次 HTTP request 验证 bearer token：
- JSON 文件：read all + bcrypt.compare 全部
- SQLite：`WHERE secret_hash = ?` + 索引 → 直接 hit

每秒 100+ 请求时差距明显。

**d) `background_tasks` —— 状态机查询**

[§subagent-display PR#3471/3488/3791/3836](../subagent-display-deep-dive.md) 4 kinds 后台任务：
- UI 需 `WHERE session_id = ? AND status = 'running'` 列出
- JSON 文件方案需要把所有 task 加载到内存遍历
- SQLite `idx_task_session` + `idx_task_status` 自然支持

### 8.3 哪些数据继续用文件（明确不进 SQLite）

| 数据 | 不进 SQLite 的理由 |
|---|---|
| `settings.json` / `tenant.json` | 人工编辑友好 / git diff 可读 / 低并发 |
| Transcript JSONL | 大 blob / append-only / 文件性能最高 / S3 归档兼容 |
| Skill registry | 启动 immutable / 内存 lookup 即可 |
| MCP server config | 同 settings.json |
| OAuth tokens | 加密文件比 SQLite 字段加密简单 |

### 8.4 替代方案对比（为什么是 SQLite 不是别的）

|  | SQLite | LMDB / level | DuckDB | 直接 Postgres | 继续 JSON |
|---|---|---|---|---|---|
| 部署 | 0 | 0 | 0 | 需服务 | 0 |
| 关系查询 | ✓ | ✗（KV）| ✓✓ OLAP | ✓✓ | ✗ |
| ACID | ✓ | ✓ | ✓ | ✓ | ✗ |
| 跨 SQLite/PG ORM | drizzle ✓ | drizzle ✗ | drizzle ✗ | drizzle ✓ | N/A |
| External Phase 4 切 Postgres 平滑 | ✓ | 重写 | 重写 | 已是 | 重写 |
| Bundle size 增量 | ~2MB（better-sqlite3 native）| 小 | ~30MB | 0 | 0 |
| 测试友好 | `:memory:` | partial | ✓ | 需 testcontainers | ✓ |
| 与 OpenCode 同栈 | ✓ | ✗ | ✗ | (External Phase 4 同) | ✗ |

**SQLite 胜在**：跨阶段平滑（External Phase 1 SQLite → External Phase 4 Postgres，drizzle 同 ORM 仅切 dialect）、与 OpenCode 同栈降低生态学习成本、bundle size 可接受。

**为什么不直接跳过 SQLite 上 Postgres**：
- External Phase 1 单 orchestrator 部署，Postgres 是过度工程
- 个人 / 小团队 self-host 不该被强制装数据库
- SQLite `:memory:` 单元测试比 Postgres testcontainers 快 100x

### 8.5 External Phase 1 数据迁移（从文件到 SQLite）

升级到 External Phase 1 orchestrator 时一次性 import：

```ts
// scripts/migrate-to-sqlite.ts (External Phase 1 升级工具)
async function migrateFromFiles() {
  const db = drizzle(new Database('/var/lib/qwen/qwen.db'))
  
  // 1. permission_decisions 从 settings.json 抽取
  const settings = JSON.parse(await fs.readFile('~/.qwen/settings.json', 'utf-8'))
  for (const rule of settings.permissions?.alwaysAllow ?? []) {
    await db.insert(permissionDecisions).values({
      tenantId: 'default',
      workspaceId: 'default',
      pattern: rule,
      scope: 'global',
      decision: 'allow',
    })
  }
  
  // 2. tokens 类似 import
  // 3. audit_log JSONL 顺序导入
  // 4. transcript / skill registry / settings 留在文件，不动
}
```

迁移可逆——保留原 JSON 文件，SQLite 仅作为运行时 mirror。**External Phase 1 → 切回纯文件**只需 SQL `SELECT * INTO json_export.json` + 删 db 文件。

## 九、SQLite 选型理由（External Phase 1-3 适用）

### 9.1 优点

- **零部署**：embedded，daemon 启动时 open file 即可
- **WAL 模式**：高并发读 + 单写者；External orchestrator 用于跨 daemon 聚合 audit / quota / permission decisions 时多 daemon 并发写
- **单文件备份**：`cp qwen.db backup.db` 即可
- **跨平台**：Linux / macOS / Windows 一致
- **drizzle-orm 一线支持**：与 OpenCode 同栈
- **测试友好**：`:memory:` 数据库 + 单元测试快速重置

### 9.2 限制

- **单写者**：所有写串行；高并发写场景（>100 写/秒）会成瓶颈
- **单进程**：daemon 重启时锁定文件（不支持多进程同时写）
- **不支持跨机**：无 replication / clustering
- **大数据量**：超 100GB 性能下降（适合中小 deployment）
- **新依赖成本**：`better-sqlite3` 是 native module，需要 prebuild binary 或编译环境

### 9.3 适用边界

```
Stage 1 / 1.5 / 2 (qwen-code 主线): JSON / JSONL 文件足够，不引入
External Phase 1 (orchestrator + 多租户):       SQLite 引入（permission/audit/tokens）
External Phase 1 多租户:               SQLite 撑万级 tenant + 百万级 audit log
External Phase 2-3 + sandbox:                     同上
─────────────────────────────────────────────
External Phase 4 多 daemon 实例:                SQLite 不够，必须升级 Postgres
```

## 十、何时需要外部 RDBMS

5 个明确触发外部 RDBMS 的场景：

| 触发 | 详细 | 推荐方案 |
|---|---|---|
| **多 daemon 实例（External Phase 4 SaaS）** | k8s 部署多 daemon worker pod 共享状态 | Postgres / MySQL + sticky session |
| **跨数据中心 / 灾备** | 主从复制 / 异地容灾 | Postgres streaming replication |
| **企业合规（PII 不落本地）** | 审计日志必须写入 SOC2 合规存储 | 外部 Postgres + TDE 加密 |
| **Analytics（跨 tenant BI 查询）** | 数据分析师查跨 tenant 用量趋势 | Postgres + read replica |
| **超大规模 audit log** | TB 级历史，SQLite 单文件吃不下 | Postgres 分区表 / TimescaleDB |

**反向案例（不需要外部 RDBMS）**：
- 单团队内部 daemon
- self-hosted 小项目
- 离线 / 局域网部署
- 个人开发者本地

## 十一、Storage Adapter 抽象设计

### 11.1 Interface

```ts
// packages/server/src/storage/StorageAdapter.ts (External Phase 4 新增)
export interface StorageAdapter {
  // 启动 / 关闭
  init(): Promise<void>
  close(): Promise<void>
  
  // Tenant
  tenants: TenantStorage
  
  // Workspace
  workspaces: WorkspaceStorage
  
  // Session 元信息（transcript 走文件）
  sessions: SessionStorage
  
  // Permission decisions
  permissions: PermissionDecisionStorage
  
  // Audit log
  audit: AuditStorage
  
  // Background tasks meta
  tasks: BackgroundTaskStorage
  
  // Health
  ping(): Promise<{ ok: boolean, latencyMs: number }>
}

// 4 个实现
class SqliteAdapter implements StorageAdapter {  // External Phase 1-3 默认
  constructor(path: string) { ... }
}
class PostgresAdapter implements StorageAdapter {  // External Phase 4 推荐
  constructor(connectionString: string) { ... }
}
class MysqlAdapter implements StorageAdapter {  // External Phase 4 可选
  constructor(connectionString: string) { ... }
}
class InMemoryAdapter implements StorageAdapter {  // 单元测试用
  constructor() { ... }
}
```

### 11.2 配置选择

```json
// /etc/qwen/daemon.json
{
  "storage": {
    "type": "sqlite",                        // sqlite | postgres | mysql | memory
    "sqlite": { "path": "/var/lib/qwen/qwen.db" },
    "postgres": {
      "host": "postgres.internal",
      "port": 5432,
      "database": "qwen",
      "user": "qwen",
      "password": "${secret:postgres-pass}",
      "ssl": "require",
      "poolSize": 20
    },
    "mysql": { /* 类似 */ }
  }
}
```

### 11.3 与现有 Qwen Code 协调

Qwen Code 当前用什么？

```bash
$ find /root/git/qwen-code/packages -name "package.json" 2>/dev/null \
  | xargs grep -l "drizzle\|better-sqlite3\|sequelize\|typeorm\|prisma" 2>/dev/null
# (检查现有依赖)
```

如果 Qwen Code 还没有 ORM，daemon 化引入 `drizzle-orm` 是合理选择（与 OpenCode 一致）；如果已有其他 ORM，需评估迁移成本。

## 十二、ORM 选型：drizzle-orm

### 12.1 为什么 drizzle

| 标准 | drizzle-orm | TypeORM | Prisma | Sequelize |
|---|---|---|---|---|
| **TypeScript 优先** | ✓ 原生 | ✓ | ✓ | partial |
| **多数据库支持** | ✓ SQLite/PG/MySQL | ✓ | ✓ | ✓ |
| **SQL-like API** | ✓ 写起来像 SQL | OOP | DSL | OOP |
| **Bundle size** | 小 | 大 | 中 | 大 |
| **OpenCode 已用** | ✓ | ✗ | ✗ | ✗ |
| **Bun 兼容** | ✓ | partial | partial | ✓ |
| **drizzle-kit migration** | ✓ | typeorm migrations | prisma migrate | sequelize-cli |

**选择 drizzle-orm 的关键理由**：与 OpenCode 同栈降低生态学习成本（2 个项目共享同一套 schema 模式 / migration 工具）。

### 12.2 跨数据库 schema

```ts
// packages/server/src/storage/schema/sqlite.ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

export const permissionDecisions = sqliteTable('permission_decisions', {
  tenantId: text('tenant_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  pattern: text('pattern').notNull(),
  scope: text('scope').notNull(),              // 'session' | 'workspace' | 'global'
  decision: text('decision').notNull(),         // 'allow' | 'deny'
  expiresAt: integer('expires_at'),             // unix ms, NULL = 永久
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.workspaceId, t.pattern, t.scope] }),
  idxTenant: index('idx_perm_tenant').on(t.tenantId),
}))

// packages/server/src/storage/schema/postgres.ts (并行版本)
import { pgTable, text, bigint, primaryKey, index } from 'drizzle-orm/pg-core'

export const permissionDecisions = pgTable('permission_decisions', {
  tenantId: text('tenant_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  pattern: text('pattern').notNull(),
  scope: text('scope').notNull(),
  decision: text('decision').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.workspaceId, t.pattern, t.scope] }),
  idxTenant: index('idx_perm_tenant').on(t.tenantId),
}))
```

### 12.3 查询 API（跨数据库一致）

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3'  // 或 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'

const db = drizzle(connection)

// 跨数据库一致 API
const decisions = await db
  .select()
  .from(permissionDecisions)
  .where(and(
    eq(permissionDecisions.tenantId, tenantId),
    eq(permissionDecisions.workspaceId, workspaceId),
  ))
```

## 十三、完整 Schema 设计

### 13.1 核心表

```ts
// 1. Tenants
export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),               // 'tenant-alice'
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
  configRev: integer('config_rev').default(0), // 配置变更计数（hot reload）
})

// 2. Tokens
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),                // 'tok-xxx'
  tenantId: text('tenant_id').references(() => tenants.id),
  secretHash: text('secret_hash').notNull(),  // bcrypt hash
  scope: text('scope').notNull(),             // JSON array of patterns
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
}, (t) => ({
  idxTenant: index('idx_tokens_tenant').on(t.tenantId),
}))

// 3. Workspaces
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),                // 'ws-xxx' unguessable
  tenantId: text('tenant_id').references(() => tenants.id).notNull(),
  directory: text('directory').notNull(),     // /work/repo-a (real path)
  worktree: text('worktree'),
  createdAt: integer('created_at').notNull(),
  disposedAt: integer('disposed_at'),
}, (t) => ({
  uniqTenantDir: uniqueIndex('uniq_tenant_dir').on(t.tenantId, t.directory),
  idxTenant: index('idx_ws_tenant').on(t.tenantId),
}))

// 4. Sessions（meta only，transcript 走文件）
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                // 'sess-xxx' unguessable
  workspaceId: text('workspace_id').references(() => workspaces.id).notNull(),
  transcriptPath: text('transcript_path').notNull(),  // /var/lib/qwen/transcripts/<id>.jsonl
  currentModel: text('current_model'),
  currentMode: text('current_mode'),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
  lastActivityAt: integer('last_activity_at').notNull(),
}, (t) => ({
  idxWs: index('idx_sess_ws').on(t.workspaceId),
  idxLastActivity: index('idx_sess_last_activity').on(t.lastActivityAt),
}))

// 5. Permission decisions
export const permissionDecisions = sqliteTable('permission_decisions', {
  tenantId: text('tenant_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  pattern: text('pattern').notNull(),
  scope: text('scope').notNull(),
  decision: text('decision').notNull(),
  expiresAt: integer('expires_at'),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.workspaceId, t.pattern, t.scope] }),
  idxTenant: index('idx_perm_tenant').on(t.tenantId),
}))

// 6. Audit log
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenantId: text('tenant_id').references(() => tenants.id).notNull(),
  timestamp: integer('timestamp').notNull(),
  clientIp: text('client_ip'),
  method: text('method').notNull(),
  path: text('path').notNull(),
  workspaceId: text('workspace_id'),
  sessionId: text('session_id'),
  toolName: text('tool_name'),
  decision: text('decision'),
  details: text('details'),                   // JSON blob
}, (t) => ({
  idxTenantTs: index('idx_audit_tenant_ts').on(t.tenantId, t.timestamp),
}))

// 7. Background tasks (meta only)
export const backgroundTasks = sqliteTable('background_tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => sessions.id).notNull(),
  kind: text('kind').notNull(),               // 'agent' | 'shell' | 'monitor' | 'dream'
  status: text('status').notNull(),           // 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
  description: text('description'),
  payload: text('payload'),                    // JSON blob (kind-specific)
  createdAt: integer('created_at').notNull(),
  terminatedAt: integer('terminated_at'),
  exitCode: integer('exit_code'),
  errorMessage: text('error_message'),
}, (t) => ({
  idxSession: index('idx_task_session').on(t.sessionId),
  idxStatus: index('idx_task_status').on(t.status),
}))

// 8. Tenant quotas (per-window counters)
export const tenantQuotas = sqliteTable('tenant_quotas', {
  tenantId: text('tenant_id').references(() => tenants.id).notNull(),
  windowKey: text('window_key').notNull(),    // 'day:2026-05-06' / 'hour:2026-05-06T03'
  llmTokensUsed: integer('llm_tokens_used').default(0),
  toolCallsUsed: integer('tool_calls_used').default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.windowKey] }),
}))
```

### 13.2 大 blob 不入库：Transcript 文件

**为什么不入 RDBMS**：

| 维度 | RDBMS 大 blob | 文件系统 |
|---|---|---|
| 写入性能 | 一次性 INSERT，事务开销 | append-only，最快 |
| 增量追加 | UPDATE 整个 blob | append 部分 |
| 备份 | dump 时间 cubic 增长 | rsync / cp |
| 跨服务读 | 需 connection | NFS / S3 通用 |
| 长期归档 | warm storage 不便 | 可移到 S3 Glacier |

**Transcript 路径方案**：

```
/var/lib/qwen/
├─ tenants/
│   ├─ tenant-alice/
│   │   ├─ transcripts/
│   │   │   ├─ sess-xxx.jsonl
│   │   │   └─ sess-yyy.jsonl
│   │   └─ ...
│   └─ tenant-bob/
│       └─ transcripts/
└─ qwen.db                  ← SQLite 仅存 path 引用
```

SQLite 的 `sessions.transcript_path` 字段保存路径；daemon 读 transcript 时直接 open file（不通过 ORM）。

**S3 / OSS 长期归档**（External Phase 4+）：

```ts
// 老 transcript 自动迁移到 S3
const ARCHIVE_AFTER_DAYS = 30

async function archiveOldTranscripts() {
  const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 86400_000
  const oldSessions = await db.select().from(sessions)
    .where(and(
      lt(sessions.lastActivityAt, cutoff),
      isNull(sessions.archivedAt),
    ))
  
  for (const s of oldSessions) {
    const localPath = s.transcriptPath
    const s3Key = `tenants/${s.tenantId}/archived/${s.id}.jsonl.gz`
    
    await s3.upload(s3Key, gzip(await fs.readFile(localPath)))
    await db.update(sessions)
      .set({ archivedAt: Date.now(), transcriptPath: `s3://${bucket}/${s3Key}` })
      .where(eq(sessions.id, s.id))
    
    await fs.unlink(localPath)
  }
}
```

## 十四、External Phase 4 多 daemon 共享状态架构

### 14.1 架构图

```
┌──────────────────────────────────────────────────┐
│ k8s cluster                                       │
│                                                    │
│  Load Balancer (sticky session by tenant_id)       │
│      ↓                                             │
│  ┌─────────────┬─────────────┬─────────────┐      │
│  │ daemon-1    │ daemon-2    │ daemon-N    │      │
│  │ (pod)       │ (pod)       │ (pod)       │      │
│  └──────┬──────┴──────┬──────┴──────┬──────┘      │
│         │              │              │             │
│         ↓              ↓              ↓             │
│  ┌──────────────────────────────────────┐          │
│  │ Postgres cluster (主从)               │          │
│  │ - permission_decisions / audit_log    │          │
│  │ - tenants / workspaces / sessions     │          │
│  └──────────────────────────────────────┘          │
│                                                      │
│  ┌──────────────────────────────────────┐          │
│  │ Object storage (S3 / OSS / MinIO)     │          │
│  │ - transcripts/<tenant>/<sess>.jsonl   │          │
│  └──────────────────────────────────────┘          │
│                                                      │
│  ┌──────────────────────────────────────┐          │
│  │ Redis (可选，加速 hot path)            │          │
│  │ - session subscribers map             │          │
│  │ - quota counters (TTL)                │          │
│  │ - permission decision cache           │          │
│  └──────────────────────────────────────┘          │
└──────────────────────────────────────────────────┘
```

### 14.2 sticky session 设计

```yaml
# k8s Ingress sticky session
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "qwen-daemon-id"
    nginx.ingress.kubernetes.io/session-cookie-hash: "sha1"
```

**为什么需要 sticky**：
- 同一 session 的 SSE 长连接保持在同一 daemon pod
- 避免事件流被切到不同 pod 时丢失订阅状态

### 14.3 Redis 加速

可选优化（External Phase 4+），不是必须：

| 数据 | 何时进 Redis |
|---|---|
| **session subscribers** | 跨 daemon pod 共享订阅状态（主用 SSE 路由）|
| **quota counters** | 高频 increment，避免 Postgres 写阻塞 |
| **permission decision cache** | LRU 1000 条热点 pattern 命中 |

**External Phase 4+ later 加 Redis** —— 不是 External Phase 4 起步必需。

### 14.4 多 daemon 配置

```json
{
  "daemon": {
    "instanceId": "${HOSTNAME}",                // k8s pod name
    "storage": {
      "type": "postgres",
      "postgres": {
        "host": "postgres-primary.qwen.svc.cluster.local",
        "readReplicas": [
          "postgres-replica-1.qwen.svc.cluster.local",
          "postgres-replica-2.qwen.svc.cluster.local"
        ],
        "poolSize": 20
      }
    },
    "transcriptStorage": {
      "type": "s3",
      "bucket": "qwen-transcripts",
      "region": "us-west-2",
      "prefix": "tenants/"
    },
    "redis": {
      "url": "redis://redis.qwen.svc.cluster.local:6379",
      "useFor": ["subscribers", "quota", "permission_cache"]
    }
  }
}
```

## 十五、迁移与升级

### 15.1 drizzle-kit migration

```bash
# 生成迁移
$ pnpm drizzle-kit generate:sqlite
# 或
$ pnpm drizzle-kit generate:pg

# 应用
$ pnpm drizzle-kit push:sqlite
```

migration 文件提交到 repo（与 OpenCode 一致）：

```
packages/server/src/storage/migrations/
├─ 0001_initial.sql
├─ 0002_add_tenant_quotas.sql
├─ 0003_add_background_tasks_partition.sql  # Postgres 分区
└─ ...
```

### 15.2 SQLite → Postgres 迁移工具

```bash
# External Phase 3 → Phase 4 升级
$ qwen-migrate sqlite-to-postgres \
    --from /var/lib/qwen/qwen.db \
    --to "postgres://..." \
    --transcript-from /var/lib/qwen/transcripts \
    --transcript-to "s3://..."
```

迁移步骤：
1. **暂停 daemon**（read-only mode）
2. dump SQLite → 转为 Postgres SQL
3. transcript 同步到 S3
4. 启动新 Postgres-backed daemon
5. 验证数据完整性
6. 退役旧 daemon

### 15.3 多 daemon 同时升级

```yaml
# k8s rolling update
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1
    maxSurge: 1
```

要求 schema 向前兼容（新 daemon 能读旧 schema 一两个版本）。drizzle-kit 默认生成 additive migration（只加列 / 表，不破坏旧字段）。

## 十六、安全考虑

### 16.1 加密

| 数据 | 是否加密 | 方案 |
|---|---|---|
| Transcript（含 LLM 对话）| **应该** | 文件系统 LUKS / S3 SSE-S3 / SSE-KMS |
| Tenant API keys / OAuth tokens | **必须** | AES-GCM with master key（master key 在 KMS / HSM）|
| Audit log | optional | 整库 TDE（PostgreSQL）|
| Bearer token secret | **必须** | bcrypt hash 存（不存明文）|

### 16.2 敏感字段示例

```json
// /etc/qwen/tenants/alice.json
{
  "providers": {
    "dashscope": {
      "apiKey": "${enc:AESGCM:base64-ciphertext}"
    }
  }
}
```

```ts
// daemon 启动时解密
const masterKey = await loadFromKms('qwen-master-key')
const config = decryptSensitiveFields(rawConfig, masterKey)
```

### 16.3 权限隔离

```bash
# SQLite 文件
chmod 600 /var/lib/qwen/qwen.db
chown qwen:qwen /var/lib/qwen/qwen.db

# Transcript 目录
chmod 700 /var/lib/qwen/transcripts
chmod 600 /var/lib/qwen/transcripts/*.jsonl

# Postgres
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qwen_app;
REVOKE ALL ON pg_catalog FROM qwen_app;
```

## 十七、性能基准（推测）

实测数据需要落地后 benchmark；下面是合理估算：

| 场景 | SQLite | Postgres | MySQL |
|---|---|---|---|
| 单 daemon 1k tenant + 10k session 启动 | <1s | 1-2s（连接池暖）| 1-2s |
| Permission decision 查询（hot cache）| <0.1ms | 1-2ms（含网络）| 1-2ms |
| Audit log 1k 写/秒 | OK（WAL）| OK | OK |
| Audit log 10k 写/秒 | 瓶颈 | OK（partitioning）| OK |
| 跨 daemon session 订阅同步 | ❌ | ✓ via PUB/SUB | ✓ |
| 100GB audit log 历史查询 | ❌ 慢 | ✓ partition + index | ✓ |

## 十八、与 OpenCode / Claude Code 多租户对比

| 维度 | OpenCode | Claude Code | Qwen daemon |
|---|---|---|---|
| 多租户支持 | ❌（单用户）| ❌（单用户）| ✅ External Phase 1+ |
| 认证模式 | 单 password | API key | Bearer / OIDC / mTLS |
| Quota | ❌ | Anthropic API rate-limit（被动）| 主动 quota engine |
| Audit | ❌ | Anthropic console | 4 通道可选 |
| Sandbox | ❌ | Linux PID namespace | 4 本地 + 4 远程方案（§11）|
| SaaS 模式 | ❌ | Anthropic Managed Agents（闭源）| External Phase 4 自托管 SaaS |

## 十九、关键权衡

### 9.1 Orchestrator 单点 vs 高可用

orchestrator 是 SaaS 部署的关键路径——挂了所有用户无法 spawn 新 daemon。设计上：

- **现有 daemon 不受影响**——已 spawn 的 daemon instance 直接服务现有 client（沿用 [§17 §discovery 协议](./17-remote-cli-mode.md)）
- **新建 session 阻塞**——orchestrator 不可用时 client 短期重试 + UI 提示
- **HA 设计**：orchestrator 自身多副本 + Postgres 主备 + Redis Sentinel + 负载均衡（参考 [§16 5 层 HA 架构](./16-high-availability.md)）

### 9.2 Quota 准确性 vs 性能

| 模式 | 准确性 | 性能 |
|---|---|---|
| Synchronous Redis check + atomic incr | ✅ 强一致 | ~1ms / 调用 |
| Async batch upload（每 N 秒）| ⚠️ 滞后 N 秒 | ~0.01ms |
| Token bucket local + sync to Redis | ⚠️ 半异步 | ~0.1ms |

**推荐**：LLM token 配额走 sync atomic（必须强一致防止巨额超额）；shell calls / file writes 走 async batch（容忍秒级滞后）。

### 9.3 Daemon 端 vs Orchestrator 端 Quota 决策

| 决策位置 | 优势 | 劣势 |
|---|---|---|
| Daemon 端 | 延迟低 | 各 daemon 必须 sync state（推回 orchestrator）|
| Orchestrator 端 | 单点决策 | 每次 LLM 调用多一跳 RPC |

**推荐**：orchestrator 端集中决策 + reservation 模式（daemon 预扣 + 实际消耗后差额结算）—— 单一真相源，daemon 实现简单。

## 二十、一句话总结

[§03 §2](./03-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session" 模型把 multi-tenancy 从 daemon 内挤出到 orchestrator 层——daemon 进程级隔离消除 daemon 内 cross-tenant 问题，daemon 代码 0 tenant 感知。  
**Orchestrator 承担 4 件事**：(1) 认证（Bearer / OIDC / mTLS）+ 授权（tenant → workspace 映射）；(2) Quota 引擎（reservation 模式 + Redis 原子）；(3) Audit log（4 通道）；(4) Daemon 生命周期 + sandbox 配置 spawn。  
**SaaS 实施 4 Phase（External）**：Phase 1 多租户基础（~1-2w）→ Phase 2 加沙箱（~2-3w）→ Phase 3 远程沙箱（~2w）→ Phase 4 完整 SaaS（~1-2m）。  
**与 OpenCode / Claude Code 差异**：本设计是唯一原生支持多租户 SaaS 的架构（OpenCode / Claude Code 均单用户）。

---

[← 上一篇：单 vs 多 Session 设计深度对比](./21-single-vs-multi-session-design.md) · [回到 README](./README.md)
