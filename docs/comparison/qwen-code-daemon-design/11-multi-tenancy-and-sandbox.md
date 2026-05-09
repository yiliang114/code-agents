# 11 — Shell 沙箱与远程执行

> [← 上一篇：协议兼容性](./10-protocol-compatibility.md) · [下一篇：水平越权防御 →](./12-horizontal-privilege-defense.md)

> Shell 工具是 daemon 最危险的攻击面——`spawn(cmd, { cwd })` 默认跑 daemon 进程权限，多租户 / 半信任场景必须加 sandbox。本章设计 `ShellSandbox` 抽象接口 + 5 种实现方案 + 远程 sandbox（daemon 与 shell 不在同机）的完整方案。

> **本章只关注 daemon 内的 sandbox 设计**。多租户 ACL / 配额 / 审计 / OIDC 等 orchestrator 层事项见 [§22 Orchestrator 多租户与配额](./22-orchestrator-multi-tenancy.md)。

## 一、TL;DR

5 种 sandbox 方案 + 远程 sandbox：

| 方案 | 隔离级别 | 启动开销 | 复杂度 | 平台 | 适合 |
|---|---|:---:|:---:|---|---|
| **NoSandbox** | ❌ 无（跑 daemon 权限）| 0 | 低 | 跨平台 | 单租户信任部署（默认）|
| **OS user 切换** | 文件系统权限 + 进程独立 | <10ms | 低 | Unix | 同公司多用户（trusted）|
| **Linux namespace** | 完整 namespace 隔离 | ~50-100ms | 中 | Linux only | **半信任多用户推荐**（与 Claude Code v2.1.98 对齐）|
| **Container（Docker / Podman）** | 完整 container 隔离 | 200-2000ms | 高 | 跨平台 | 完全不信任 / SaaS production |
| **远程 sandbox**（独立机器）| 物理机隔离 | 50-3000ms | 高 | 取决于实现 | SaaS / GPU 节点 / 合规边界 |

