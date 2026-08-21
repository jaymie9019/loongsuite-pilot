# Agent 配置

[English](../agents.md) | 简体中文

本文说明如何选择 Pilot 要采集哪些 AI Coding Agent，以及是否采集敏感消息内容。

## 支持的 Agent ID

这些 ID 用于标识受支持的集成。大多数 ID 可直接用于安装参数、
`agent-control.json` 和 `config.json`；复用采集链路或输出类型不同的情况会在说明中标出。

| Agent | ID | 说明 |
|-------|----|------|
| Claude Code | `claude-code` | Hook 集成。 |
| Codex | `codex` | Hook 集成。 |
| Cursor | `cursor` | Hook 集成。 |
| Cursor CLI | `cursor-cli` | 独立检测并输出为 `cursor-cli`，但复用 Cursor 已安装的 Hook/Input 链路，不会独立部署另一套 Hook；输出内容策略使用 `cursor-cli`。 |
| DeepSeek Harness | `dsh` | 用户级 YAML patch 插件与本地 per-session JSONL 轮询；采集原生 LLM、reasoning、工具、Token 和 TTFT 数据。 |
| Factory Droid | `droid` | 结构化 Hook 唤醒，并采集本地 transcript、settings 和通过版本校验的日志；输出记录使用 `gen_ai.agent.type=droid`。 |
| Hermes Agent | `hermes-agent` | 原生目录插件和本地 session 文件采集；输出记录使用 `gen_ai.agent.type=hermes`。 |
| Kiro CLI | `kiro-cli` | Hook 集成，并延迟采集本地 SQLite/session 数据；源端暂不提供 Token 用量。 |
| MiMo Code | `mimo-code` | 插件注入，采集 LLM、工具和 Token 生命周期事件。 |
| OpenClaw | `openclaw` | 注入插件，支持 OpenClaw 2026.5.12 及以上稳定版本；采集原生 LLM、ReAct、工具、Token、错误和取消事件。 |
| OpenCode | `opencode` | 插件注入。 |
| Pi Coding Agent | `pi-coding-agent` | 注入 Pi Extension，采集 LLM 与工具生命周期事件；OMP 可选启用 [exact Skill telemetry](pi-coding-agent-skill-telemetry.md)。 |
| Qoder | `qoder` | Hook 集成。 |
| Qoder CN | `qoder-cn` | Hook 集成。 |
| Qoder for JetBrains | `qoder-jetbrains` | 部署/检测专用 ID。`agent-control.json` 中采集开关为 `qoder`；`config.json` 中内容策略为 `qoder-idea`。 |
| Qoder CLI | `qoder` | 复用 Qoder Agent 定义，使用 Hook / session 数据源。 |
| Qoder Work | `qoder-work` | Hook 和本地数据源。 |
| Qoder Work CN | `qoder-work-cn` | Hook 和本地数据源。 |
| Qwen Code CLI | `qwen-code-cli` | Hook 集成；Stop 时解析 qwen-code transcript JSONL。 |
| Wukong | `wukong` | 运行时自动发现并通过本地 `wukong-cli` 进行 CLI API 轮询；它不是 `agents.d` 安装选择项。 |
| WorkBuddy | `workbuddy` | 结构化 Hook 和文件变化触发即时采集，本地 transcript 每 30 秒轮询兜底；已在 macOS WorkBuddy Desktop 5.2.6 和 Windows 11 WorkBuddy Desktop 5.3.5.0 验证。 |

Windows 验证使用安装后的 Pilot 产物，在 `PATH` 中没有 Node 的情况下从安装器固定的
`node-bin` 解析 Node，并用真实 WorkBuddy transcript 通过严格 JSONL 校验。

Codex 使用 transcript 作为采集事实源。Pilot 通过轻量的
`SessionStart` 和 `UserPromptSubmit` Hook 发现当前实际生效的
`CODEX_HOME`（包括编排器为单个任务创建的独立目录），并采集该 session
根目录下最近活跃的 rollout 文件。`Stop` 仅作为尽力而为的唤醒信号，
目录发现不依赖它。

## DeepSeek Harness 采集与生命周期

Pilot 通过 `~/.dsh` 目录或 `dsh` 命令检测 DeepSeek Harness。启用
`dsh` 后，Pilot 会在已设置 `DSH_HOME` 时修改 `$DSH_HOME/cordis.patch.yml`，
否则修改 `~/.dsh/cordis.patch.yml`，并在其中追加一个
带 marker 的 Pilot 专属 block，用于加载
`$PILOT_DATA/plugins/dsh/plugin.mjs`；marker 外的用户及第三方内容保持原样。
首次启用或重新安装后，需要启动新的 DSH 进程，使宿主加载当前 patch。

