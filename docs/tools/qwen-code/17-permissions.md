# Qwen Code 权限系统（Permissions）

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code 权限系统采用 **默认拒绝 + 逐次授权** 的安全模型。每次工具调用都会经过权限评估，产生四种决策之一：

| Decision | 含义 |
|----------|------|
| `allow` | 自动通过，无需确认 |
| `ask` | 需要用户确认后执行 |
| `deny` | 直接阻止，不会执行 |
| `default` | 无规则匹配，回退到全局 approval mode |

评估优先级（从高到低）：**deny > ask > allow > default**。

系统支持两种规则来源：
- **Persistent rules**：来自 `settings.json`，跨 session 持久化
- **Session rules**：内存中的临时规则，session 结束后清除

核心源码位于 `packages/core/src/permissions/`，包含约 7 个主要模块。

## 2. Permission Manager

`PermissionManager` 是权限系统的核心类，负责规则管理和权限决策。

### 2.1 权限决策流程

```
tool invocation
    │
    ├─ normalize context (monitor 命令归一化)
    │
    ├─ compound command? ──yes──> split & evaluate each sub-command
    │                              取最严格结果
    │
    ├─ evaluateSingle(ctx)
    │   ├─ deny rules (session → persistent) → match → 'deny'
    │   ├─ ask rules  (session → persistent) → match → 'ask'
    │   ├─ allow rules (session → persistent) → match → 'allow'
    │   └─ no match → 'default'
    │
    ├─ Shell 工具额外逻辑：
    │   ├─ virtual ops (shell-semantics) 提升决策
    │   └─ 'default' → AST 分析 (read-only → allow, 否则 → ask)
    │
    └─ return decision
```

### 2.2 Allow / Ask / Deny 三态规则

规则使用 `ToolName(specifier)` 格式定义：

```json
{
  "permissions": {
    "allow": ["Bash(git *)", "Read(/src/**)"],
    "ask": ["WebFetch(domain:internal.corp)"],
    "deny": ["Bash(rm -rf /)", "Edit(//etc/**)"]
  }
}
```

### 2.3 Session vs Persistent 规则

- `addSessionAllowRule()`：用户点击 "Always allow for this session" 时添加
- `addPersistentRule()`：写入 `settings.json` 持久化
- 两者在评估时合并，session 规则优先检查

### 2.4 Registry-level 检查

`isToolEnabled()` 用于工具注册阶段，只有无 specifier 的 deny 规则会从注册表移除工具。带 specifier 的 deny（如 `Bash(rm -rf *)` ）仅在运行时阻止特定调用。

## 3. Auto Mode Classifier

AUTO 模式下，当 PermissionManager 返回 `default` 或工具内置默认为 `ask` 时，进入三层过滤：

### 3.1 三层过滤架构

| Layer | 名称 | 作用 |
|-------|------|------|
| L5.1 | acceptEdits fast-path | workspace 内 Edit/Write 操作直接放行 |
| L5.2 | safe-tool allowlist | 内置只读工具（read_file, grep, glob 等）直接放行 |
| L5.3 | LLM classifier | 两阶段 LLM 分类器判定 |

特殊约束：
- 用户显式配置了 `ask` 规则时，fast-path 被跳过（用户意图优先）
- `PERSISTENCE_PATH_PATTERNS` 排除 `.git/hooks/`、`package.json` 等可执行路径

### 3.2 两阶段 LLM 分类

**Stage 1（fast，~300ms）**：
- `max_tokens=32`，thinking 关闭
- 输出 `{ shouldBlock: boolean }`
- 不阻止时立即返回（快速路径）

**Stage 2（review，~3-10s）**：
- 仅在 Stage 1 判定阻止时触发
- `max_tokens=4096`，thinking 开启
- 输出 `{ thinking, shouldBlock, reason }`
- 目的是减少 Stage 1 的误报

失败策略：**fail-closed** — API 错误、超时、schema 验证失败一律视为 block。

### 3.3 分类 Prompt 设计

System prompt 包含三个可扩展段：

**Default ALLOW**（内置 6 条）：
- 只读 shell 命令（ls, cat, git status, grep 等）
- cwd 内包管理（npm install, pip install 等）
- cwd 内构建/测试命令
- cwd 内文件操作
- Git 只读操作
- 不涉及网络或系统外修改的本地操作

**Default BLOCK**（内置 7 条）：
- 不可逆系统破坏（rm -rf /, dd of=/dev/ 等）
- 外部代码执行（curl | sh）
- 凭证泄露
- 未授权持久化（修改 .bashrc、crontab）
- 安全削弱（chmod 777）
- 强制推送 main/master
- 云实例元数据端点访问（169.254.169.254 等）

