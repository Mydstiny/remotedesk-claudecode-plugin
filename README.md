# RemoteDesk Pi 插件

用手机或平板上的 RemoteDesk 远程使用电脑上的 [Pi 编程代理](https://github.com/earendil-works/pi)。插件通过 Pi 自己的 SDK 运行，用的就是你电脑上已有的 Pi，包括它的登录凭据、模型和对话记录。

- **对话**：可以新建对话，也可以继续电脑上用 Pi 终端或 pi-gui 开过的对话。回复逐字显示，工具步骤、思考过程、上下文用量同步显示。
- **项目**：除了在控制面板里手动添加的项目，pi-gui 的工作区和 Pi 有过对话的文件夹会自动出现。配对时勾选「全部项目」即可访问这些项目。
- **模型**：模型列表就是 Pi 已登录的全部模型，可以切换模型和思考强度。新对话默认用你最近一次在 Pi 里用的模型。
- **权限**：仿 Codex 分三档，默认「只读」。
  - **只读**：Pi 只能使用 read、grep、find、ls，不能运行命令或改文件。
  - **修改前询问**：读文件直接执行；每条命令和每次改文件都先发到手机上，由你批准或拒绝。
  - **完全访问**：不经询问直接执行。
- **其他**：
  - 中途可以插话或取消；
  - 可以压缩上下文、重命名对话、查看工作区 diff；
  - 可以附带图片和文本文件。

插件和 Codex、DSH 插件使用同一套主机桥（`packages/bridge-core`）：双向 TLS 证书配对、只开放授权项目、设备可随时撤销。

## 要求

- Node.js 22.16 或更新版本。
- 已安装 Pi 1.0 或更新版本（`npm i -g @earendil-works/pi-coding-agent`），并至少登录过一个模型提供方：在 Pi 里执行 `/login`，或在 pi-gui 里登录。
- 插件按以下顺序查找 Pi：
  1. 环境变量 `REMOTEDESK_PI_PACKAGE`；
  2. `pi` 命令所在的包；
  3. npm 全局目录。
- 可以用 `PI_CODING_AGENT_DIR` 指定 Pi 的数据目录，默认是 `~/.pi/agent`。

## 常用命令

```sh
node bin/remotedesk-pi.mjs doctor
node bin/remotedesk-pi.mjs probe
node bin/remotedesk-pi.mjs init --state ~/.remotedesk/pi --host 0.0.0.0 --hosts <局域网IP>,localhost --port 9445
node bin/remotedesk-pi.mjs project-add --state ~/.remotedesk/pi --id demo --path ~/code/demo --title Demo
node bin/remotedesk-pi.mjs service --state ~/.remotedesk/pi --action install
node bin/remotedesk-pi.mjs panel --state ~/.remotedesk/pi --port 9545
```

- `doctor` 检查以下几项，不会发起模型调用：
  - Node 版本；
  - Pi 的安装位置和版本；
  - Pi 能用的模型。
- `probe` 还会检查能否读取 Pi 的对话目录。
- 控制面板只监听 `127.0.0.1`，在面板里生成配对二维码。二维码只含精简邀请，手机扫码即可配对。

## 与电脑上的 Pi 同时使用

- pi-gui 或 Pi 终端正打开着某个对话时，手机上只能查看这个对话，不能继续发送（错误码 `PI_SESSION_OPEN_IN_APP`），以免两边同时写同一个对话文件。
- 在电脑上切到别的对话，或在手机上新建对话即可继续。

更多说明：
- [主机桥接口与事件格式](docs/protocol.md)
- [兼容性](docs/compatibility.md)
- [来源](docs/provenance.md)
- [路线图](docs/roadmap.md)
