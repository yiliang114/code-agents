# 12 — 与 Anthropic Managed Agents 对比（External Reference Architecture）

> [← 上一篇：多端协调策略](./11-client-coordination.md) · [下一篇：单 vs 多 Session 设计深度对比 →](./13-single-vs-multi-session-design.md)

> **⚠️ 整章是 [External Reference Architecture](./06-roadmap.md#external-reference-architecture参考实现非项目路线图)，不在 qwen-code 主线**——qwen-code 主线只交付 daemon building block（Stage 1/1.5/2），不直接对标 Anthropic Managed Agents（云 SaaS 平台）。本章对比的是**基于 qwen-code daemon + 完整 External Reference Architecture 包装出来的"Managed Qwen Agents"产品** vs Anthropic Managed Agents 云服务。
>
> 主线 daemon 用户对此章不感兴趣可跳过。本章对**商业平台开发方**（如阿里云 / 第三方 SaaS 厂商基于 qwen-code 包装产品）有参考价值。

> **免责声明**：本对比基于 Anthropic 公开文档（截至 2026 Q1），Managed Agents 是闭源服务，具体实现细节、定价、内置工具列表可能已变更。本系列是 codeagents 项目的设计提案，与 Anthropic / Qwen 团队均无关联。

> **架构哲学相似性**：Anthropic Managed Agents 的内部模型很可能是"per-session container/process"（云原生隔离的最自然形态）；**PR#3889 Stage 1 (commit `6a170ef8`) Qwen daemon = channel-per-workspace + N session multiplexed** 在同 workspace 内偏离 Anthropic 的 per-session 隔离（同 workspace N session 共 OS 权限 + 共 MCP），跨 workspace 仍保持进程级隔离（[§02 §2](./02-architectural-decisions.md#2-状态进程模型)）。主要差异是 self-host 多进程 vs cloud 多容器，加上 Stage 1 同 workspace 内 in-process N-session 的资源经济性 vs Anthropic 假定的纯进程隔离。Anthropic 内部具体实现未公开，可能也走类似 hybrid 模型节省 container baseline。External SaaS 部署路径：daemon instance per-pod + orchestrator 路由（[§14 SaaS Phase 1-4](./14-orchestrator-multi-tenancy.md#五4-个-phase演进路径)）。

## 一、TL;DR

| 维度 | Anthropic Managed Agents | Qwen daemon |
|---|---|---|
| **本质** | 云托管 SaaS agent runtime | 自托管 agent daemon |
| **代码** | 闭源 | Apache-2.0 开源 |
| **模型** | Claude only | 任意 provider（DashScope / Claude / OpenAI / 自训练）|
| **运维负担** | 0（Anthropic 托管）| 高（用户自管 k8s / Postgres）|
| **数据驻留** | Anthropic 数据中心（US/EU 受限选项）| 用户决定（任何 region / 私有云 / 离线）|
| **部署时间** | 几分钟 | 主线 ~3 周（Stage 1/1.5/2 daemon GA）→ External Phase 1-4 ~3-6 月（多租户 + sandbox + SaaS）|
| **适用** | 快速 MVP / 不想运维 | 高合规 / 离线 / 多 provider / 大规模 |
| **混合可行** | ✓ Qwen daemon 可调用 Anthropic API | ✓ |
| **核心差异** | 控制权换便利 | 便利换控制权 |

## 二、Anthropic Managed Agents 能力概览

> 以下基于 2026 年 Q1 Anthropic 公开文档与 Console 描述。

### 2.1 平台组成

```
Anthropic Managed Agents
├─ Agent SDK (Python / TypeScript)
│   - 类似传统 Anthropic SDK，加 agent abstraction
│   - 用于本地开发 + 部署到 managed runtime
├─ Managed Runtime (Anthropic-hosted)
│   - Multi-tenant, Anthropic 运维
│   - Auto-scaling
│   - Session persistence
│   - Integrated billing
├─ Built-in tools
│   - web_search
│   - code_execution (sandboxed Python)
│   - file_operations (managed filesystem)
│   - text_editor
├─ MCP integration
│   - 连接外部 MCP servers
│   - 用户可挂自己的 MCP
├─ Console / Dashboard
│   - Session viewing
│   - Usage / billing
│   - Audit log
└─ Pricing
    - LLM tokens (Claude API rate)
    - Compute time (sandboxed code execution)
    - 可能有 platform overhead fee
```

### 2.2 关键特性

| 特性 | 说明 |
|---|---|
| **Long-running sessions** | Session 在 call 之间持久化（Anthropic 管理状态）|
| **Background execution** | Agent 可以异步跑长任务，结果通过 callback / poll 拿 |
| **Tool result caching** | LLM 输出 / tool result 自动 cache（节省 token）|
| **Built-in code sandbox** | Anthropic-managed 安全执行环境（推测基于 micro-VM / gVisor）|
| **MCP marketplace（部分）** | 预集成的 MCP servers |
| **Streaming responses** | SSE / chunked HTTP |
| **Vision / multimodal** | Claude vision 能力直接可用 |
| **Function calling** | 标准 JSON schema |

### 2.3 Anthropic Managed 不支持 / 受限

- **自定义 LLM provider**：仅 Claude（Opus/Sonnet/Haiku）
- **自定义 sandbox**：必须用 Anthropic 的 managed sandbox
- **离线部署**：完全在线 SaaS
- **Air-gapped 环境**：不可用
- **数据完全自主**：必须信任 Anthropic（虽有 SOC2/HIPAA 等认证）
- **核心 runtime 改造**：闭源，不可改
- **多模型路由**：不能在同 agent 内动态切换 Claude/GPT/Qwen

## 三、5 层架构详细对比

### 3.1 Client 层

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| 主要 SDK | `@anthropic-ai/sdk` Python/TS | `@qwen/sdk-typescript` + Java + Python |
| 协议 | HTTPS + Anthropic 私有 API | HTTPS + ACP NDJSON over HTTP/SSE（[§03](./03-http-api.md)）|
| Auth | API key（console 生成）| Bearer token（[§05 §1](./05-permission-auth.md)）+ 可选 mTLS |
| Streaming | SSE | SSE + 可选 WebSocket（[§03](./03-http-api.md)）|
| 多 client 共 session | 设计上单 client | **默认多 client live collaboration（决策 §1+§6）**|
| Channel 多样性 | SDK only（开发者自包 IM）| ACP / SDK / WebUI / IDE / IM 内建（[channels 包]）|
| Reverse RPC（capability）| 标准 Anthropic 不太支持 | **Client Capability 协议**（[§10 §三](./10-remote-cli-mode.md)）|
| 远端 / Local | Local SDK → 远端 API | 全 3 类拓扑（[§10 §二](./10-remote-cli-mode.md)）|

### 3.2 Agent Runtime 层

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| 进程模型 | Anthropic 内部 worker pool（推测 per-session container/process 或 hybrid）| **PR#3889 Stage 1 = channel-per-workspace + N session multiplexed**（commit `6a170ef8`，同 workspace 应用层多 session，跨 workspace OS 进程隔离）；Stage 2e native in-process 可选（[§02 §2](./02-architectural-decisions.md#2-状态进程模型)）|
| Session 共享语义 | per call 独立 / 持久化跨 call | sessionScope 由 External orchestrator 路由（'single' 多 client 共享 daemon / 'thread' / 'user'，[§02 §1](./02-architectural-decisions.md#1-session-是否跨-client-共享)）|
| Session 状态管理 | Anthropic 管理（黑盒）| 主线：每 daemon JSONL transcript；External SaaS：+ orchestrator 层 SQLite/Postgres 聚合（[§14 持久化栈](./14-orchestrator-multi-tenancy.md#四持久化栈大致方向)）|
| 长跑 / Background | ✓ async tasks API | ✓ 4 kinds（agent/shell/monitor/dream）+ 跨 client 可见（[§subagent-display](../subagent-display-deep-dive.md)）|
| 进程隔离 | Anthropic 内部决定 | OS 进程边界（决策 §2）+ External Phase 2-3 sandbox（）|
| HA / SLO | Anthropic 99.9%+ | 主线：daemon crash 重启 + transcript fork-resume（PR#3739/3889）；External SaaS：99.9% 设计（）|

### 3.3 Tool 层

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| 内置 tool | web_search / code_execution / file_operations / text_editor | bash / edit / read / web_search / glob / grep / etc. |
| Tool definition | JSON schema | ACP zod schema |
| Custom tool | 通过 MCP server | 通过 MCP server 或直接挂 Qwen Code 的 tool framework |
| Tool execution location | Anthropic sandbox | 用户机器（NoSandbox）/ namespace / container / 远端机器（）|
| Tool result cache | Anthropic 自动 | FileReadCache（§02）+ session-private（决策 §4）|
| Permission flow | Anthropic-managed approval（推测）| 4 mode permission flow + 跨 client 应答（[§05](./05-permission-auth.md)）|

### 3.4 Sandbox 层

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| 沙箱方案 | Anthropic-managed（推测 micro-VM 或 gVisor）| **5 选 1**（）：NoSandbox / OS-user / namespace / container / remote |
| 用户可控 | ❌ | ✓ 完全可控 |
| 离线能力 | ❌ | ✓ NoSandbox / OS-user 模式 |
| 跨机器 sandbox | partial（managed）| ✓ remote sandbox（）|
| 多租户隔离 | Anthropic 管理 | 用户 enforce（）|

### 3.5 Persistence 层

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| Session 状态 | managed 黑盒 | JSONL transcript + SQLite/Postgres meta（[§14 持久化栈](./14-orchestrator-multi-tenancy.md#四持久化栈大致方向)）|
| Audit log | Anthropic console（受限查看）| 用户完全访问（SQLite 或 Postgres）|
| 数据驻留 | US / EU 选项 | 任意 region / 私有云 / 离线 |
| 数据加密 | Anthropic 管 | 用户 KMS / TDE 自管 |
| 备份 / 恢复 | Anthropic 管 | 用户管（pg_dump / S3 cross-region rep）|
| 数据导出 | Anthropic API | 直接读 fs + db |

## 四、内置工具完整对照

| Anthropic Managed | Qwen daemon 对应 |
|---|---|
| `web_search` | `WebSearchTool`（[web-search-tool 对比](../web-search-tool-deep-dive.md)）|
| `code_execution`（managed sandbox Python）| `Bash` tool + Sandbox 5 种（）|
| `file_operations`（managed filesystem）| `Edit` / `Read` / `Write` / `Glob` / `Grep` |
| `text_editor` | `Edit` tool 的内嵌行为 |
| Vision input | Multi-modal 通过 LLM provider（DashScope / Claude / GPT-4V）|
| Function calling | ACP zod schema 内置 |
| MCP servers | per-daemon MCP（决策 §3）|
| Sub-agent (Anthropic 的 agent-as-tool) | Background agent task kind（PR#3471/3488）|
| Anthropic-managed file storage | Workspace directory（用户 fs）|
| Long-running task callback | Background tasks dialog + SSE 事件（[§subagent-display](../subagent-display-deep-dive.md)）|

## 五、协议层详细对比

### 5.1 Anthropic API（推测，基于公开 SDK）

```
POST /v1/agents/{agent_id}/sessions
  → { session_id, created_at }

POST /v1/agents/{agent_id}/sessions/{sid}/messages
  → SSE stream of message_delta events

GET /v1/agents/{agent_id}/sessions/{sid}
  → session state

POST /v1/agents/{agent_id}/sessions/{sid}/cancel
```

特点：
- RESTful + SSE
- 私有 schema（不公开 OpenAPI / 不开源）
- API key 认证
- Per-session 隔离严格

### 5.2 Qwen daemon（[§03 HTTP API](./03-http-api.md)）

```
POST /v1/session
  body: NewSessionRequest (复用 ACP zod schema)
  
POST /v1/session/{sid}/prompt
  body: PromptRequest
  → SSE stream
  
GET /v1/session/{sid}/events?Last-Event-ID=evt-N
  → SSE stream（可重连）
  
POST /v1/session/{sid}/capability/{cap-id}/response
  → reverse RPC response（[§10 §三](./10-remote-cli-mode.md)）

GET /v1/session/{sid}/subscribers
  → 多 client 列表
```

特点：
- HTTP + SSE + 可选 WebSocket
- 复用 ACP NDJSON schema（标准、开源）
- Bearer token 认证
- Multi-client 设计（[§11](./11-client-coordination.md)）
- Reverse RPC capability protocol

### 5.3 关键协议差异

| 维度 | Anthropic | Qwen daemon |
|---|---|---|
| Schema 来源 | 私有 | 标准 ACP（开源 [@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)）|
| Multi-client per session | ❌ | ✓ |
| Last-Event-ID 重连 | partial（standard SSE）| ✓ + transcript-first 重建（）|
| Reverse RPC | 不支持 | ✓ Client Capability（[§10](./10-remote-cli-mode.md)）|
| Schema 演进 | Anthropic 主导 | ACP 社区共识 + Qwen 贡献 |
| OpenAPI 自动生成 | ❌（推测）| ✓ 可选（External Phase 1+）|

## 六、双向 Migration（理论可行）

两个方向都**理论可行但非项目目标**，仅作架构兼容性证明：

- **Anthropic Managed → Qwen daemon**：Provider 切到 Anthropic API 仍用 Claude 模型保持行为一致；MCP servers 协议兼容直接迁；session 状态需 schema 映射脚本（Anthropic 私有 → ACP JSONL）。风险：非 Claude 模型 prompt 行为差异、Anthropic-specific tool（code_execution Python 沙箱）需手动适配
- **Qwen daemon → Anthropic 兼容 API**："drop-in replacement"——加 HTTP route adapter（`/v1/agents/...` ↔ `/v1/session/...`）+ schema adapter（AnthropicMessage ↔ ACP message_part）+ provider adapter（model 名映射），daemon core 0 改动、纯前端 adapter ~500 行 TS

均不在 qwen-code 主线或 External Reference Architecture 范围。如有商业需求由集成方按上面思路实施。

## 七、数据驻留 / 合规对照

| 合规标准 | Anthropic Managed | Qwen daemon 自托管 |
|---|---|---|
| SOC 2 Type II | ✓（Anthropic 提供）| 用户自己取得 |
| HIPAA | ✓（BAA available）| 用户自部署可达 |
| GDPR | ✓（EU region option）| 在 EU 部署 ✓ |
| PCI-DSS | partial | 用户严格部署 ✓ |
| ISO 27001 | ✓ | 用户自申请 |
| 中国 网安法 | ❌（数据出境）| ✓ 国内部署 |
| 欧盟 数据本地化 | partial | ✓ |
| 美国 FedRAMP | partial（GovCloud）| 用户严格部署 |
| Air-gapped 部署 | ❌ | ✓ |
| 离线 30+ 天 | ❌ | ✓ |
| 客户自己 KMS 加密 | partial | ✓ 完全自管 |

## 八、6 类典型客户场景的选型推荐

### 8.1 初创应用做 MVP

**推荐**：Anthropic Managed Agents

**原因**：
- 几小时内集成
- 没有 SRE 团队
- 用户量较小，managed 服务运维省心
- 模型 Claude 足够用

### 8.2 中型企业内部工具

**推荐**：混合（Qwen daemon 主线（Stage 1/1.5/2）+ Anthropic API）

**原因**：
- 几百用户内部使用
- 数据敏感不想完全云化
- Qwen daemon 自托管 + 用 Anthropic API 作为 provider
- 多端（CLI / IDE / 内部 IM bot）共享 session 的协作模式

### 8.3 金融 / 医疗合规

**推荐**：Qwen daemon + External Phase 1-2（多租户 + sandbox）

**原因**：
- 数据完全自主必需
- HIPAA / PCI 严格要求
- 自部署 + KMS 加密 + audit log 在本地
- 可审计 / 可取证

### 8.4 政府 / 国防

**推荐**：Qwen daemon + External Phase 1-2 air-gapped

**原因**：
- 必须离线
- 数据出境禁止
- 自部署在分类网络

### 8.5 大规模 SaaS（数千用户）

**推荐**：Qwen daemon + External Phase 4 SaaS SaaS

**原因**：
- 多租户 HA 架构齐备（）
- 多 LLM provider 路由灵活
- 可对客户提供"Managed Qwen Agents"服务

### 8.6 开发者工具 / Dev infrastructure

**推荐**：Qwen daemon Stage 1-3

**原因**：
- 单/小团队使用
- 本地高 fidelity 体验（< 1ms latency）
- 可离线 / 弱网工作

## 九、"Managed Qwen Agents" 产品蓝图

阿里云 / 第三方厂商基于 qwen-code daemon building block + 完整 External Reference Architecture（Orchestrator / 多租户 / Sandbox / SaaS deployment）包装 SaaS 产品，对标 Anthropic Managed Agents：

### 9.1 产品组成

```
Managed Qwen Agents (External Reference Architecture 完整实施 + 商业层)
├─ Qwen daemon building block (开源核心，主线 Stage 1/1.5/2)
├─ External Phase 1-4 实施（[§14](./14-orchestrator-multi-tenancy.md) +  + ）
├─ Web Console
│   - Tenant 管理 / agent 定义 / session 浏览 / billing
├─ 计量统计
│   - per-tenant LLM token / compute / storage 用量记录
├─ OIDC / SSO 集成
│   - Auth0 / Okta / 钉钉 / 微信企业号
├─ Marketplace
│   - 预集成 MCP servers
│   - Agent 模板
└─ 客服 + SLA
    - 99.9% SLO 商业承诺
    - 7×24 支持
```

### 9.2 与 Anthropic Managed 的差异化

| 差异化点 | Managed Qwen Agents 优势 |
|---|---|
| 多 LLM 选择 | DashScope qwen / Claude / GPT / Llama 同一 agent 内动态切换 |
| 中国数据驻留 | 中国大陆 region 默认 |
| Live collaboration | 多 client 共 session（决策 §1+§6）|
| Channel 内建 | 微信 / 钉钉 / 飞书 channels 包开箱即用 |
| 私有部署混合 | 公有云 + 私有云 hybrid |
| 离线 / Air-gapped | ✓（Anthropic Managed 不支持）|

### 9.3 缺什么（商业层）

| 组件 | 工作量估算 |
|---|---|
| Web Console | 2-3 月 / 2-3 人 |
| Billing 系统 | 1-2 月 / 1-2 人 |
| OIDC / SSO 集成 | 0.5 月 / 1 人 |
| Marketplace | 1-2 月 / 1-2 人 |
| 客服平台 | 1 月 / 1 人 |
| 法务 / 合规认证 | 3-6 月（合规审计周期）|
| 销售 / 市场 | 持续 |
| **总计** | **~6 月 + 持续运营** |

**架构本身（qwen-code daemon building block + External Reference Architecture 完整设计已就位）**——daemon 主线 ~3 周，External Phase 1-4 ~3-6 月，缺的是商业产品层（Console / Marketplace / 客服 / 合规）。

### 9.4 阿里云的天然优势

阿里云作为 Qwen 主要赞助方，包装 "Managed Qwen Agents" 有天然优势：
- DashScope 模型直接走内部 API
- 阿里云 k8s / RDS / OSS 可用
- 中文生态：钉钉 / 飞书集成现成
- 中国合规：数据驻留 / 网安认证可达
- billing：阿里云控制台集成

## 十、性能 / latency 对比

| 场景 | Anthropic Managed | Qwen daemon 自托管 |
|---|---|---|
| Token first byte | ~500ms（含上传到 Anthropic + cold start）| ~50-100ms（本地）/ ~150-300ms（远端）|
| 流式 throughput | Anthropic 服务器 | 本地 / 用户网络 |
| Tool call round-trip | Anthropic 内部 | 本地 < 1ms / 远端 50ms |
| Cold start | 由 Anthropic 控制 | 由用户控制 |
| Tail latency | Anthropic SLO | 用户配置（可能更稳）|

**对开发体验**：
- 自托管 NoSandbox 模式 < 1ms tool round-trip → 极速反馈
- Anthropic Managed 始终有云端 round-trip → 不可避免 100-300ms 增量

## 十一、安全模型对比

### 11.1 Anthropic Managed 安全模型

```
信任边界:
  你的 client app
       ↓ HTTPS + API key
  Anthropic 边界 ←─ 信任 Anthropic 不滥用数据
       ├─ 你的 prompt + tool call 都在 Anthropic 处理
       ├─ 你的数据 transit / at rest 都加密
       └─ 但 Anthropic 内部仍可访问（合规审计场景）
```

### 11.2 Qwen daemon 安全模型

```
信任边界:
  你的 client app
       ↓ HTTPS + Bearer
  你的 daemon ←─ 你完全控制
       ├─ 自管 KMS 加密
       ├─ 自管 audit log
       └─ Provider API call 时数据出去（按 provider 选择）

Provider 信任:
  - Anthropic API: 你信任 Anthropic 不滥用 prompt/output
  - DashScope: 你信任 阿里云
  - 自部署 LLM: 完全自主
```

### 11.3 横向越权防御

 设计了 5 层防御 + 17 攻击向量 + 24+ 测试用例。Anthropic Managed 由 Anthropic 自管这部分（用户看不到）。

**自托管 = 你知道防御具体怎么做 + 可审计**；
**Managed = 你信任 Anthropic 做得好 + 可不操心**。

## 十二、Stage / Phase 演进: 何时能挑战 Anthropic Managed

| 阶段 | 范畴 | 能力 | vs Anthropic Managed |
|---|---|---|---|
| Stage 1 (qwen serve daemon, PR#3889) | qwen-code 主线 | 基础 daemon + ACP NDJSON over HTTP+SSE + bearer auth | 单 dev tool；远不及 Managed |
| Stage 1.5 (Mode A) | qwen-code 主线 | + CLI + HttpServer 同进程 | 同上 |
| Stage 2 (daemon 完善) | qwen-code 主线 | + mDNS / OpenAPI / WebSocket bidi / 多 token / metrics | 已具备 SDK 单 client 完整体验 |
| External Phase 1 (Orchestrator + 多租户 ACL) | External Reference | + qwen-coordinator + Tenant + quota（[§14](./14-orchestrator-multi-tenancy.md)）| 接近 Anthropic Managed multi-tenant |
| External Phase 2-3 (sandbox) | External Reference | + 5 种 sandbox（）| 沙箱选择上超过 Anthropic（更灵活）|
| External Phase 4 (SaaS HA) | External Reference | + Postgres + S3 + Redis + HA（）| **架构上完全对标 Anthropic Managed** |
| 加商业层 | 商业产品 | + Console + Billing + Marketplace + 客服 | **产品上完全对标 Anthropic Managed** |

**External Reference Architecture 完整实施 + 商业层 = 完整的 Managed Qwen Agents 产品**。

## 十三、与决策的协同

| Qwen daemon 决策 | 与 Anthropic Managed 的对比意义 |
|---|---|
| §1 sessionScope='single' | Anthropic 设计单 client，Qwen 默认多 client live collaboration（差异化）|
| §3 MCP per-workspace | 与 Anthropic MCP 一致 |
| §5 Permission flow 4-mode | Anthropic permission 隐藏在内部；Qwen 显式可控 |
| §6 多 client + first responder | Anthropic 不支持；Qwen 独有 |
|  5 种 sandbox | Anthropic 1 种 managed sandbox；Qwen 灵活 |
| External SaaS HA + sticky session | 商业层 Managed Qwen Agents 的基础 |
| §10 Capability reverse RPC | Anthropic 不支持；Qwen 独有 |

## 十四、何时选哪个：决策树

```
Q1: 数据可以驻留 Anthropic 数据中心吗？
  No → 选 Qwen daemon
  Yes → Q2

Q2: 需要 Claude 之外的 LLM provider 吗？
  Yes → 选 Qwen daemon
  No → Q3

Q3: 需要离线 / air-gapped 部署吗？
  Yes → 选 Qwen daemon
  No → Q4

Q4: 团队有 SRE / k8s 能力吗？
  No → 选 Anthropic Managed
  Yes → Q5

Q5: 需要多 client 共 session（IM bot / Web UI / CLI 协作）？
  Yes → 选 Qwen daemon（live collaboration 独有）
  No → Q6

Q6: 需要中国大陆数据驻留 / 国内合规？
  Yes → 选 Qwen daemon（DashScope + 国内部署）
  No → 二选一都可
```

## 十五、混合部署模式

很多场景**不是二选一**，而是组合使用：

### 15.1 Qwen daemon 作为 router → Anthropic API 作为 provider

```
User → Qwen daemon (自托管) → Anthropic API (Claude 模型)
                            ↓
                         OR DashScope (Qwen 模型)
                            ↓
                         OR 自训练 LLM endpoint
```

**好处**：
- 数据 transit 时仍过 Anthropic（如果选 Claude）
- 但 audit / session state / sandbox / permission 全在自己手里
- 可对不同 tenant / workspace 用不同 provider

### 15.2 主 Qwen daemon + 灾备 Anthropic Managed

```
正常: 流量 → Qwen daemon
灾备: Qwen daemon 全宕 → 临时切到 Anthropic Managed（保 SLA）
```

需要业务 client 抽象层支持双端 fallback。

### 15.3 不同 tier 用不同方案

```
Free tier 用户  → Anthropic Managed（外包，简单）
Premium tier  → Qwen daemon 自托管（合规 + 性能）
Enterprise   → Qwen daemon 私有部署
```

## 十六、与 OpenCode / Claude Code 三方对比

| 维度 | Anthropic Managed | Claude Code | OpenCode | Qwen daemon |
|---|---|---|---|---|
| 形态 | 云 SaaS | CLI | self-host daemon | self-host daemon |
| 模型 | Claude only | Claude only | 任意 | 任意 |
| 多租户 | ✓ | ❌ | ❌ | ✓ External Phase 1+ |
| Multi-client per session | ❌ | N/A | ❌ | ✓ |
| Sandbox 选择 | 1（managed）| Linux namespace（v2.1.98+）| 无 | 5 种 |
| 离线 | ❌ | ✓ | ✓ | ✓ |
| 开源 | ❌ | ❌ | ✓ MIT | ✓ Apache-2.0 |
| HA / SaaS 设计 | Anthropic | N/A | minimal | ✓ External Phase 4 ()|
| 中国合规 | ❌ | ❌ | ✓ self-host | ✓ DashScope + self-host |

## 十七、一句话总结

Anthropic Managed Agents 与 Qwen daemon 是**两种互补哲学**：

- **前者"管运维换控制权"**：云托管 SaaS / Claude only / 几分钟集成 / 数据驻留 Anthropic / 单 client 设计 / 1 种 managed sandbox / 闭源 / 适合 MVP 与小型部署
- **后者"自管运维拿控制权"**：自托管 / 任意 LLM provider / 几天-几周部署 / 数据完全自主 / 多 client live collaboration / 5 种 sandbox / Apache-2.0 开源 / 适合高合规 / 离线 / 多 provider 路由 / 大规模 SaaS

**架构维度对照高度相似**（multi-tenant / sandbox / persistence / HA / MCP 都有），但实现位置和默认值完全不同。**混合模式可行**：Qwen daemon 自托管作 router + Anthropic API 作 provider；或不同 tier 用不同方案。

**Qwen daemon building block + External Reference Architecture 完整实施（Phase 1-4）+ 商业层**（Console / Marketplace / 客服 / 合规）= 完整 "Managed Qwen Agents" 产品对标 Anthropic Managed Agents——daemon 主线 ~3 周（Stage 1/1.5/2），External Phase 1-4 ~3-6 月，商业层另需 ~6 月。阿里云有天然优势包装这个产品（DashScope / 钉钉飞书 / 中国合规 / 中文生态）。

**全场景覆盖**：决策树 6 问选型 + 6 类客户场景推荐 + 3 种混合部署模式。

---

[← 上一篇：多端协调策略](./11-client-coordination.md) · [下一篇：单 vs 多 Session 设计深度对比 →](./13-single-vs-multi-session-design.md) · [回到 README](./README.md)