**用户自定义 hints**：通过 `autoMode.hints.allow/deny` 追加，以 JSON 编码嵌入，防止注入攻击。每条限制 200 字符，最多 50 条。

## 4. Rule Parser

### 4.1 规则语法

```
Rule = ToolName | ToolName "(" Specifier ")"

ToolName = 别名 | 规范名 | MCP工具名
Specifier = CommandPattern | PathPattern | DomainPattern | LiteralPattern
```

**工具别名映射**（部分）：

| 别名 | 规范名 | 类别 |
|------|--------|------|
| Bash, Shell | run_shell_command | command |
| Read, ReadFile | read_file | path (meta: 含 grep, glob, ls) |
| Edit, Write | edit / write_file | path (meta: 含 notebook_edit) |
| WebFetch | web_fetch | domain |
| Agent, Task | agent | literal |
| mcp__server__tool | 原样保留 | MCP |

### 4.2 匹配算法

**Command 匹配**（Shell 工具）：
- `*` 为通配符，可出现在任意位置
- 空格 + `*` 强制词边界：`Bash(ls *)` 匹配 `ls -la` 但不匹配 `lsof`
- 无 `*` 时使用前缀匹配：`Bash(git commit)` 匹配 `git commit -m "test"`
- 环境变量赋值前缀自动剥离

**Path 匹配**（文件工具）：
- 使用 picomatch 实现 gitignore 风格匹配
- `*` 匹配单级目录，`**` 递归匹配
- 路径前缀规则：`//` = 绝对路径，`~/` = home，`/` = 项目根，`./` = cwd

**Domain 匹配**（WebFetch）：
- 精确匹配或子域匹配
- `domain:example.com` 匹配 `sub.example.com`

**MCP 匹配**：
- `mcp__server` 匹配该 server 所有工具
- `mcp__server__*` 通配符语法
- `mcp__server__tool` 精确匹配

## 5. Shell Semantics

`shell-semantics.ts` 将 shell 命令转换为 "虚拟工具操作"，使 Read/Edit/Write/WebFetch 规则能够匹配等效的 shell 命令。

### 5.1 命令解析

```typescript
extractShellOperations('cat /etc/passwd', '/home/user')
// → [{ virtualTool: 'read_file', filePath: '/etc/passwd' }]

extractShellOperations('curl https://example.com/api', '/home/user')
// → [{ virtualTool: 'web_fetch', domain: 'example.com' }]

extractShellOperations('echo hi > /etc/motd', '/home/user')
// → [{ virtualTool: 'write_file', filePath: '/etc/motd' }]
```

解析流程：
1. Tokenize（处理引号和转义）
2. 提取 I/O 重定向（`>`, `>>`, `<`, `2>` 等）
3. 识别并剥离 prefix 命令（sudo, env, timeout 等）
4. 分派到命令处理表

### 5.2 已知命令表

| 类别 | 命令 | 映射 |
|------|------|------|
| 文件读取 | cat, head, tail, less, diff 等 30+ | read_file |
| 目录列表 | ls, find, tree, du, exa | list_directory |
| 搜索 | grep, rg, ag, ack | read_file / list_directory |
| 文件写入 | touch, mkdir, tee, cp, ln | write_file |
| 文件修改 | rm, chmod, chown, sed -i, mv | edit |
| 网络请求 | curl, wget, fetch | web_fetch |

### 5.3 透明前缀命令

sudo、env、time、nice、nohup、timeout 等被视为透明包装，递归分析内部命令。

### 5.4 已知局限

无法静态分析的场景：shell 变量展开（`$FILE`）、命令替换（`$(find .)`）、解释器脚本（`python x.py`）、管道目标（`find | xargs cat`）。

## 6. Dangerous Rules

### 6.1 概念

AUTO 模式下，过于宽泛的 allow 规则会绕过 classifier。系统在进入 AUTO 模式时自动 strip 这些 "dangerous" 规则，退出时恢复。

### 6.2 危险规则判定标准

**Shell/Monitor 工具**（`isDangerousBashRule`）：
- 无 specifier：`Bash`（等同 allow all）
- 通配符 specifier：`Bash(*)`
- 危险解释器 + 通配符：`Bash(python *)`, `Bash(node *)`
- 例外：具体命令不标记，如 `Bash(python script.py)`, `Bash(npm test)`

**危险解释器列表**（76 个）：
- Shell：bash, sh, zsh, fish, csh, dash, ksh, pwsh
- 脚本语言：python, node, deno, bun, ruby, perl, php, lua, julia
- 构建工具：cargo, npm, pnpm, yarn, make, gradle, mvn, go
- 包运行器：npx, pnpx, uvx, pipx, dlx
- 通用执行：eval, exec, source