插件将 append-only 原生事件写入
`$PILOT_DATA/logs/dsh/dsh-<session-id>.jsonl`。在 POSIX 系统上，目录权限为
`0700`，文件权限为 `0600`。这些源文件包含归一化所需的原生消息和
工具数据，应当作敏感数据保护；插件在落盘前会过滤类似凭据的 key。
`captureMessageContent` 只控制归一化输出，不会删除这些源日志中的内容。
Pilot 使用原生请求边界到首个 reasoning、text 或 tool-call stream delta
的时间差计算 LLM TTFT，并以纳秒写入
`gen_ai.response.time_to_first_token`。

`agent-control.json` 和 `config.json` 中的采集开关均使用 ID `dsh`。
禁用采集时，Pilot 会先删除 enable marker，使已加载的插件停止写入，
再只删除 Pilot 所属的 YAML block。DSH 保持启用时，运行时 watchdog
会修复该 block。卸载会在删除插件资产之前执行相同的属主清理，并保留
无关 YAML 内容。如果源事件缺少请求边界或输出 delta，Pilot 会省略 TTFT，
不会伪造为 0。

## Factory Droid 采集与回放

Pilot 当前支持的 Droid 契约是 transcript schema v2。live 采集和历史回放
遇到其他 transcript 版本时都会 fail closed；精确日志补充只接受 Droid
`0.199.0` 和 `0.200.0`。这样上游本地格式变化时，不会被静默当成已验证的
schema 解析。

三个本地数据源承担不同职责，信任边界如下：

1. transcript 是 session、turn、LLM、工具调用和可见消息结构的事实源；
   `user_only` 与 `llm_only` 记录不会作为对话内容输出。
2. 同名 session settings 文件用于补充 model/provider，并在无法精确匹配
   单次调用时提供聚合 token 用量兜底。
3. 保留下来的 Droid `0.199.0` 或 `0.200.0` 日志可为唯一匹配的调用补充精确的
   单次 token、request/response 时间、TTFT 和 response ID；匹配有歧义时
   Pilot 不猜测。

因此，日志已被轮转或删除时仍可回放旧 transcript，但只有匹配日志仍在时，
才能保证历史单次调用 token 精确。根据 settings baseline 是否存在，Pilot 会
明确标记 `single_call_delta`、`turn_aggregate`、`session_aggregate` 或
`missing`，不会把聚合值随意归到某一次调用。

Droid Hook 只写结构化唤醒信息，Prompt、工具参数和工具结果仍从源文件读取。
部署时追加 Pilot 条目，卸载时只删除这些条目，用户已有 Hook 会被保留；Hook
延迟或缺失时仍由轮询兜底。该接入也不依赖 Droid 原生 OTLP 输出，而是由
Pilot 根据上述本地源构建 AgentLoop 的 session/turn/step/LLM/tool 拓扑。

如果关闭 Droid 内容采集，Pilot 会移除 Prompt、Completion、工具参数和工具
结果字段；如果开启，这些内容仍固定经过完整的 Pilot `mode=all` 密钥与 PII
脱敏规则，即使全局 masking 配置为 `none` 也不会绕过。

Droid 可选的 exact Skill telemetry 只丰富原生 `Skill` tool call/result，并以成功的
raw tool result 计算 loaded-payload revision。普通 Read、Bash 或路径文本不会归因；
详见 [Factory Droid Skill telemetry](droid-skill-telemetry.md)。

先以只读方式检查完整历史 turn：

```bash
loongsuite-pilot droid replay --session-id <ID> --dry-run
loongsuite-pilot droid replay --from <ISO_TIME> --to <ISO_TIME> --dry-run
```

dry-run 会跳过未结束 turn 和不支持的 transcript，应用相同内容策略及强制
`mode=all` 脱敏，也不会打印 prompt 或 tool 内容。它还会读取
`logs/input-state.json` 生成 strict eligibility 摘要：live 已处理的 transcript
会按整份文件保守排除并计入 `liveProcessedSkipped`；缺失、不完整、pending 或
已变化的 baseline receipt 会计入 `unsafeStateSkipped` 与
`safetySkipReasons`。

`droid replay --execute` 暂时禁用，并会在访问 source、queue 或 ledger 前直接
返回 exit 1。AgentLoop 不会对拥有相同 trace/span ID 的 live span 与 replay span
去重；此外，queue 先远端成功而 ledger 随后写入失败，仍可能再次入队同一份历史
数据。安全启用需要 shared live/replay outbox/receipt，把 source ownership、
durable enqueue 与 replay acknowledgement 进行原子协调。本版本不提供 force
override。

