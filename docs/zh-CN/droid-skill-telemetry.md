# Factory Droid Skill telemetry

本文说明 LoongSuite Pilot 如何把 Factory Droid 的原生 `Skill` tool 调用映射成
AgentLoop 可分析的 Skill TOOL span。

当前实现是 Droid exact adapter：它只认 Droid transcript 中真实的 `Skill` tool call，
不从普通 Read、Bash 参数、system prompt 或 `skills/<name>` 路径猜测 activation。

## 数据模型

Droid 已经为 Skill 加载生成真实 tool call，因此 Pilot 直接丰富原有 call/result，
不会再合成第二个 `load_skill`：

```text
event.name = tool.call | tool.result
gen_ai.tool.name = Skill
gen_ai.tool.call.id = <Droid tool call ID>
gen_ai.skill.id = <canonical Skill name>
gen_ai.skill.name = <canonical Skill name>
```

OTLP 转换按 `gen_ai.tool.call.id` 合并 call/result，最终一次 Droid `Skill` 调用只形成
一个 TOOL span。首版不重复发送 `event.name=skill.use`，也不把 Skill identity 传播给
后续 LLM、Tool、Step 或 subagent span。

## Exact activation contract

只有同时满足以下条件的 transcript block 才会归因：

- tool name 大小写不敏感地精确等于 `Skill`；
- arguments 是 object，且 `arguments.skill` 是合法的非空单行字符串；
- Skill name 不超过 256 个字符，也不包含 NUL、CR 或 LF；
- 配置必须是 `enabled=true`、`mode=exact`、
  `versionStrategy=content_sha256`、`weakPathHeuristics=false`。

以下情况 fail closed，不产生 Skill attribution：

- `Read` 访问 `.../skills/<name>/SKILL.md` 或 Skill 目录内其他文件；
- Bash、Prompt、tool result 中仅出现 Skill 名称或路径；
- `LoadSkill`、`skill_view` 等名称相似但不是 Droid 原生 `Skill` 的 tool；
- arguments 缺失、类型错误或 Skill name 不合法；
- exact policy 未完整启用。

这意味着 Catalog 只存在、Skill 文件只被读取或文本只被提及，都不会被计为 Skill load。

## Revision 与诊断字段

成功的原生 Skill tool result 如果是非空字符串且不超过 1 MiB，Pilot 会对 Droid
实际返回给模型的 raw UTF-8 字符串计算 SHA-256：

```text
gen_ai.skill.version = sha256:<前 12 位>
loongsuite.skill.content_sha256 = <完整 SHA-256>
loongsuite.skill.revision_source = observed_tool_result
```

这里的 revision 表示“本次 tool result 中模型实际观测到的 Skill payload”，不是 Pilot
当前磁盘上 `SKILL.md` 的 hash。它避免用部署后的文件状态冒充当时 loaded bytes；但如果
Droid 自己在 result 中加入 wrapper 或 metadata，hash 也会包含这些字节。

每次 activation 还包含：

| 字段 | 值 |
|------|----|
| `loongsuite.skill.activation_id` | 原始 Droid tool call ID |
| `loongsuite.skill.trigger` | `model_tool` |
| `loongsuite.skill.provenance` | `native_skill_tool` |
| `loongsuite.skill.confidence` | `direct` |
| `loongsuite.skill.content_sha256` | 成功并可计算时的完整 SHA-256 |
| `loongsuite.skill.revision_source` | 成功并可计算时为 `observed_tool_result` |

失败、取消、空结果、非字符串结果或超过 1 MiB 时，call/result 仍保留 id、name 和固定
诊断字段，但不会伪造 version/hash。TOOL span 的原有 error status 保持不变。

## 配置与隐私

升级后默认关闭。先在 `~/.loongsuite-pilot/config.json` 中显式启用：

```json
{
  "agents": {
    "droid": {
      "enabled": true,
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

修改后重启 collector：

```bash
loongsuite-pilot restart
```

当 `captureMessageContent=false` 时，Pilot 会移除 Prompt、Completion、tool arguments、
tool result、Skill body 和路径，但保留 id、name、version、hash 及固定枚举诊断属性。
即使开启内容采集，Droid 内容也固定经过完整的 `mode=all` masking。

## 本地与生产验收

使用一个全新的 Droid CLI session，并让模型真实调用一次原生 `Skill` tool。四层证据必须
使用同一个 session ID 和 tool call ID 关联。

### 1. Droid source transcript

确认该 session 有且只有预期的原生 `Skill` call，arguments 中的 canonical name 正确，
result status 成功。验收报告只记录字段、计数和 hash，不复制 Skill body。

### 2. Normalized JSONL

```bash
rg '<SESSION_ID>|gen_ai.skill|loongsuite.skill' \
  ~/.loongsuite-pilot/logs/output/droid-*.jsonl
```

确认 call/result 的 `gen_ai.tool.call.id` 相同、标准字段与诊断字段完整，Agent identity 为
`droid`。普通 Read 或 Bash 不应带 `gen_ai.skill.*`。

### 3. Durable OTLP queue

```bash
loongsuite-pilot failed replay --dry-run
```

确认 pending 和 dead-letter 均为 0；如果失败队列中出现该 session，必须先解决导出问题，
不能把本地 normalized 记录视作生产验收完成。

### 4. AgentLoop / SLS

在 AgentLoop session detail 或对应 SLS project/logstore 中按新 session ID 查询，确认：

- 只有一个原生 Skill TOOL span；
- TOOL 上有 `gen_ai.skill.id/name`；
- 成功计算 revision 时 version/hash 与本地完全一致；
- provenance、trigger、confidence 与 activation ID 正确；
- 普通 Read/Bash 没有产生额外 Skill load。

本地 transcript 证明 Droid 真实调用，normalized JSONL 证明 Pilot contract，durable queue
证明交付状态，AgentLoop/SLS 证明生产云端可见。任何单层证据都不能替代完整验收。

## Rollback 与能力边界

先关闭功能并重启即可停止新的 attribution：

```json
{
  "agents": {
    "droid": {
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

首版不提供 user command/autoload 的独立归因、candidate set、selection reason、
Skill identity 下游传播、多 Skill causality 或历史 session revision backfill。旧数据如果没有
原生 `Skill` call/result，只能作为 heuristic reconstruction，不得混入 exact telemetry 指标。