**Agent 工具**（`isDangerousAgentRule`）：任何 Agent allow 规则都危险（子代理逃逸 classifier 审查）

**Skill 工具**（`isDangerousSkillRule`）：任何 Skill allow 规则都危险（加载用户自定义代码）

### 6.3 Strip / Restore 机制

```
进入 AUTO → stripDangerousRulesForAutoMode()
  ├─ 从 persistent + session allow 中移除匹配规则
  └─ 存入 strippedAllowRules 暂存区

退出 AUTO → restoreDangerousRules()
  └─ 从暂存区恢复到各自 scope

AUTO 期间新增 allow 规则：
  └─ 如为 dangerous → 存入暂存区而非激活
```

## 7. Denial Tracking

### 7.1 状态机设计

保护用户免受 classifier 持续阻止或基础设施故障导致的无限循环。

```typescript
interface AutoModeDenialState {
  consecutiveBlock: number;        // 连续 policy block 计数
  consecutiveUnavailable: number;  // 连续 infra 故障计数
  totalBlock: number;              // 累计 block（仅 telemetry）
  totalUnavailable: number;        // 累计 unavailable（仅 telemetry）
}
```

### 7.2 阈值与回退

| 触发条件 | 阈值 | 行为 |
|----------|------|------|
| 连续 block | >= 3 | 单次回退到手动确认 |
| 连续 unavailable | >= 2 | 单次回退到手动确认 |

**Cross-reset 规则**：block 和 unavailable 计数器互相重置，不累加。一次 allow 重置两者。

### 7.3 学习机制

- `recordAllow()`：成功执行，重置连续计数
- `recordBlock()`：classifier 策略阻止，递增 block 计数
- `recordUnavailable()`：基础设施故障，递增 unavailable 计数
- `recordFallbackApprove()`：用户手动批准回退提示，重置两个连续计数器
- `resetDenialState()`：切换 ApprovalMode 时完全重置

### 7.4 回退是单次的

session 保持在 AUTO 模式，仅对当前被阻止的调用降级为手动确认。用户批准后恢复正常 AUTO 流程。

## 8. 与 Claude Code Permissions 的对比

| 维度 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 基础架构 | 同源（fork 自 Claude Code） | 原版 |
| 规则语法 | 完全兼容（Bash/Read/Edit/WebFetch） | 原版设计 |
| AUTO Classifier | 两阶段 LLM（Stage 1 fast + Stage 2 thinking） | 单阶段 |
| Fail 策略 | fail-closed（阻止） | fail-closed |
| Dangerous Rules | 扩展至 76 个解释器 + Agent/Skill | 原版较少 |
| Denial Tracking | 含 cross-reset + unavailable 独立计数 | 基础版本 |
| Shell Semantics | 支持 60+ 命令的虚拟操作提取 | 类似实现 |
| 安全模型 | 默认拒绝 + L5 三层过滤 | 默认拒绝 + classifier |
| 元数据保护 | 明确 block 云 IMDS endpoint | 未明确列出 |
| Hint 注入防护 | JSON.stringify 编码 + 长度限制 | 类似 |
| acceptEdits 排除 | PERSISTENCE_PATH_PATTERNS（hooks、CI） | 类似 |

主要差异点：Qwen Code 在 classifier 设计上采用了更明确的两阶段方案（Stage 1 侧重速度，Stage 2 侧重准确性），并对 denial tracking 增加了 unavailable 独立轨道和 cross-reset 语义。

## 9. 相关代码索引

| 文件 | 职责 |
|------|------|
| `permissions/types.ts` | 核心类型定义（PermissionRule, PermissionDecision 等） |
| `permissions/permission-manager.ts` | 权限管理器，规则评估引擎 |
| `permissions/rule-parser.ts` | 规则解析、匹配算法、路径/命令/域名匹配 |
| `permissions/shell-semantics.ts` | Shell 命令语义分析，虚拟操作提取 |
| `permissions/autoMode.ts` | AUTO 模式三层过滤编排器 |
| `permissions/classifier.ts` | 两阶段 LLM classifier 实现 |
| `permissions/classifier-prompts/system-prompt.ts` | Classifier system prompt 模板与构建 |
| `permissions/classifier-transcript.ts` | Classifier 输入消息构建 |
| `permissions/dangerousRules.ts` | 危险 allow 规则检测与列表 |
| `permissions/denialTracking.ts` | Denial 状态机与回退判定 |
| `permissions/index.ts` | 模块公共导出 |
