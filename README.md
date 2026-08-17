# 🎮 博弈小屋 GameHub — DSH 博弈游戏大厅

在 DeepSeek Harness (DSH) 上运行的博弈游戏大厅插件。内置 4 款博弈游戏，支持建房、快速匹配、人机对战、跨会话匹配，房间号可通过任何形式分享。

| 游戏 | 玩法 |
|---|---|
| ✊✋✌️ 石头剪刀布 | 经典博弈 · 三局两胜（人机/双人） |
| ⛓️ 囚徒困境 | 5 回合合作/背叛，累计收益 |
| ⭕❌ 井字棋 | 轮流落子，三连即胜 |
| 🐟 共鱼 | 4 人鱼塘博弈：公共地悲剧 × 囚徒困境 × 最后通牒 |

## 核心能力

- **独立网页界面**：插件运行后浏览器打开 `http://127.0.0.1:<端口>/gamehub` 即进入完整游戏大厅（新建/匹配/加入/对局/分享一体），也可在对话卡片点「独立页面 ↗」
- **联网匹配**：创建房间（4位房间号）、快速匹配、大厅列表、房间号跨会话加入；AI 陪练随时开局
- **任何形式分享**：房间号文本 / 邀请文案 / HTTP 分享链接（浏览器直接看房间状态）/ 大厅 API / 模型工具 `game_hub`（对话中直接建房、落子、发邀请）
- **实例发现**：运行中的实例通过 `/api/gamehub/peers` 暴露在线状态与等待房间（仅公开元数据）
- **门槛低**：无需注册，打开即可玩

## 目录结构

```
.
├── preset/                 # Agent Preset 版（推荐，随 DSH 常驻）
│   ├── agent.cordis.yml    #   preset 组合文件
│   ├── gamehub.plugin.js   #   完整插件（引擎 + 工具 + 只读 HTTP API）
│   └── preset.yml          #   元数据
├── dynamic/                # 动态插件版（旧方式，会话级）
│   └── plugin/
│       ├── gamehub.host.js
│       └── gamehub.client.js
└── prototype/
    └── 共鱼.html           # 共鱼游戏原型（浏览器单机版）
```

## 安装（方式一：Agent Preset，推荐）

把 `preset/` 目录放进 DSH 的 preset 根目录，然后选择"博弈小屋"作为会话 preset：

```bash
# 在 DSH 部署机器上
mkdir -p ~/.dsh/.agent-presets/gamehub
cp preset/agent.cordis.yml preset/gamehub.plugin.js preset/preset.yml ~/.dsh/.agent-presets/gamehub/
```

之后新建会话时选择"博弈小屋" preset，该会话自动拥有 `game_hub` 工具和游戏大厅。

## 安装（方式二：动态插件）

在 DSH 会话中让助手读取 `dynamic/plugin/gamehub.host.js` 和 `gamehub.client.js`，用 `cordis_define` 创建并运行动态插件（code.host / code.client 分别填入两个文件内容）。

## 使用

### 通过对话（任何会话可用）
对助手说："帮我开个共鱼人机房间" / "创建石头剪刀布房间，把邀请发我" —— 助手调用 `game_hub` 工具完成。

### 通过 HTTP（只读）
- 大厅列表：`GET /api/gamehub/lobby`
- 房间状态：`GET /api/gamehub/room?code=XXXX`
- 在线实例：`GET /api/gamehub/peers`

### game_hub 工具操作
| action | 说明 |
|---|---|
| `create` | 创建房间（`game` + 可选 `withBot`） |
| `quick` | 快速匹配（同游戏等待房优先） |
| `join` | 按房间号加入（4位大写字母数字） |
| `list` / `state` / `share` | 列表 / 状态 / 邀请文案 |
| `move` | 落子（rps=rock/paper/scissors；pd=cooperate/defect；ttt=0-8；gongyu 捕鱼=1/2/3、惩罚=skip 或玩家id） |
| `peers` | 查看在线实例与等待房间 |

## 安全设计

> 目标：插件不能成为攻击宿主机器的突破口。

- **HTTP 接口全部只读**（lobby / room / peers），无写操作、无状态修改
- **输入严格校验**：房间号 `^[A-Z0-9]{4}$`、昵称 ≤16 字符并剔除控制字符、playerId 白名单字符集
- **大厅文件路径白名单**：仅写 `/tmp` 下的固定文件名（失败回退到工作区固定子目录），绝不接受用户提供的任意路径
- **实例发现只暴露公开元数据**：短随机实例 id、昵称、等待房间摘要；不暴露文件路径、环境变量、会话信息、IP 细节
- **共享大厅仅限本机**：跨会话匹配基于本机共享文件；跨机器联机需要部署独立的中继/目录服务（不在本插件内实现，避免扩大攻击面）
- **无任意代码执行**：插件不 eval、不加载远程代码、不执行 shell

## 在线实例发现

同一台机器上运行多个 DSH 会话时，各会话的博弈小屋共享同一个大厅文件，可互相匹配。通过 `game_hub` 的 `peers` 操作或 `GET /api/gamehub/peers` 可查看本机在线实例与等待中的房间。

跨机器的实例发现与联机：需要额外的共享目录服务（如 HTTP 中继）作为大厅后端。这是后续可选的扩展方向，设计中已把大厅读写隔离在 `readLobby` / `mutateLobby` 两个函数中，便于替换为远程后端。

## 技术说明

- preset 版插件运行在标准 Cordis 插件环境：工具经 `ctx.tools.register` 注册（output schema 为标准 JSON Schema，不支持动态插件的 `{type:'json'}` 写法）
- 大厅状态保存在 `/tmp/dsh-gamehub-lobby.json`（跨会话共享），通过 rev 乐观锁防并发覆盖
- AI 人格：石头剪刀布随机 / 囚徒困境"以牙还牙" / 井字棋最优防守 / 共鱼四性格（老好人·贪婪鬼·记仇鬼·疯鱼）

## 许可

MIT License
