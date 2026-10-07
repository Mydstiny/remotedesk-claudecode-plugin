# Pi 主机桥：接口与事件格式

Pi 插件实现 RemoteDesk 主机桥协议 1（与 Codex、DSH 插件相同的 `packages/bridge-core`）。本文说明 Pi 适配器（`src/pi-adapter.mjs`）对这套协议的具体实现，供 App 端和后续维护参考。

## 能力声明（handshake → `capabilities`）

| 字段 | 值 | 说明 |
|---|---|---|
| `permissionModes` | `read-only`、`ask`、`full-access` | 仿 Codex 三档，新会话默认 `read-only` |
| `approvals` | `true` | `ask` 模式下，命令和文件修改都发审批 |
| `questions` | `false` | Pi 没有向用户提问的工具 |
| `approvalDecisions` | `accept`、`decline`、`cancel` | `cancel` 会拒绝这一步并结束本轮 |
| `steer` / `cancel` / `compact` / `rename` | `true` | |
| `fork` | `false` | |
| `attachments` | `text/plain`、`image/png`、`image/jpeg` | 文本附件并入提示词；图片作为图像输入 |
| `nativeSessions` / `appProjects` | `true` | 列出电脑上 Pi 的对话和项目 |
| `extensions` | `false` | 不加载用户或项目的 Pi 扩展（它们会执行任意代码、添加手机无法审核的工具） |

## 权限模式

| 模式 | 提供给模型的工具 | 执行前 |
|---|---|---|
| `read-only` | read、grep、find、ls | 只读工具直接执行；其他调用一律拦截 |
| `ask` | read、grep、find、ls、bash、edit、write | 只读工具直接执行；bash 发 `command` 审批，edit/write 发 `fileChange` 审批 |
| `full-access` | 同上 | 全部直接执行 |

- 拦截由内联扩展在 Pi 的 `tool_call` 钩子里完成，被拦截的调用会以失败的工具结果返回给模型，并附上原因。
- 会话运行中切换模式，下一次请求就会生效。

### 审批请求（`approval.request` 事件里的 `request`）

```json
{ "kind": "command", "engine": "pi", "tool": "Bash", "command": "npm test", "cwd": "/path/project",
  "input": { "command": "npm test" }, "toolUseID": "…", "grantScope": "once" }
{ "kind": "fileChange", "engine": "pi", "tool": "Edit", "cwd": "/path/project", "nativeItemComplete": true,
  "input": { "file_path": "src/a.ts", "old_string": "…", "new_string": "…" }, "toolUseID": "…", "grantScope": "once" }
```

- `tool` 的取值：`Edit`、`MultiEdit`（多处替换，`input.edits[]`）、`Write`（`input.content`）。
- 应答格式：`{ "decision": "accept" | "decline" | "cancel" }`，由 bridge-core 的 `validateNativeAnswer` 校验。

## 会话

- **会话与 Pi 对话一一对应**：`upstream` 是 Pi 的 session id，`piFile` 是 Pi 的 JSONL 文件。
- **新会话**：
  - 在项目目录创建 Pi 对话，标题写入 Pi（`session_info`），在 pi-gui 里也能看到；
  - 模型按以下顺序选择：
    1. 手机上选择的模型；
    2. Pi 设置里的默认模型；
    3. 用户最近一次对话用的模型。
- **列出电脑上的对话**（`nativeSessions`）：
  - 按项目目录读取 Pi 的对话（`SessionManager.list`），去掉空对话，最新的在前；
  - 标题取对话名，没有就取首条消息的第一行。
- **App 项目**（`nativeProjects`）：
  - 来源有两个：pi-gui 的工作区（`catalogs.json`），以及所有有过 Pi 对话的文件夹；
  - 项目 key 为 `pi:<路径>`。
