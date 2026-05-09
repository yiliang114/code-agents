# 19 — 长跑稳定性与可观测性

> [← 上一篇：多端协调策略](./18-client-coordination.md) · [回到 README](./README.md)

> 多租户 daemon 跑 24h+ 的稳定性设计。Node.js 长跑 7 类风险、多租户加剧的 5 类风险、qwen daemon 10 个具体泄漏点、9 项稳定性模式、6 类 native module 风险、Bun vs Node.js 长跑实测、与 §16 HA / §18 协同。

> **稳定性要点**（[§03 §2](./03-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session"下）：
>
> - **Crash isolation 免费**——一 session 跑爆不影响其他 session
> - **Resource cleanup 简单**——kill daemon = 清理所有 fd / child process / memory
> - **§四 10 个泄漏点中 5 个自动消失**：session TTL / FileReadCache 累积 / Background task 残留 / permission decision cache / subscriber queue 累积——daemon 退出即释放
> - **Daemon pool 管理**（idle daemon hibernation / lazy spawn / 内存上限）在 orchestrator 层
> - **本章作用对象**：单 daemon instance 内仍有内存增长 / 监听器累积 / native crash 等问题，9 项稳定性模式仍适用

## 一、TL;DR

| 维度 | 设计 |
|---|---|
| 设计哲学 | **接受"重启不可避免"** —— 不追求永不重启，目标 12-72h 稳跑 + 滚动重启清状态 |
| Node.js 长跑能力 | ✓ 14 年生产验证（Netflix / LinkedIn / Uber），需主动管理 7 类风险 |
| 多租户额外风险 | 故障半径 / 资源争抢 / SLO 下限 / leak 累积 / 审计取证 |
| 9 项稳定性模式 | TTL / bounded / resource quota / circuit breaker / memory threshold restart / heap dump / liveness / native supervisor / process isolation |
| 重启成本接近 0 | 通过 §16 HA（multi-pod + sticky + drain + SSE 重连）实现 |
| 监控告警 | 10+ Prometheus 指标 + 主动 chaos testing |
| Bun vs Node.js | dev Bun（启动快）/ prod Node.js（长跑稳） |

## 二、Node.js 长跑 7 类风险详解

### 2.1 V8 heap 增长（最常见 leak）

**机制**：模块单例累积 / 闭包持有引用 / EventEmitter listener 不解绑 / Promise 链未释放 / Map 无 LRU。

**典型表现**：
```
RSS 缓慢上升（每天 +50-200MB）
→ 24-72h 后 RSS > Node max-old-space-size (默认 ~1.5GB)
→ V8 触发 GC 失败 → Allocation failed - JavaScript heap out of memory
→ 进程崩溃
```

**历史案例**：
- LinkedIn 2014：EventEmitter listener 累积 → 重写为 weakref pattern 后 RSS 稳定
- Netflix 2016：closure 持有 HTTP request body buffer → 修复后内存下降 30%

**检测**：
```bash
# 拿 heap snapshot
node --inspect=0.0.0.0:9229 daemon.js
# Chrome DevTools → Memory → take snapshot → 对比两个 snapshot

# 或用 clinic.js
$ npx clinic doctor -- node daemon.js
```

### 2.2 GC stop-the-world 拉长

**机制**：old gen 大 → mark-sweep 慢 → 事件循环阻塞。

**触发条件**：
- heap > 1GB 时 mark-sweep 可达 1-3s
- 大对象（Buffer / 长字符串）跨多次 GC 不释放
- "promotion gradient" 不健康——young → old 速率高

**典型表现**：
```
正常: p99 latency = 50ms
GC 时: p99 latency 飙到 1-3s（每分钟几次）
对外: 看起来像 random latency spike
```

**调优**：
```bash
# 增加 max-old-space-size（默认 1.5GB → 4GB）
node --max-old-space-size=4096 daemon.js

# 用 incremental marking + 减少 promotion
node --max-old-space-size=4096 \
     --max-semi-space-size=128 \
     --optimize_for_size \
     daemon.js
```

### 2.3 文件描述符泄漏

**机制**：`fs.open` / `net.Socket` / `child_process.spawn` 不 close。

**触发条件**：
- 错误路径漏 close（异常前 open，没 finally）
- SSE 长连接异常断开但 server 端未释放
- MCP child stdio 不 inherit 也不 destroy

**典型表现**：
```
正常: process_open_fds = 100-500
泄漏: 24h 后 = 5000+
触发: EMFILE: too many open files (rlimit 1024 默认)
```

**Node 默认 rlimit 1024，prod 应该提高**：
```bash
ulimit -n 65536    # 进程级
# 或 systemd unit
LimitNOFILE=65536
```

### 2.4 child process 僵尸

**机制**：spawn 后子进程退出，父没 waitpid → zombie。

**典型源**：
- MCP server child 异常退出未 reap
- LSP server child 同上
- Bash sandbox child 同上

**检测**：
```bash
ps -ef | awk '$3 == 1 { print }' | grep '<defunct>'
```

**修复**：用 `child_process.spawn` 而非 `child_process.exec`（自动 reap）；显式 listen `exit` 事件 + `child.unref()`。

### 2.5 uncaughtException / unhandledRejection

**机制**：异步错误漏接（`async function` 没 try/catch / Promise 没 .catch）。

**默认行为**（Node v15+）：unhandledRejection → process exit。

**多租户的危险**：一个 tenant 的 bad code → 整 pod 上所有 tenant 受牵连。

**正确处理**：
```ts
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException')
  // 不立即退出 —— graceful drain
  initiateGracefulShutdown('uncaughtException')
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'unhandledRejection')
  // 累计 N 次后才 graceful drain
  unhandledRejectionCounter.inc()
  if (unhandledRejectionCounter.value > 10) {
    initiateGracefulShutdown('too_many_unhandled_rejections')
  }
})
```

### 2.6 Native module 崩溃

**机制**：C++ 绑定 segfault / abort。Node.js 一旦 native 崩溃，整 V8 进程死。

**高风险 native module（在本设计涉及）**：
- `better-sqlite3` — sqlite3.dll/.so segfault 历史
- `node-pty` — 终端 PTY child 控制
- `@modelcontextprotocol/sdk` — stdio 解析
- 任何 zlib / native crypto wrapper

**防御**：见 §六 native module 章节。

### 2.7 AsyncLocalStorage 链表保留

**机制**：每次 `als.run()` 创建新 context node，被 promise 链持有 → 长跑 promise 持有 ctx 链。

**典型源**：
```ts
// 错误：long-running 后台任务持有当前 tool call 的 ctx
storage.run({ workspaceId, sessionId }, async () => {
  spawnLongLivedBackground()  // ← 这个 task 跑 1h+，持有 ctx 链
})
```

**修复**：背景任务用 `AsyncResource.bind` 显式拷贝 ctx 或用 `runOutsideContext`。

## 三、多租户加剧的 5 类风险

|  | 单租户 daemon | 多租户 daemon | 差异 |
|---|---|---|---|
| **故障半径** | 一人受影响 | 一坏租户拖垮 N 租户 | × N |
| **资源争抢** | 自己负载自己懂 | tenant A 1000 session 挤压 tenant B | 公平性问题 |
| **质量下限** | 自我管理（重启即可）| 必须保证 SLO（99.9%）| 不能随便 down |
| **leak 累积** | 重启容易 | rolling restart 影响所有 tenant 活 SSE | 重启成本高 |
| **审计 / 取证** | 看 log 即可 | 必须 per-tenant 隔离 + 留存 | 合规要求 |

## 四、qwen daemon 具体的 10 个泄漏点

[§14 实体模型](./14-entity-model.md) 5 层每层都有典型 leak 模式。下面给具体代码 + 防御实现。

### 4.1 Session 不过期

**风险**：决策 §1 'single' scope + 多 client 共享 → client 全断开但 session 永驻内存。

**Bug 代码**：
```ts
class Session {
  // ❌ 没有 idle timeout
  async addSubscriber(sub: Subscriber) {
    this.subscribers.add(sub)
  }
  
  removeSubscriber(sub: Subscriber) {
    this.subscribers.delete(sub)
    // ❌ 即使 subscribers 全空也不 unload
  }
}
```

**修复**：
```ts
class Session {
  private idleStartedAt: number | null = null
  private static IDLE_TTL = 7 * 86400 * 1000  // 7 days
  
  removeSubscriber(sub: Subscriber) {
    this.subscribers.delete(sub)
    if (this.subscribers.size === 0) {
      this.idleStartedAt = Date.now()
    }
  }
  
  shouldUnload(): boolean {
    return this.subscribers.size === 0 &&
           this.idleStartedAt !== null &&
           Date.now() - this.idleStartedAt > Session.IDLE_TTL
  }
}

// 后台 cleanup loop（每 30s）
setInterval(() => {
  for (const sess of allSessions.values()) {
    if (sess.shouldUnload()) sess.unload()
  }
}, 30_000)
```

### 4.2 Subscriber Set 不收敛

**风险**：TCP RST 丢失 / NAT 表过期 → stale subscriber 永驻。

**修复**：参考 [§18 §五 liveness 协议](./18-client-coordination.md)。

### 4.3 FileReadCache 累积

**风险**：session-private 但 session 不死 → cache 跟着不死；session 内 cache 无 entries 上限。

**Bug**：
```ts
class FileReadCache {
  private cache = new Map<DevInodeKey, FileReadEntry>()  // ❌ 无上限
  
  set(key, entry) { this.cache.set(key, entry) }  // ❌ 不驱逐
}
```

**修复**：LRU + size cap
```ts
import { LRUCache } from 'lru-cache'

class FileReadCache {
  private cache = new LRUCache<DevInodeKey, FileReadEntry>({
    max: 100,                 // 单 session 最多 100 文件
    maxSize: 50 * 1024 * 1024,  // 总 50MB
    sizeCalculation: (entry) => entry.content.length,
    ttl: 60 * 60 * 1000,       // 1h 自动过期
  })
}
```

### 4.4 Background task 残留

**风险**：shell PTY 死循环 / agent fork 卡住 / monitor 永跑 → task entry + 子进程不删。

**Bug**：
```ts
class BackgroundTaskManager {
  private tasks = new Map<TaskId, Task>()
  
  spawn(...) {
    const task = new Task(...)
    this.tasks.set(task.id, task)
  }
  
  // ❌ 没有完成事件或最大寿命
}
```

**修复**：
```ts
class Task {
  private static MAX_LIFETIME_MS = {
    'agent': 60 * 60 * 1000,      // 1h
    'shell': 24 * 60 * 60 * 1000,  // 24h
    'monitor': Infinity,            // 显式 stop
    'dream': 5 * 60 * 1000,        // 5 min
  }
  
  async start() {
    this.startedAt = Date.now()
    setTimeout(() => {
      if (this.status === 'running') {
        this.kill('lifetime_exceeded')
      }
    }, MAX_LIFETIME_MS[this.kind])
  }
  
  onComplete() {
    // 立即清 entry（不等 ttl）
    backgroundTaskManager.tasks.delete(this.id)
  }
}

// 全局 max active tasks per session
const MAX_ACTIVE_TASKS_PER_SESSION = 10
```

### 4.5 MCP 子进程 zombie

**风险**：MCP config 变化 reload，旧 client 引用未释放 → child 残留。

**Bug**：
```ts
async reloadMcp() {
  // ❌ 直接覆盖 Map，旧 client 引用丢失但子进程还在
  this.mcpClients = new Map()
  await this.connectAll()
}
```

**修复**（OpenCode 模式）：
```ts
async reloadMcp() {
  const oldClients = Array.from(this.mcpClients.values())
  
  // 1. 先建新连接
  const newClients = await this.connectAll()
  
  // 2. 切换引用
  this.mcpClients = newClients
  
  // 3. 关闭旧 client（带超时强 kill）
  await Promise.allSettled(
    oldClients.map(async (c) => {
      const closed = c.close()
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('close timeout')), 5000))
      try {
        await Promise.race([closed, timeout])
      } catch {
        c.process?.kill('SIGKILL')  // 兜底强杀
      }
    })
  )
}
```

### 4.6 LSP 子进程同上

**风险**：Workspace.dispose() 时 LSP child 没 close。

**修复**：cascade close
```ts
class Workspace {
  async dispose() {
    // 顺序：先停 active session，再关 children
    await Promise.all(this.sessions.map(s => s.unload()))
    
    await Promise.allSettled([
      this.lspServer?.close(),
      this.mcpManager.dispose(),
    ])
    
    // 强杀兜底
    setTimeout(() => {
      this.lspServer?.process?.kill('SIGKILL')
    }, 10_000)
  }
}
```

### 4.7 AsyncLocalStorage 链表

**风险**：long-running promise 持有 Instance ctx → ctx 链永久持有 tenantId / workspaceId。

**Bug**：
```ts
storage.run({ tenantId, sessionId }, async () => {
  // ❌ 这个 task 跑 1h+，期间 ctx 被链表持有
  spawnLongRunningBackgroundAgent()
})
```

**修复**：背景任务**显式跳出 ctx**
```ts
import { AsyncResource } from 'node:async_hooks'

storage.run({ tenantId, sessionId }, async () => {
  // 拷贝必要字段，不传 ctx
  const snapshot = { tenantId, sessionId }
  
  // 背景任务在新 ctx 内跑
  AsyncResource.bind(() => {
    storage.run(snapshot, () => {
      spawnLongRunningBackgroundAgent()
    })
  })()
})
```

### 4.8 Permission decision cache

**风险**：tenant + workspace + pattern 三键 cache 无上限。

**修复**：
```ts
import { LRUCache } from 'lru-cache'

const permissionCache = new LRUCache<string, Decision>({
  max: 1000,           // per tenant
  ttl: 60 * 60 * 1000,  // 1h（与 SQLite 持久化层结合，热点 cache）
})

// Cold path 走 Postgres / SQLite
function getDecision(tenantId, workspaceId, pattern) {
  const key = `${tenantId}:${workspaceId}:${pattern}`
  let d = permissionCache.get(key)
  if (!d) {
    d = db.permissionDecisions.findOne({ ... })
    if (d) permissionCache.set(key, d)
  }
  return d
}
```

### 4.9 Audit log 内存缓冲

**风险**：degraded mode（[§16 §十三](./16-high-availability.md)）下 buffer 不刷盘 → 内存爆。

**修复**：
```ts
class AuditLogBuffer {
  private buffer: AuditEntry[] = []
  private static MAX_BUFFER_BYTES = 10 * 1024 * 1024   // 10MB

  enqueue(entry: AuditEntry) {
    this.buffer.push(entry)
    if (this.estimatedSize() > MAX_BUFFER_BYTES) {
      // 丢老条目（保 audit 整体性 < 单条 entry）
      this.buffer.splice(0, Math.floor(this.buffer.length / 2))
      logger.warn('audit buffer overflow, dropped half')
      metrics.auditBufferOverflows.inc()
    }
  }

  async flushToPostgres() {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    await db.auditLog.insertMany(batch)
  }
}
```

### 4.10 Provider / Skill registry 拷贝

**风险**：每 session 拷一份 manifest（如 100 skills × 1KB = 100KB / session × 10000 sessions = 1GB 浪费）。

**修复**：共享 readonly 引用
```ts
// daemon-global immutable singleton
const skillRegistry = Object.freeze(loadSkills())

// session 内不拷贝，直接引用
session.skills = skillRegistry  // 同一引用
```

## 五、9 项稳定性模式

按落地阶段顺序：

### 5.1 Stage 3 必做（5 项）

#### 5.1.1 TTL 强制清理

```ts
class CleanupLoop {
  start() {
    setInterval(() => {
      this.cleanSessions()
      this.cleanSubscribers()
      this.cleanTasks()
      this.cleanCaches()
    }, 30_000)
  }
}
```

#### 5.1.2 Bounded 数据结构

所有 Map / Set / Cache 必须显式 max size：

```ts
import { LRUCache } from 'lru-cache'

// ✓
const cache = new LRUCache<K, V>({ max: 1000 })

// ✗ 禁止
const cache = new Map<K, V>()  // 无上限
```

#### 5.1.3 Graceful shutdown

已在 [§16 §八](./16-high-availability.md) 详细。

#### 5.1.4 uncaughtException / unhandledRejection 处理

见 §二.5。

#### 5.1.5 健康检查 / livez / readyz / metrics

完整端点设计见 §十.

### 5.2 Stage 4 多租户（4 项）

#### 5.2.1 Per-tenant 资源 quota

```jsonc
// /etc/qwen/tenants/<id>.json
{
  "quota": {
    "concurrent_sessions": 50,
    "concurrent_tasks": 100,
    "llm_tokens_per_hour": 1000000,
    "tool_calls_per_hour": 10000,
    "memory_soft_limit_mb": 500,
    "fd_soft_limit": 1000
  }
}
```

实现：
```ts
class TenantQuota {
  enforce(action: 'create_session' | 'spawn_task' | 'tool_call'): boolean {
    const usage = this.getUsage()
    const limit = this.getLimit()
    
    if (usage[action] >= limit[action]) {
      metrics.quotaExceeded.inc({ tenant: this.id, action })
      throw new QuotaExceededError({ action, usage, limit })
    }
    
    this.incrementUsage(action)
    return true
  }
}
```

#### 5.2.2 Circuit breaker per tenant

```ts
class TenantCircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  private errorCount = 0
  private successCount = 0
  
  recordError() {
    this.errorCount++
    if (this.errorCount > 50 && this.errorRate() > 0.5) {
      this.trip()
    }
  }
  
  trip() {
    this.state = 'open'
    setTimeout(() => this.state = 'half-open', 5 * 60 * 1000)
    logger.warn({ tenant: this.tenantId }, 'circuit_breaker_tripped')
  }
  
  canProceed(): boolean {
    return this.state !== 'open'
  }
}
```

#### 5.2.3 Memory threshold 触发滚动重启

```ts
function memoryWatchdog() {
  setInterval(async () => {
    const rss = process.memoryUsage().rss
    const limit = parseInt(process.env.POD_MEMORY_LIMIT_BYTES || '4294967296')
    
    if (rss > limit * 0.85) {
      logger.warn({ rss, limit }, 'memory_threshold_exceeded')
      metrics.memoryWatchdogTrigger.inc()
      
      // 主动 graceful drain → exit → k8s rolling restart
      await initiateGracefulShutdown('memory_threshold')
    }
  }, 60_000)
}
```

#### 5.2.4 Heap dump on demand

```ts
import v8 from 'node:v8'

app.post('/debug/heapdump', requireAdminToken, (c) => {
  const filename = `/tmp/heap-${Date.now()}.heapsnapshot`
  v8.writeHeapSnapshot(filename)
  
  // 上传到 S3 + 返回链接
  return uploadToS3(filename)
})
```

仅 admin token 可访问，避免 DoS（heap snapshot 期间 stop-the-world）。

### 5.3 Stage 6 SaaS 增强（3 项）

#### 5.3.1 Worker thread 隔离

把高风险任务（LLM streaming / 大 transcript 序列化）放 worker：

```ts
import { Worker } from 'node:worker_threads'

class LlmStreamWorker {
  private worker = new Worker('./workers/llm-stream.js')
  
  async stream(prompt) {
    return new Promise((resolve, reject) => {
      this.worker.postMessage({ prompt })
      this.worker.on('message', resolve)
      this.worker.on('error', reject)
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          // worker 死了 → 主进程不死
          this.respawn()
        }
      })
    })
  }
}
```

**优点**：
- worker 崩溃不影响主进程
- 独立 V8 isolate（heap 独立）
- main thread 事件循环不阻塞

**缺点**：
- IPC 序列化开销
- 不能共享 native module 实例（每 worker 独立加载）

#### 5.3.2 Scheduled rolling restart

每 24-48h 主动 rolling restart：

```yaml
# k8s CronJob
apiVersion: batch/v1
kind: CronJob
metadata:
  name: qwen-daemon-rolling-restart
spec:
  schedule: "0 4 * * *"   # 每天凌晨 4 点
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: kubectl
            image: bitnami/kubectl
            command:
            - kubectl
            - rollout
            - restart
            - statefulset/qwen-daemon
```

#### 5.3.3 Memory profiler in prod

5% 流量做 sampling profile：

```ts
import { Profiler } from 'inspector'

if (Math.random() < 0.05) {
  const profiler = new Profiler()
  profiler.start()
  
  setTimeout(async () => {
    const profile = await profiler.stop()
    await uploadToS3(`profiles/${Date.now()}.cpuprofile`, profile)
  }, 60_000)  // 1 min 采样
}
```

## 六、6 类 Native module 风险

### 6.1 better-sqlite3

**已知问题**：
- SQLite 库本身的 segfault 历史（v3.35-v3.40 几个 bug）
- WAL 文件 lock 异常 → process hang
- 多线程访问（worker_threads 共享 db handle）→ 段错误

**防御**：
- 锁定版本到 stable patch（如 better-sqlite3 11.x）
- 仅在主线程操作 db
- 启用 WAL + busy_timeout
- crash 时主进程退出（`db.exec` 失败立即 graceful drain）

```ts
const db = new Database(path, {
  fileMustExist: false,
  timeout: 5000,  // busy timeout
})
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
```

### 6.2 node-pty

**已知问题**：
- macOS pty 偶发 ENXIO
- Windows ConPTY 大 buffer 卡死
- child 退出后 pty fd 不 close

**防御**：
- 显式 `pty.kill()` + listen exit
- prefer macOS / Linux for prod（Windows pty 不稳）
- pty timeout 30 min

### 6.3 @modelcontextprotocol/sdk

**已知问题**：
- stdio 解析对 partial JSON 处理 bug 历史
- 大 message（>1MB）OOM
- 服务端 abort 时 client 不 close

**防御**：
- message size limit（10KB）
- 30s read timeout
- supervisor restart MCP child

### 6.4 zlib / native crypto

**已知问题**：
- gzip stream 在大 payload 上 leak
- crypto.subtle 历史几个 timing bug

**防御**：
- 用 stream API 而非一次性 deflate
- crypto 用 standard API（不自己 wrap）

### 6.5 node-canvas / sharp（图片处理）

通常 daemon 不直接处理图片，但若有 vision tool：

**已知问题**：
- libvips / cairo native binding 偶发 segfault on malformed input
- 大图片 OOM

**防御**：
- worker thread 隔离
- input size validation

### 6.6 通用防御：Native module supervisor

```ts
class NativeModuleSupervisor {
  private crashes = new Map<string, number>()
  
  guard<T>(module: string, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      this.crashes.set(module, (this.crashes.get(module) || 0) + 1)
      
      if (this.crashes.get(module) > 5) {
        // 同 module 5 分钟内崩 5 次 → graceful drain
        initiateGracefulShutdown(`native_module_unstable:${module}`)
      }
      
      throw err
    }
  }
}
```

## 七、Memory budget per tenant

### 7.1 软限制（应用层 enforce）

```ts
class TenantMemoryTracker {
  private bytes = 0
  
  track(delta: number) {
    this.bytes += delta
    if (this.bytes > this.softLimit) {
      // 软限制 → 警告 + 拒绝新 session
      this.tenant.canCreateSession = false
      metrics.tenantSoftLimitHit.inc({ tenant: this.tenantId })
    }
  }
  
  release(delta: number) {
    this.bytes -= delta
  }
}
```

### 7.2 硬限制（cgroups / k8s）

```yaml
# pod 级硬限制（所有 tenant 总和）
resources:
  limits:
    memory: "4Gi"
  requests:
    memory: "2Gi"
```

**多租户硬隔离要 worker thread / process**——单 V8 isolate 内不能给 tenant 设 heap quota。Stage 6+ 可考虑：
- worker_threads 一 worker 一 tenant
- child_process 一 process 一 tenant 子集

但 IPC 开销大，多数场景 soft limit + 整 pod hard limit 已足够。

## 八、Heap dump 自动化

### 8.1 触发条件

| 触发 | 行为 |
|---|---|
| 手动调 `/debug/heapdump`（admin token）| 立即 |
| RSS > 80% pod limit 持续 5 min | 自动一次（避免 dump storm）|
| OOM 即将发生（heap > max-old-space 95%）| 立即 |
| Memory leak 检测器触发 | 自动 |

### 8.2 不影响在线流量

heap snapshot 期间 V8 stop-the-world（典型 1-3s）。要么：
- 走 worker thread dump（隔离）
- 路由切到其他 pod 后再 dump
- 只在低峰期 cron 触发

### 8.3 Memory leak 检测器

简单实现：
```ts
class HeapGrowthDetector {
  private samples: { ts: number, heap: number }[] = []
  
  sample() {
    this.samples.push({ ts: Date.now(), heap: process.memoryUsage().heapUsed })
    if (this.samples.length > 60) this.samples.shift()
  }
  
  detect(): boolean {
    if (this.samples.length < 60) return false
    
    // 6h 窗口内持续增长
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const growthRate = (last.heap - first.heap) / (last.ts - first.ts)
    
    return growthRate > 1024 * 1024 / (60 * 1000)  // > 1MB/min
  }
}

setInterval(() => {
  detector.sample()
  if (detector.detect()) {
    triggerHeapDump('leak_suspected')
  }
}, 60 * 1000)
```

## 九、Worker thread 隔离方案

### 9.1 哪些任务该隔离

| 任务 | 应用 worker？ | 原因 |
|---|---|---|
| LLM streaming | ✓ | streaming 解析占 CPU + GC 压力大 |
| 大 transcript 序列化 | ✓ | JSON.stringify 长字符串卡 main |
| 复杂 regex（path matching）| ✓ | 偶发 ReDoS |
| FileReadCache 哈希 | ✗ | 短小，main thread 即可 |
| 数据库操作 | ✗ | 共享 db handle 风险大 |
| MCP 通信 | partial | child process 已隔离，主进程做 IPC |
| Permission 决策 | ✗ | 路径短，main thread 即可 |

### 9.2 Worker pool 设计

```ts
import { Worker } from 'node:worker_threads'

class WorkerPool {
  private workers: Worker[] = []
  private queue: Task[] = []
  
  constructor(scriptPath: string, size = 4) {
    for (let i = 0; i < size; i++) {
      this.workers.push(this.createWorker(scriptPath))
    }
  }
  
  private createWorker(path) {
    const w = new Worker(path)
    w.on('exit', (code) => {
      // worker 死了，重启
      const idx = this.workers.indexOf(w)
      if (idx >= 0) {
        this.workers[idx] = this.createWorker(path)
        metrics.workerRestarts.inc({ reason: code === 0 ? 'normal' : 'crash' })
      }
    })
    return w
  }
  
  async run(task): Promise<any> {
    const worker = this.findIdle() || await this.waitForIdle()
    return new Promise((res, rej) => {
      worker.postMessage(task)
      worker.once('message', res)
      worker.once('error', rej)
    })
  }
}
```

## 十、Health check / metrics 完整设计

### 10.1 三个端点

```ts
// /healthz - readiness probe (Ingress 用)
app.get('/healthz', async (c) => {
  const checks = {
    postgres: await pingPostgres().catch(() => false),
    redis: await pingRedis().catch(() => false),
    s3: await pingS3().catch(() => false),
    diskUsageOk: await checkDiskUsage() < 90,
    memoryOk: process.memoryUsage().rss < (POD_LIMIT * 0.9),
    eventLoopOk: eventLoopLag.p99() < 100,
  }
  
  const ready = Object.values(checks).every(v => v === true)
  return c.json(checks, ready ? 200 : 503)
})

// /livez - liveness probe (k8s 重启用)
app.get('/livez', (c) => {
  // 仅检查事件循环活着
  const lag = eventLoopLag.lastSampleMs()
  const alive = lag < 5000
  return c.json({ alive, lag_ms: lag }, alive ? 200 : 503)
})

// /metrics - Prometheus scrape
app.get('/metrics', async (c) => {
  return c.text(await register.metrics(), 200, {
    'Content-Type': register.contentType
  })
})
```

### 10.2 关键 Prometheus 指标（22 项）

```
# Process
process_resident_memory_bytes              # RSS
process_virtual_memory_bytes
process_open_fds                           # 文件描述符
process_max_fds                            # rlimit

# Node.js runtime
nodejs_heap_size_total_bytes
nodejs_heap_size_used_bytes
nodejs_eventloop_lag_seconds (p50/p99)
nodejs_active_handles_total
nodejs_active_requests_total
nodejs_gc_duration_seconds (sum/count by kind)

# qwen daemon 业务
qwen_active_sessions{tenant}
qwen_subscribers_total{tenant,kind}
qwen_background_tasks_running{kind}
qwen_mcp_subprocess_count
qwen_lsp_subprocess_count
qwen_filereadcache_size_bytes{tenant}
qwen_permission_decisions_cache_size

# 错误 / SLO
qwen_uncaught_exceptions_total
qwen_unhandled_rejections_total
qwen_audit_buffer_overflows_total
qwen_native_module_crashes_total{module}
qwen_quota_exceeded_total{tenant,action}
qwen_circuit_breaker_trips_total{tenant}
```

### 10.3 告警阈值

| 指标 | 告警条件 | 严重度 |
|---|---|---|
| `process_resident_memory_bytes` | > 80% pod limit 5min | warning |
| 同上 | > 90% pod limit 1min | critical → graceful drain |
| `nodejs_heap_size_used_bytes` 增长率 | > 1MB/h 持续 6h | warning（可能 leak）|
| `nodejs_eventloop_lag_seconds` p99 | > 100ms | warning |
| 同上 | > 1s | critical |
| `process_open_fds` | > 50% rlimit | warning |
| 同上 | > 80% rlimit | critical |
| `qwen_uncaught_exceptions_total` rate | > 0 / 1min | critical |
| `qwen_native_module_crashes_total` rate | > 0 / 1h | critical |
| `qwen_active_sessions` 增长率 | > 10/min 持续 1h | warning（容量预警）|

## 十一、30 天 Soak / Chaos 测试矩阵

```
Soak 测试: 模拟真实流量 30 天，监控 leak / drift
Chaos 测试: 主动注入故障，验证防御机制
```

| # | 测试 | 持续 | 期望 |
|---|---|---|---|
| S1 | 标准流量 soak | 30 天 | RSS 增长 < 50MB / 24h |
| S2 | 高频 session 创建（100/min）| 7 天 | TTL 清理生效，session 数稳定 |
| S3 | 大 transcript（5MB / session）| 7 天 | 序列化不阻塞 |
| S4 | 多租户混合负载 | 30 天 | 无单 tenant 拖垮 |
| C1 | 单 worker 内存爆 | 触发即时 | worker 重启，主进程不死 |
| C2 | better-sqlite3 segfault | 注入 | supervisor 检测，graceful drain |
| C3 | 文件描述符泄漏注入 | 1 天 | watchdog 触发 |
| C4 | uncaughtException 注入 | 触发即时 | logged + graceful drain |
| C5 | tenant 1000 session 突增 | 1h | quota 拒绝 + circuit breaker |
| C6 | MCP child kill -9 | 注入 | 父进程检测 + restart |
| C7 | Postgres 慢查询 100ms | 1 天 | event loop lag 不超阈值 |
| C8 | 大 paste（10MB prompt）| 触发即时 | 拒绝 / attachment 转存 |

## 十二、Bun vs Node.js 长跑实测对比

参考公开 benchmark + 推测：

| 维度 | Node.js v22 | Bun 1.x |
|---|---|---|
| 启动时间 | 80-200ms | 20-50ms |
| RSS 起步 | 30-50MB | 25-40MB |
| HTTP req/s | 30k-50k | 50k-80k |
| GC pause p99 | 5-50ms | 实测较少公开数据 |
| 24h 长跑 RSS 增长 | 10-100MB | 30-150MB（实测较少） |
| 7 天 soak | 公开案例多 | 案例少 |
| native module 兼容 | 全 | 大多兼容偶发 ABI |
| heap snapshot 工具 | clinic.js / 0x / inspector | 部分支持 |
| Memory profiler | 多年成熟 | 早期 |
| OOMKilled 行为 | 优雅 abort | 偶发 segfault |

**结论**：
- **dev / 单元测试** 用 Bun（启动快、HTTP 快）
- **prod 长跑** 用 Node.js v22+（生态成熟、监控工具多）
- **Stage 6 SaaS** 强烈推荐 Node.js

## 十三、与 §16 HA / §18 协同

| §19 机制 | 与其他章关系 |
|---|---|
| TTL 清理 | §18 §五 liveness 协议（subscriber TTL）+ §14 §五 生命周期表 |
| Memory threshold restart | §16 §八 graceful drain（90s）+ §16 §四.3 multi-pod sticky |
| Circuit breaker | §23 §五 quota engine + §12 §4 DoS 防御 |
| heap dump | §16 §十一 监控告警 |
| Worker thread | §16 §三 状态可恢复性矩阵（worker 隔离的 LLM streaming 算"瞬时"状态）|
| Native supervisor | §16 §十三 degraded mode（supervisor 触发 graceful drain）|

**核心洞察**：稳定性 = §16 HA 设计的应用层补充。HA 让重启成本接近 0，§19 让 leak 可观测可管理。两者结合达到"长跑 12-72h + 重启可预期"的目标。

## 十四、Stage 3-6 实施

| Stage | 必做 | 应做 |
|---|---|---|
| Stage 3（完整 daemon）| 5.1.1-5.1.5（TTL/bounded/drain/exception 处理/healthz）| native module supervisor |
| Stage 4（多租户）| 5.2.1-5.2.4（quota/breaker/threshold/heapdump）| memory profiler |
| Stage 5（sandbox）| 同 Stage 4 + sandbox crash 隔离 | worker pool sandbox |
| Stage 6（SaaS HA）| 5.3.1-5.3.3（worker/scheduled restart/profiler）| 完整 Soak/Chaos 矩阵 |

## 十五、与 OpenCode / Claude Code 对比

| 维度 | OpenCode | Claude Code | qwen daemon Stage 6 |
|---|---|---|---|
| 设计目标长跑 | dev tool（重启即可）| CLI（不持久）| **multi-day** |
| TTL 清理 | minimal | N/A | ✓ 全面 |
| Memory threshold restart | ❌ | N/A | ✓ |
| Heap dump on demand | ❌ | N/A | ✓ |
| Circuit breaker per tenant | ❌ | N/A | ✓ Stage 4+ |
| Worker thread 隔离 | ❌ | N/A | ✓ Stage 6 |
| Soak / chaos testing | minimal | N/A | ✓ 30 天矩阵 |
| Bun runtime | ✓ | N/A | dev only |

**OpenCode** 设计目标是单机短跑，长跑稳定性不是优先级；**Claude Code** 是 CLI 启动即跑完即退，无长跑场景；**qwen daemon Stage 6** 直接对标云原生 SaaS，长跑稳定性是核心需求。

## 十六、一句话总结

**Qwen daemon 长跑稳定性 = 接受"重启不可避免"哲学（不追求永不重启，目标 12-72h 稳跑 + rolling restart 清状态）+ Node.js 长跑 7 类风险主动管理（V8 heap / GC / fd / 子进程 zombie / uncaughtException / native module / AsyncLocalStorage 链表）+ 多租户加剧 5 类风险（故障半径 / 资源争抢 / SLO 下限 / leak 累积 / 审计取证）+ qwen 具体 10 个泄漏点修复（session TTL / subscriber liveness / FileReadCache LRU / task lifetime / MCP supervisor / LSP cascade close / ALS 隔离 / permission cache / audit buffer / registry 共享）+ 9 项稳定性模式（TTL / bounded / quota / circuit breaker / memory threshold restart / heap dump / liveness / native supervisor / worker isolation）+ 6 类 native module 风险防御（better-sqlite3 / node-pty / mcp-sdk / zlib / canvas / 通用 supervisor）+ 22 项 Prometheus 指标 + 30 天 Soak/Chaos 测试矩阵。与 §16 HA 协同：HA 让重启成本接近 0，§19 让 leak 可观测可管理。Bun vs Node.js：dev Bun（启动快），prod Node.js v22+（长跑稳）。**

---

[← 返回 README](./README.md) · [下一篇：与 Anthropic Managed Agents 对比 →](./20-vs-anthropic-managed-agents.md)
