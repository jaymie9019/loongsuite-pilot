# Pi Coding Agent / OMP Skill telemetry

本文说明 LoongSuite Pilot 如何为基于 Pi Coding Agent SDK 的 OMP（Oh My Pi）采集
Skill activation，并将它映射到 AgentLoop 可分析的 OpenTelemetry TOOL span。

当前实现是 Pilot plugin-only exact adapter：不修改 OMP，也不从 system prompt、普通路径或
Bash 文本猜测 Skill。它只记录 OMP structured activation 或能够由 catalog 精确校验的 Read。

## 数据模型

AgentLoop 将 Skill 加载表示为带 `gen_ai.skill.*` 属性的 TOOL span，而不是独立 Skill
span。字段语义以 [AgentLoop AI Agent 可观测字段定义](https://help.aliyun.com/zh/document_detail/3046157.html)
为准。

Pilot 使用以下唯一事实源：

- 没有真实 tool call 的 `/skill` 或注入消息，生成一对 synthetic `tool.call` / `tool.result`；
- 真实 Read 直接丰富已有 call/result，不再额外生成 `load_skill`；
- OTLP 转换按 `gen_ai.tool.call.id` 合并 call/result，最终每次 activation 只产生一个 TOOL span；
- 首版不重复发送 `event.name=skill.use`。

synthetic TOOL 的核心字段如下：

```text
event.name = tool.call | tool.result
gen_ai.tool.name = load_skill
gen_ai.tool.type = extension
gen_ai.tool.call.id = <deterministic activation ID>
gen_ai.skill.*
```

## 可识别的 activation

| OMP 行为 | 证据 | 输出 |
|----------|------|------|
| 用户 `/skill:name` | `message_start` 中 `customType=skill-prompt`、合法 name 和根 `SKILL.md` path，且 `attribution=user` | synthetic `load_skill` TOOL，`trigger=user_command` |
| OMP 或 subagent 注入 Skill | `message_start` 中 `customType=skill-prompt`、合法 name 和根 `SKILL.md` path，且 attribution 非 `user` | synthetic `load_skill` TOOL，`trigger=agent_injected` |
| `read skill://name` | Read 参数是 canonical root URI，且 active catalog 唯一匹配 | 丰富原 Read TOOL，`trigger=model_read` |
| `read skill://name/SKILL.md` | 规范化为 root URI，且 active catalog 唯一匹配 | 丰富原 Read TOOL，`trigger=model_read` |
| 直接读取注册 Skill 的根 `SKILL.md` | tool result 的 `resolvedPath` 精确等于 active catalog 的 canonical file path | 丰富原 Read TOOL，`trigger=model_read` |

以下行为不会增加 activation：

- `skill://name/references/...` 等 resource Read；
- 仅位于 Skill `baseDir` 内的普通文件；
- Bash 参数或输出中出现的 `skill://` 文本；
- 普通文本、system prompt 或任意 `skills/<name>` 路径；
- catalog 缺失、抛错、同名冲突的 Read，或 catalog 将同一 path 标识成另一个 Skill name 的事件。

这些规则对应三类证据强度：

| 类型 | 含义 | 当前是否用于 attribution |
|------|------|-------------------------|
| direct | OMP structured `skill-prompt` 或 canonical root `skill://` URI | 是 |
| exact-match | Read 的最终 `resolvedPath` 与 active catalog 根文件完全一致 | 是 |
| heuristic | 普通路径、目录、文本或 Bash 内容推断 | 否 |

Catalog 的来源依次为 `api.pi?.getActiveSkills?.()`、`api.getActiveSkills?.()` 和信息完整的
`api.getCommands()` Skill command。空的 active list 才会降级到 command catalog。对于 Read，
catalog 用于身份校验；对于 structured `skill-prompt`，OMP 实际加载的 name/path 是 direct evidence，
catalog 仅在 path 精确匹配时补充 description。同名 Skill 的其他 cache path 不会覆盖实际加载的
revision。Catalog 本身不表示 Skill 已被调用。

## 字段契约

每次确认的 activation 至少包含：

```text
gen_ai.skill.id
gen_ai.skill.name
```

其中 `id` 首版固定为 canonical Skill name。可获取时还会附加：

```text
gen_ai.skill.description
gen_ai.skill.version
```

`version` 的格式为 `sha256:<前 12 位>`，hash 来源是 Pilot 在 detection 时重新读取的根
`SKILL.md`。完整 hash 写入 `loongsuite.skill.content_sha256`。若文件不可读、不是普通文件或超过
1 MiB，Pilot 仍保留 name/id，但不伪造 version。

诊断属性如下：

| 字段 | 值 |
|------|----|
| `loongsuite.skill.activation_id` | synthetic TOOL 的 deterministic call ID；真实 Read 使用原 `toolCallId` |
| `loongsuite.skill.trigger` | `user_command`、`agent_injected` 或 `model_read` |
| `loongsuite.skill.provenance` | `skill_prompt`、`explicit_skill_uri` 或 `catalog_exact_path` |
| `loongsuite.skill.confidence` | `direct` 或 `exact_match` |
| `loongsuite.skill.content_sha256` | detection 时读取文件得到的完整 SHA-256 |
| `loongsuite.skill.revision_source` | 当前固定为 `observed_file` |

activation ID 由 session ID、message timestamp、Skill name、canonical path 和 attribution
确定性计算。相同事件 replay 不会重复生成 span。并发 Read 由各自 `toolCallId` 隔离。

> `observed_file` 只说明 Pilot 观测时磁盘上的 revision。因为 plugin 会重新读取文件，它不能绝对
> 证明 OMP 实际加载的 bytes 与该文件完全相同。进行 A/B 实验时必须冻结 Skill 文件，并同时按
> session、variant 和 content hash 控制 exposure。

## 配置

功能升级后默认关闭。先在 `~/.loongsuite-pilot/config.json` 中为 OMP 显式启用：

```json
{
  "agents": {
    "omp": {
      "captureMessageContent": false,
      "skillTelemetry": {
        "enabled": true,
        "mode": "exact",
        "versionStrategy": "content_sha256",
        "weakPathHeuristics": false
      }
    }
  }
}
```

首版只支持上面的 `exact`、`content_sha256` 和 `weakPathHeuristics=false` 组合。未知 mode、
version strategy 或开启 weak heuristic 时会 fail closed，不采集 Skill activation。

修改后重启 collector，并重新启动 OMP，使新进程加载当前 extension：

```bash
loongsuite-pilot restart
```

### 隐私策略

当 `captureMessageContent=false` 时，Skill telemetry 仍保留 id、name、version、hash 和固定枚举
诊断属性，但不会发送：

- Skill description 或 body；
- tool arguments 或 result；
- Skill 绝对路径；
- `skill-prompt` 的 content。

即使开启内容采集，adapter 也不会把 Skill body 或绝对路径写入 Skill 诊断字段。建议敏感环境继续
配合 [数据脱敏](masking.md) 使用。

## 安装、doctor 与 rollback

从 fork 构建可追溯安装包：

```bash
cd /path/to/loongsuite-pilot
npm ci
npm run build
bash deploy/package-opensource.sh
bash deploy/installer-opensource.sh \
  --package-url "file://$(pwd)/loongsuite-pilot.tar.gz"
```

`deploy/package-opensource.sh` 会把当前 `git commit` 写入包内 `VERSION`。安装后用
`loongsuite-pilot info` 核对版本与 commit。

OMP wrapper 与 shared Pi runtime 必须使用兼容的 plugin API。检查：

```bash
loongsuite-pilot agent doctor omp
```

健康结果必须同时满足：

- `runtimeLoadable=true`；
- `wrapperLoadable=true`；
- `runtimeApiVersion` 与 Pilot 预期版本一致；
- `contractError` 为空；
- wrapper 已注入 OMP settings，且 detection 条件成立。

`register pi-sdk` 会在写 wrapper 和 OMP settings 前执行同一 contract preflight。runtime 文件虽
存在但 named factory 缺失、API version 不兼容或 wrapper import 失败时，registration 会停止且不
修改 OMP settings。upgrade restore 也不会恢复一个注定无法 import 的 wrapper。

若 canary 出现问题，先关闭 telemetry 并重启：

```json
{
  "agents": {
    "omp": {
      "skillTelemetry": { "enabled": false }
    }
  }
}
```

需要回退整个 Pilot 时使用：

```bash
loongsuite-pilot rollback
loongsuite-pilot restart
```

回退后重新启动 OMP，并再次运行 `agent doctor omp` 验证旧版本 wrapper/runtime 可以共同加载。

## 四层验证路径

使用一个全新的 OMP session，分别执行 `/skill:<name>`、injected Skill、root `skill://` Read、
resource Read、普通 Read 和 Bash negative case。每层都用同一个 session ID、tool call ID 或
activation ID 关联。

### 1. Plugin raw JSONL

```bash
rg 'gen_ai.skill|loongsuite.skill' \
  ~/.loongsuite-pilot/logs/pi-coding-agent/*.jsonl
```

确认 synthetic activation 恰好有一对 call/result；真实 Read 仍只有原 call/result。resource 和
negative case 不应出现 Skill 字段。

### 2. Normalized JSONL

```bash
rg 'gen_ai.skill|loongsuite.skill' \
  ~/.loongsuite-pilot/logs/output/*.jsonl
```

确认标准与诊断属性仍存在，且 Agent identity 保持：

```text
gen_ai.agent.type = omp
gen_ai.agent.id = omp
gen_ai.agent.name = Oh My Pi
```

### 3. OTLP 转换与导出

临时开启 `otlpTrace.debug=true` 后检查：

```bash
rg 'gen_ai.skill|loongsuite.skill' \
  ~/.loongsuite-pilot/logs/otlp-debug/*.jsonl
```

导出失败时查看：

```bash
rg 'gen_ai.skill|loongsuite.skill' \
  ~/.loongsuite-pilot/logs/otlp-failed/*.jsonl
```

synthetic call/result 应合并为一个 `load_skill` TOOL span；Read activation 应只有一个原 Read TOOL
span。Skill identity 不应传播到无关 LLM、Step 或其他 Tool span。

### 4. AgentLoop

在 AgentLoop session detail 中按 session ID 定位会话，然后确认：

- 每个真实 activation 恰好一个 Skill load TOOL；
- TOOL 上至少有 id/name，hash 成功时有 version；
- resource Read 和 negative case 不增加 load 数；
- session 的 Agent identity 仍为 OMP；
- 本地 debug 与 AgentLoop 的 call ID、Skill name、version 一致。

本地 raw 证明 plugin capture，normalized 证明 schema 保留，OTLP debug/failed 证明转换和导出边界，
AgentLoop 页面证明云端可见。只验证其中一层不能替代完整链路验收。

## 能力边界

plugin-only 版本暂不提供：

- OMP 原生 `skill_activation` event；
- autoload 与其他 agent injection 的精确区分；
- OMP 实际 loaded bytes hash；
- plugin 停机期间的持久化 replay；
- candidate set、selection reason 或 load-to-invoke conversion；
- Skill identity 向后续 Tool、LLM、Step 和 subagent 的因果传播；
- 多 Skill 会话中的严格效果归因。

因此 AgentLoop A/B 的结果只能解释为“这个观测到的 Skill revision 被加载时，会话指标如何”，
不能仅凭 load telemetry 解释为一般性的因果证明。

## 历史数据

旧 session 没有当时的 structured activation 和 revision evidence，不能变成权威 Skill telemetry。
可以离线做隔离的 heuristic reconstruction，但必须遵守：

- root `skill://` Read 最多恢复 name；
- 不用当前磁盘文件 hash 冒充历史 revision；
- 标记 `provenance=reconstructed`、`completeness=partial`；
- 默认只生成 dry-run 报告；
- 不自动重新上传，也不混入新 telemetry 的正式指标。

当需求升级到准确区分 autoload、可靠 replay、真实 loaded bytes 或多 Skill causality 时，应在 OMP
中增加原生 `skill_activation` 事件，而不是继续扩展路径 heuristic。