durable queue 在本地接收后提供原子文件写入、fsync、确定性 at-least-once
去重、重启恢复和失败重试。网络错误及 408/429/5xx 保留在 pending，HTTP 400
进入 dead-letter，401/403 会暂停对应 route。这项保证从数据进入
`spool/otlp/v1` 后开始。Droid live 采集只有在所有已配置 durable route 都完成
本地持久化接收后，才提交 source checkpoint 并删除 hook event；本地写入失败时
transcript offset 和 hook 都保持可重试，且重试继续使用相同的确定性 ID。这一
source-to-spool 确认只覆盖 Droid，尚未采用同一契约的既有 input 仍可能保留更早
的 crash window。

以下命令分别用于只读盘点 queue，以及显式触发一次立即发送：

```bash
loongsuite-pilot failed replay --dry-run
loongsuite-pilot failed replay --execute
```

该命令会盘点旧 `logs/otlp-failed` JSONL，但不会自动回放；旧格式缺失
scope、events 和 links，无法做无损迁移。

## OpenClaw 兼容性与生命周期

Pilot 支持 OpenClaw `>=2026.5.12`。插件包会声明这一最低宿主版本，
OpenClaw 在加载插件时使用当前运行版本自行校验；不兼容的宿主会跳过插件并
输出诊断，Pilot 不再通过启动 OpenClaw CLI 获取版本。部署时，Pilot 会把
插件包目录加入 `plugins.load.paths`，并向生效的 OpenClaw 配置加入以下条目：

```json
{
  "plugins": {
    "entries": {
      "loongsuite-pilot-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

原生会话生命周期 Hook 通过 `allowConversationAccess` 提供每次 LLM 调用的
消息和用量，因此该权限是必需的。迁移旧版插件数组配置前，Pilot 会创建
权限受限的备份。升级时会把 Pilot 旧的单文件加载路径替换为插件包目录；
卸载会同时清理新旧两种路径和 Pilot 自己的条目，并保留其他插件及其配置。

注入的插件会把 append-only 源事件写入
`~/.loongsuite-pilot/logs/openclaw/`。在 POSIX 系统上，目录权限为 `0700`，
文件权限为 `0600`。Provider 错误或取消调用可能没有输出消息或 Token 用量；
Pilot 会上报原生 finish reason 和耗时，不会伪造消息或补零 Token。

## 安装时选择 Agent

使用 `--agents` 跳过交互选择：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor,dsh"
```

安装器仍会检查所选 Agent 是否存在于当前机器上，再部署对应采集能力。

## 安装后启停 Agent

使用 `~/.loongsuite-pilot/agent-control.json` 控制准入：

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "dsh": "on",
    "qoder": "off"
  }
}
```

| 模式 | 含义 |
|------|------|
| `on` | 当数据源存在时强制启用该 Agent。 |
| `off` | 禁用该 Agent。 |
| `auto` | 使用默认自动检测行为。 |

修改后重启：

```bash
loongsuite-pilot restart
```

## 按 Agent 配置内容采集

如果需要控制消息内容采集，使用 `config.json`：

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "dsh": { "enabled": true, "captureMessageContent": false },
    "droid": { "enabled": true, "captureMessageContent": false },
    "openclaw": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 设置为 `false` 可从配置层禁用该 Agent。 |
| `captureMessageContent` | 设置为 `false` 可避免采集完整 Prompt、Completion、工具参数和工具结果，前提是对应集成支持该策略。 |
| `multimodal.uploadMode` | 多模态上传策略。`none`（默认）关闭；`input` / `tool` / `output` / `both` 控制转换表面。详见 [多模态采集](multimodal.md)。 |
| `skillTelemetry` | OMP 或 Droid 的 exact Skill activation 采集策略，默认关闭。详见 [Pi Coding Agent / OMP Skill telemetry](pi-coding-agent-skill-telemetry.md) 与 [Factory Droid Skill telemetry](droid-skill-telemetry.md)。 |

敏感环境建议同时设置 `captureMessageContent: false` 和 [数据脱敏](masking.md)。需要提取多模态数据时，见 [多模态采集](multimodal.md)（当前仅图像、仅 `codex` 生效）。
敏感环境建议同时设置 `captureMessageContent: false` 和 [数据脱敏](masking.md)。
Droid 即使开启内容采集，也固定应用完整的 `mode=all` 脱敏规则。

## 验证 Agent 采集

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

如果预期 Agent 没有数据：

- 确认 Agent 已安装且至少使用过一次。
- 确认 `agent-control.json` 中没有设置为 `off`。
- 确认 `config.json` 中没有设置 `"enabled": false`。
- 修改配置后重启 Pilot。