- **与电脑同时使用**：如果另一个 Pi 界面（pi-gui、终端）对该对话文件持有活跃租约（`<file>.lease` 指向本机仍在运行的进程），发送、压缩、重命名都会返回 `PI_SESSION_OPEN_IN_APP`；查看不受影响。

## `session.read` 快照

```json
{ "upstream": "…", "model": "openai-codex/gpt-6-luna", "reasoningEffort": "medium", "permissionMode": "read-only",
  "status": "idle | running", "events": [ … ], "nextCursor": "200",
  "inputModalities": ["text", "image"],
  "nativeState": { "tokenUsage": { "last": { "totalTokens": 2551 }, "modelContextWindow": 272000 } } }
```

`events` 每页 200 条，按 `nextCursor` 翻页，直到返回空字符串。会话没有在主机上打开时，事件从 Pi 的对话文件（当前分支）生成；打开后，是文件历史加上实时事件。

## 事件（实时流和历史相同）

| 事件 | `data` | 说明 |
|---|---|---|
| `turn/start` | `{ id }` | 新一轮开始，`id` 与 `turn.start` 返回的 `turnId` 相同 |
| `user/message` | `{ message: { role, content: [text \| image \| tool_result] } }` | 用户消息；工具结果也以 `tool_result` 块放在这里，内容超过 16000 字符会截断 |
| `assistant/chunk` | `{ chunk: { text } }` | 回复文字增量，约每 120 毫秒合并一次 |
| `assistant/message` | 实时为 `{ message: string, kind: "text" \| "thinking" }`；历史为 `{ message: { content: [text \| thinking \| tool_use] }, usage }` | 完整回复，会替换此前的增量 |
| `tool/call` | `{ id, name, input }` | 工具名换成 App 已能识别的名字（见下表） |
| `tokenUsage` | `{ tokenUsage: { last: { totalTokens, inputTokens, outputTokens }, modelContextWindow } }` | 每次回复后的上下文用量 |
| `session/compacted` | `{ reason, tokensBefore }` | 上下文已压缩 |
| `session/status` | `{ status: "retrying", attempt, maxAttempts }` | Pi 自动重试 |
| `turn/end` | `{ status: completed \| failed \| interrupted, result }` | 失败时 `result` 为错误信息 |
| `execution.idle` | `{ status }` | 每轮结束都会发出，主机桥借此释放项目锁 |

工具名和参数映射：

| Pi | App 显示 | 参数 |
|---|---|---|
| read | Read | `path` → `file_path` |
| bash | Bash | `command` |
| edit | Edit / MultiEdit | `path` → `file_path`；`edits[].oldText/newText` → `old_string/new_string` |
| write | Write | `path` → `file_path`；`content` |
| grep | Grep | 原样 |
| find | Glob | 原样 |
| ls | LS | 原样 |

## 模型列表（`model.list`）

- 列出 Pi 当前能用的全部模型（`ModelRuntime.getAvailable()`），`id` 为 `provider/model`。
- 每个模型都有 `supportedReasoningEfforts`，取值为 Pi 的思考等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- 每个模型还带有 `contextWindow` 和 `isDefault`。
- 每次请求都会重新读取凭据，所以在 Pi 里新登录的提供方不用重启服务。

## 错误码

| 错误码 | 含义 |
|---|---|
| `PI_NOT_INSTALLED` | 找不到 Pi |
| `PI_INITIALIZATION_FAILED` | Pi 会话启动失败 |
| `PI_SESSION_NOT_FOUND` | 找不到对应的 Pi 对话文件 |
| `PI_SESSION_OPEN_IN_APP` | 这个对话正在电脑上的 Pi 里打开 |
| `MODEL_UNAVAILABLE` | Pi 没有这个模型，或没有登录它的提供方 |
| `TURN_ALREADY_RUNNING` | 上一轮还在运行 |
| `NO_ACTIVE_TURN` | 没有正在运行的一轮，无法插话 |
| `TURN_NOT_QUIESCENT` | 有一轮正在运行，不能改设置 |