**核心抽象**：`ShellSandbox` interface 把 shell 执行从 `spawn` 抽象出来，实现可换。本章作为 [External Reference Architecture](./08-roadmap.md#external-reference-architecture参考实现非项目路线图)（不在 qwen-code 主线路线图）；下面"Phase 1 / 2 / 3"指外部 sandbox 实施的渐进路线，不是 qwen-code 主线 Stage（主线只到 Stage 2）。

## 二、ShellSandbox 抽象接口

```ts
// packages/core/src/tools/bash/sandbox.ts （新建）
export interface ShellSandbox {
  spawn(cmd: string, opts: SandboxSpawnOpts): Promise<SandboxedProcess>
  dispose(): Promise<void>
}

interface SandboxSpawnOpts {
  cwd: string
  env: Record<string, string>
  timeout?: number
  stdin?: string
}

interface SandboxedProcess {
  stdout: Readable
  stderr: Readable
  exitCode: Promise<number>
  kill(signal?: string): void
}

// 实现矩阵
class NoSandbox implements ShellSandbox          // 默认（单租户信任）
class OsUserSandbox implements ShellSandbox      // OS user 切换
class NamespaceSandbox implements ShellSandbox   // Linux namespace
class ContainerSandbox implements ShellSandbox   // Docker / Podman
class RemoteSandbox implements ShellSandbox      // 远程执行（§五）
```

**daemon 端**：`Bash` / `Monitor` tool 不直接调 `spawn`，而是 `daemon.sandbox.spawn(cmd, opts)`——sandbox 在 daemon 启动时按配置 instantiated 一次（[§03 §2](./03-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session" 模型下，daemon-global singleton）。

## 三、4 种本地 sandbox 方案详解

### 3.1 NoSandbox（默认）

```ts
class NoSandbox implements ShellSandbox {
  async spawn(cmd: string, opts: SandboxSpawnOpts) {
    return wrapAsSandboxedProcess(spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
    }))
  }
}
```

跑 daemon 进程权限——**仅适合单租户信任部署**（个人开发 / 小团队同机协作）。多租户场景**严禁使用**（同 daemon 写 / 读其他用户文件）。

### 3.2 OS user 切换

**前置**：daemon 跑 root（或具备 `CAP_SETUID` capability），每用户注册一个 unprivileged OS user。

```ts
class OsUserSandbox implements ShellSandbox {
  constructor(private uid: number, private gid: number) {}
  
  async spawn(cmd: string, opts: SandboxSpawnOpts) {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      env: this.scrubEnv(opts.env),
      uid: this.uid,                  // setuid
      gid: this.gid,                  // setgid
      shell: '/bin/bash',
    })
    return wrapAsSandboxedProcess(child)
  }
  
  private scrubEnv(env: Record<string, string>) {
    // 仿 Claude Code v2.1.98 env scrub
    const allowlist = new Set(['PATH', 'HOME', 'LANG', 'SHELL', 'USER'])
    const lcRe = /^LC_/
    return Object.fromEntries(
      Object.entries(env).filter(([k]) => allowlist.has(k) || lcRe.test(k))
    )
  }
  
  async dispose() {}
}
```

**隔离效果**：
- ✓ 文件系统权限（user A 无法写 user B 的 home）
- ✓ 进程信号无法跨 user 发送
- ✓ Resource limit（rlimit）per-user
- ❌ 共享 PID / network / mount namespace（可见全系统进程列表）
- ❌ 共享 hostname / IPC

**部署要求**：
1. daemon 用 root + dropped capabilities 启动（仅保留 `CAP_SETUID`/`CAP_SETGID`）
2. 每用户系统层创建 unprivileged user（`useradd qwen-user-alice`）
3. workspace 目录权限设置 user owns

### 3.3 Linux namespace（与 Claude Code v2.1.98 对齐）

```ts
class NamespaceSandbox implements ShellSandbox {
  constructor(
    private cgroupPath: string,    // cgroup v2 子目录
    private maxMemory: string,      // '2G'
    private maxCpuPercent: number,  // 100 = 1 core
  ) {}
  
  async spawn(cmd: string, opts: SandboxSpawnOpts) {
    // unshare 新建 PID + mount + net + UTS + IPC namespace
    const child = spawn('unshare', [
      '--pid', '--fork',           // PID namespace（看不到其他用户进程）
      '--mount-proc',              // 新 /proc
      '--mount',                   // mount namespace（独立 mount table）
      '--net',                     // network namespace（无外网，需 bridge 才能访问）
      '--uts',                     // hostname 隔离
      '--ipc',                     // System V IPC 隔离
      'bash', '-c', cmd,
    ], {
      cwd: opts.cwd,
      env: this.scrubEnv(opts.env),
    })
    
    // 进 cgroup（CPU + memory 限制）
    await this.attachToCgroup(child.pid!)
    return wrapAsSandboxedProcess(child)
  }
  
  private async attachToCgroup(pid: number) {
    await fs.appendFile(`${this.cgroupPath}/cgroup.procs`, `${pid}\n`)
  }
}
```

**与 Claude Code v2.1.98 对齐**：codeagents 报告 [P2 item-42](../qwen-code-improvement-report-p2-stability.md#item-42) 描述 Claude Code 的 "Linux PID namespace + env scrub + SCRIPT_CAPS"——完全同思路。

**额外建议**：
- `seccomp-bpf` 过滤危险 syscall（`ptrace` / `mount` / `unshare` 嵌套等）
- cgroups v2 加 IO 限制 + `memory.swap.max` 防止 OOM 拖累整机

### 3.4 Container 方案（Docker / Podman）

```ts
class ContainerSandbox implements ShellSandbox {
  private containerId: string
  
  async start(workspaceRoot: string) {
    this.containerId = await docker.run('qwen-sandbox-runtime:latest', {
      mountSrc: workspaceRoot,
      mountDst: '/workspace',
      cpuLimit: '1.0',
      memLimit: '2g',
      networkMode: 'sandbox-bridge',  // 仅访问允许服务
    })
  }
  
  async spawn(cmd: string, opts: SandboxSpawnOpts) {
    return docker.exec(this.containerId, ['bash', '-c', cmd], {
      cwd: this.translatePath(opts.cwd),  // /workspace/repo-a
      env: this.scrubEnv(opts.env),
    })
  }
  
  async dispose() {
    await docker.kill(this.containerId)
  }
}
```

**优点**：跨平台（Linux + macOS）+ 完整隔离 + 网络限制 + image 复用 + k8s native  
**缺点**：
- 启动开销大（500-2000ms 首次 + ~50ms exec）
- 文件挂载映射复杂
- macOS / Windows 的 Docker 是 VM（更慢）
- 需要 Docker daemon 或 Podman 运行时

适合 SaaS production，不适合 self-host 单机场景。

## 四、Sandbox 选择逻辑

```ts
function createSandbox(config: DaemonConfig): ShellSandbox {
  const type = config.sandbox?.type ?? 'none'
  
  switch (type) {
    case 'none':
      // 单租户信任部署默认
      if (config.multiTenant) {
        throw new Error('NoSandbox not allowed in multi-tenant mode')
      }
      return new NoSandbox()
    
    case 'os-user':
      return new OsUserSandbox(config.sandbox.uid, config.sandbox.gid)
    
    case 'namespace':
      if (process.platform !== 'linux') {
        log.warn('namespace sandbox requires Linux, falling back to os-user')
        return new OsUserSandbox(config.sandbox.uid, config.sandbox.gid)
      }
      return new NamespaceSandbox(config.sandbox.cgroupPath, ...)
    
    case 'container':
      return new ContainerSandbox(config.sandbox.image, ...)
    
    case 'remote':
      return new RemoteSandbox(config.sandbox.remoteConfig)  // 见 §五
  }
}
```

orchestrator spawn daemon 时通过 [§04 §8.2 `POST /coordinator/sessions`](./04-http-api.md#82-新增-orchestrator-层-apistage-2) 请求 body 决定 sandbox 类型——daemon 启动时拿到固定配置，runtime 不变。

## 五、远程 sandbox（daemon 与 shell 不在同机）

某些场景下 shell 命令应该跑在**与 daemon 不同的物理机**上：

| 场景 | 理由 |
|---|---|
| **daemon 在控制平面 / shell 在 worker 节点** | k8s native 部署：daemon 是 lightweight controller，shell 调度到 worker pool |
| **平台不匹配** | daemon 在 macOS（Docker for Mac 慢），shell 必须在 Linux server 才能跑 production-grade build |
| **GPU / 大型 build server** | shell 需要访问特殊硬件（GPU / 大内存 / 高 IO 节点）|
| **企业合规边界** | shell 必须在 production 同一安全/合规分区内（如 PCI / HIPAA）|
| **SaaS 调度** | 用户的 shell 调度到地理就近 worker 节点（降延迟 + 满足数据驻留法规）|
| **资源弹性** | shell worker 自动扩缩容（k8s HPA），daemon 是 stateful 不容易扩 |

### 5.1 4 种远程 sandbox 实现

| 方案 | 协议 | 启动开销 | 适合 |
|---|---|---|---|
| **SSH-based** | SSH + scp/rsync 传 workspace | 100-300ms | 简单运维场景、中小团队 |
| **gRPC sandbox protocol** | 自定义 gRPC + mTLS | 50-100ms | 自建 sandbox cluster |
| **k8s Job / Pod** | k8s API 创建 ephemeral pod | 1-3s（pod cold start）| 云原生 SaaS |
| **Container runtime over network** | containerd / OCI runtime over TCP | 200-500ms | 企业内部 |

### 5.2 RemoteSandbox 抽象

```ts
// packages/core/src/tools/bash/sandbox/RemoteSandbox.ts
interface RemoteSandboxConfig {
  endpoint: string                         // gRPC / SSH / k8s API URL
  auth: SandboxAuth                        // mTLS cert / SSH key / k8s SA token
  workspaceMount: WorkspaceMount           // 共享 workspace 策略
  region?: string                          // 调度地理位置
  resourceProfile: 'small' | 'large' | 'gpu'  // 节点类型
}

type WorkspaceMount =
  | { kind: 'nfs', server: string, path: string }              // 共享 NFS（推荐）
  | { kind: 'rsync-on-spawn' }                                  // 每次 spawn 同步
  | { kind: 'shared-volume', volumeId: string }                 // k8s PVC / cloud volume
  | { kind: 'object-storage', bucket: string, syncStrategy: ... } // S3 / OSS

class RemoteSandbox implements ShellSandbox {
  async spawn(cmd: string, opts: SandboxSpawnOpts): Promise<SandboxedProcess> {
    const worker = await this.selectWorker()                  // 1. 选 worker
    await this.ensureWorkspaceAvailable(worker, opts.cwd)     // 2. workspace 同步
    const remoteHandle = await worker.spawnRemote({           // 3. 远程 spawn
      cmd, cwd: this.translatePath(opts.cwd, worker),
      env: this.scrubEnv(opts.env), timeout: opts.timeout,
    })
    return wrapRemoteAsSandboxedProcess(remoteHandle)         // 4. 流式 stdout 包装
  }
}
```

### 5.3 关键挑战与解法

#### 挑战 1：Workspace 文件同步

shell sandbox 看不到 daemon 机器上的 workspace 文件。3 种解法：

| 方案 | 适用 | 成本 |
|---|---|---|
| **A. 共享存储（NFS / k8s PVC / S3）**（推荐）| workspace 一开始就放在共享存储 | 设置一次，运行时 0 同步开销 |
| B. 每次 spawn 前 rsync | workspace 在 daemon 本地 | 大 workspace 启动慢（GB 级别 rsync 几秒）|
| C. Object storage with sync strategy | sandbox 拉 S3 cache | 适合 batch，不适合交互 |

推荐方案 A：

```yaml
# k8s 部署示例
volumes:
- name: workspace-storage
  persistentVolumeClaim:
    claimName: user-alice-workspace-pvc

# daemon pod 与 sandbox worker pod 都挂载
volumeMounts:
- name: workspace-storage
  mountPath: /workspace
```

#### 挑战 2：实时 stdout / stderr 流式回传

长跑命令（如 `npm test --watch` 或 PR#3684 monitor 模式）需要实时回传输出，不能等命令完成。

复用 PR#3684 monitor 的 token-bucket 节流机制，`RemoteSandbox` 把远程 stream 转成本地 Readable：

```ts
class RemoteStreamWrapper {
  private grpcStream: GrpcStreamingCall   // 服务端 push stdout 帧
  
  asNodeReadable(): Readable {
    return new Readable({
      read() {
        for await (const chunk of this.grpcStream) {
          if (chunk.type === 'stdout') this.push(chunk.data)
          if (chunk.type === 'exit') this.push(null)
        }
      }
    })
  }
}
```

#### 挑战 3：取消（远程 SIGINT）

```ts
class RemoteSandboxedProcess {
  async kill(signal: string = 'SIGTERM') {
    await this.worker.killRemote(this.remotePid, signal)
  }
}
```

需要远程协议支持 `kill` RPC（不是所有 SSH wrapper 都现成支持，要单独加）。

#### 挑战 4：网络可靠性

| 故障模式 | 处理 |
|---|---|
| sandbox worker 离线 | daemon 检测心跳超时 → fail-fast 报错给 LLM（"sandbox unavailable, retry?"）|
| 网络分区 | 命令执行中分区 → daemon 回传 `error: 'network_partition'` + 远程进程超时自杀（worker 端 watchdog）|
| 部分输出已收到 | 把已收到的 stdout 包装成 partial result + error tag，让模型决策是否重试 |

#### 挑战 5：延迟

| 操作 | 本地 | 远程 |
|---|---|---|
| spawn 启动 | <10ms | 50-300ms |
| stdout 首字节 | <10ms | 50-150ms |
| 命令完成回传 | 同步 | 取决于网络 RTT |

**用户体验影响**：交互式开发场景（频繁 ls / cat / 小脚本）远程 sandbox 会有明显延迟。建议：
- **混合模式**：read-only 命令（`ls` / `cat` / `grep`）走本地 sandbox（快），write/risk 命令（`npm install` / `git push` / `bash` ad-hoc）走远程 sandbox（隔离）
- 或：用户配置全局选 local 还是 remote

### 5.4 SaaS 部署典型架构

```
┌──────────────────────────────────────────────────────────┐
│ k8s cluster                                                │
│                                                            │
│  Control Plane:                                            │
│  ├─ qwen-orchestrator (Pod)                                │
│  └─ qwen-daemon-instance-{N} (Pod)   ← 1 daemon per session│
│      └─ 不直接跑 shell                                     │
│                                                            │
│  Worker Pool (auto-scaled):                               │
│  ├─ qwen-sandbox-worker-1 (Pod, GPU)                      │
│  ├─ qwen-sandbox-worker-2 (Pod, GPU)                      │
│  ├─ qwen-sandbox-worker-3 (Pod, large-mem)                │
│  └─ qwen-sandbox-worker-N                                  │
│                                                            │
│  Storage:                                                  │
│  ├─ NFS / Ceph: workspace volumes                         │
│  ├─ Postgres: orchestrator metadata / audit               │
│  └─ Redis: quota counters / session locks                  │
│                                                            │
│  daemon → gRPC → sandbox worker (跨 pod)                   │
│  workspace 通过 PVC 在 daemon + sandbox 间共享              │
└──────────────────────────────────────────────────────────┘
```

### 5.5 与本地 sandbox 的渐进路线（External 实施阶段）

```
Phase 1 (本地 sandbox):
  └─ Bash tool 走 sandbox interface
     （NoSandbox / OsUser / Namespace / Container 4 选 1）

Phase 2 (本地 + 远程并存):
  └─ + RemoteSandbox 实现（仅 SSH-based，最简单）
     用于"我想把 shell 跑到办公室服务器"的个人场景

Phase 3 (SaaS 远程优先):
  └─ 默认 RemoteSandbox + k8s 调度
     │ 本地 sandbox 仅 self-host 模式保留
     └─ Mixed mode: 简单命令走本地，复杂命令走远程
```

### 5.6 与现有 PR 的协调

| PR | 与远程 sandbox 的关系 |
|---|---|
| PR#3684 Phase C event monitor | monitor 工具同样需要走 sandbox 抽象——远程 sandbox 实现可复用 |
| PR#3471 task_stop / send_message | 远程进程的 cancel 通过 `task_stop` 工具入口 → `RemoteSandbox.kill()` RPC |
| PR#3717 FileReadCache | 与远程 sandbox **正交**：FileReadCache 在 daemon 进程内，sandbox 是子进程层；但 sandbox 写文件后 daemon 的 cache invalidation 必须考虑（External sandbox 实施时 audit）|
| PR#3820 unescape shell-escaped paths | 远程 sandbox 同样需要处理（path translation 时 escape 处理）|
| PR#3818 MCP coalesce | 不影响（MCP 仍在 daemon 内）|

## 六、Monitor tool 也需要沙箱

PR#3684 引入的 `Monitor` 工具（Phase C event monitor）也是 spawn 长跑 shell 进程——多租户下同样需要走 sandbox：

```ts
// 现有 packages/core/src/tools/monitor.ts (PR#3684)
const child = spawn(cmd, { cwd, env })

// 改造为
const child = await daemon.sandbox.spawn(cmd, { cwd, env })
```

token-bucket throttling、`MonitorRegistry` 等机制不变。

## 七、隔离强度对比

| 方案 | 隔离强度 | 启动开销 | 跨平台 |
|---|---|---|---|
| NoSandbox | ★ | 0 | ✓ |
| OS user | ★★ | <10ms | Unix |
| Namespace | ★★★ | 50-100ms | Linux |
| Local Container | ★★★★ | 500-2000ms | 跨平台 |
| **Remote SSH** | ★★★★（机器隔离）| 100-300ms | 跨平台 |
| **Remote gRPC + Container** | ★★★★★（机器 + 容器双隔离）| 200-500ms | 云原生 |
| **Remote k8s Job** | ★★★★★ | 1-3s | k8s |

**推荐 SaaS 部署**：Remote gRPC + Container（双重隔离）—— shell 命令在远程 worker 节点的 container 内跑，提供机器级 + 进程级双隔离。

## 八、与 OpenCode / Claude Code 对比

| 维度 | OpenCode | Claude Code（v2.1.98+）| Qwen daemon |
|---|---|---|---|
| 默认 sandbox | NoSandbox（信任部署）| Linux PID namespace + env scrub | NoSandbox（默认）/ 配置可换 |
| Sandbox 抽象 | 无显式接口（直接 spawn）| `SCRIPT_CAPS` + namespace | `ShellSandbox` interface（可换实现）|
| 远程 sandbox | 无 | 无 | ✅ 设计支持（External Phase 2）|
| Monitor tool | 不存在 | 不存在 | ✅ 走同 `ShellSandbox` 接口 |
| Container 支持 | 无 | 无 | ✅ External Phase 3 |
| k8s native | 无 | 无 | ✅ External Phase 3 RemoteSandbox + k8s Job |

## 九、关键权衡

### 9.1 单 daemon 进程下的 sandbox 作用

[§03 §2](./03-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session" 模型已经把 daemon 进程 = 用户进程，那为什么还要 sandbox？

**仍需要 sandbox 的原因**：
- daemon 进程跑 LLM 流 + tool dispatch + state management，**不应同时跑用户提供的任意 shell 命令**——shell 命令可能 `rm -rf /` 或更糟
- daemon 启动权限通常比 shell 命令需要的权限高（如 daemon 需要绑端口、写 transcript）—— sandbox 让 shell 跑 lower privilege
- Shell 命令是 LLM 决定的，**不可信**——即使 daemon 信任用户，也应不信任 LLM 行为

→ 即使单 daemon = 单用户，sandbox 仍提供"daemon 进程 vs LLM 命令"边界。

### 9.2 Sandbox 类型选择

| 场景 | 推荐 |
|---|---|
| 个人开发机 | NoSandbox（默认）|
| 同公司多用户共享机器 | OS user / Namespace |
| 半信任多用户（学校 / 大型团队）| Namespace + seccomp-bpf |
| 完全不信任 SaaS 用户 | Container 或 Remote gRPC + Container |
| 需 GPU / 大内存的 build | Remote sandbox（k8s Job 调度到 GPU 节点）|
| Air-gapped 高合规 | Container（不走网络）|

### 9.3 本地 vs 远程 sandbox

| 维度 | 本地 sandbox | 远程 sandbox |
|---|---|---|
| 启动延迟 | 0-100ms | 50-3000ms |
| 隔离强度 | 应用层 | 物理 / VM 级 |
| 资源弹性 | 受限 daemon 机器 | 可弹性扩缩 |
| 跨地理调度 | ❌ | ✅ |
| 合规分区 | ❌ | ✅ |
| 成本 | 0 | 网络 + 调度 + 多机器 |

**核心判断**：本地 sandbox 适合个人 / 小团队，远程 sandbox 是 SaaS 必需（External Phase 3）。

## 十、一句话总结

**Shell 是 daemon 最危险的攻击面**——即使单 daemon = 单用户，shell 命令是 LLM 行为不可信，必须 sandbox。  
**`ShellSandbox` interface 在 External Phase 1 上线**（4 种本地实现按 `none → os-user → namespace → container` 隔离强度递增；Monitor tool 走相同接口）。  
**远程 sandbox 是 SaaS 关键架构**（External Phase 3）——把 shell 调度到独立 worker pool（弹性 + 合规 + 跨地理 + GPU 节点）；支持 SSH / gRPC / k8s Job / containerd over TCP 4 种实现，推荐 gRPC + Container 双隔离。  
**多租户 ACL / 配额 / OIDC** 在 orchestrator 层（[§22](./22-orchestrator-multi-tenancy.md)），不在本章范围。

---

[← 上一篇：协议兼容性](./10-protocol-compatibility.md) · [下一篇：水平越权防御 →](./12-horizontal-privilege-defense.md) · [回到 README](./README.md)
