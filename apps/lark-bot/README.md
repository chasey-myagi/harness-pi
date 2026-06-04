# @harness-pi/lark-bot

跑在 harness-pi 内核上的飞书（Lark）个人助手 bot —— Chasey「Agent OS」的对话门面。

- **大脑**：`deepseek-v4-flash`（经 `@earendil-works/pi-ai`）
- **入口**：`lark-cli event consume im.message.receive_v1`（长连接，无需公网 endpoint）
- **工具**：`lark_cli`（lark-cli 全家桶，家族白名单 + 破坏性拦截，**双身份**：默认 `user` 代表主人读自己的数据，`bot` 以助手名义行事）、`lark_send_message`、`remember`（自生长记忆）
- **出口**：agent 最终文本 → `lark-cli im +messages-reply`

## 设计理念

- **瘦人设**：system prompt 只定义"我是谁、什么性格"，**不写死** "数据在哪 / 命令怎么拼 / 失败怎么办"。
- **发现优先**：不熟的事 bot 自己用 lark-cli 探查（搜文档、列日程…），而非靠人喂地图。
- **自沉淀**：探到的资源位置 / 有效命令 / 主人偏好，bot 用 `remember` 写进 `memory.md`，每轮注入回 prompt——**越用越懂主人**。短期对话历史易失（内存），长期知识持久（memory.md）。

## 架构

```
飞书 IM 消息
  │  lark-cli event consume im.message.receive_v1   (NDJSON 长连接, daemon)
  ▼
LarkBot (supervisor)
  ├─ 去重(event_id) · 锁主人(ownerOpenId) · 按 chat 串行 · 每 chat 一条 AgentSession(内存多轮历史, LRU)
  ▼
AgentSession.run(text)              [harness-pi kernel]
  ├─ deepseek-v4-flash              [pi-ai]
  ├─ system prompt = 瘦人设 + memory.md(每轮 transformSystemPromptBeforeLlm 注入)
  ├─ tools: lark_cli(user/bot) · lark_send_message · remember
  └─ plugins: trimHistory · emptyRunGuard · repeatedCallGuard
  │           + (telemetry) sessionLog · metrics · costTracker · toolStats
  ▼
最终文本 → lark-cli im +messages-reply   (幂等键 = event_id)
```

## 身份与安全

- **双身份**：`lark_cli` 工具默认 `user`（代表主人读他自己的消息/文档/日历/邮件/任务/多维表），`bot` 仅用于"以助手名义发消息"。事件消费 + 回复用 `bot`（机器人是对话里的实体）。
- **锁主人（重要）**：`user` 身份会以主人名义操作其私有数据，所以设 `LARK_BOT_OWNER_OPEN_ID` 后只响应主人本人，别人 DM 一律忽略。自用可留空。
- **本地 vs 服务器**：本地 `--as user` 直接用本机已登录的用户 OAuth。**服务器常驻**需自行解决 user OAuth token 的刷新（refresh token 周期过期）——这是上服务器前要补的一环。

## v1 范围与限制

- **只回私聊（p2p）**。群消息默认不响应（`LARK_BOT_GROUPS=true` 可开，但 v1 无 @ 提及判定，慎用）。
- **只处理文本/富文本（text/post）**；其它类型回一句「暂只支持文本」。
- **对话历史不持久**：per-chat 多轮历史在内存里，daemon 重启即失（只有 `memory.md` 沉淀跨重启存活）。要不断片需挂 `JsonlSessionStore`（未做）。
- **上下文管理仅 trim**：`trimHistory(keepRecent:16)` 滑窗，无摘要压缩——超长对话会丢早期上下文。要保前情可加 `compactSummarize`（未做）。

## 运行

前置：
1. `pnpm install && pnpm --filter @harness-pi/lark-bot build`（或 `pnpm start` 用 tsx 直接跑）。
2. 环境变量 `DEEPSEEK_API_KEY`（见 `.env.example`）。
3. `lark-cli` 在 PATH：**bot 身份已就绪**（`lark-cli auth status` 里 `identities.bot.status == ready`）；要用 `user` 身份工具则 **user 身份也需就绪**。
4. 设 `LARK_BOT_OWNER_OPEN_ID`（主人 open_id，`auth status` 里 `identities.user.openId`）——`user` 身份下务必锁主人。
5. **飞书开发者后台**：事件订阅方式设为「长连接」，订阅 `im.message.receive_v1`，并开启机器人「接收消息」能力。

```bash
# 开发（tsx）
DEEPSEEK_API_KEY=... pnpm --filter @harness-pi/lark-bot start
# 生产（build 后）
node apps/lark-bot/dist/index.js
```

配置全部走环境变量，见 [`.env.example`](./.env.example)。

## 部署到 rune-sgp（systemd）

```ini
# /etc/systemd/system/lark-bot.service
[Unit]
Description=harness-pi lark-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lark-bot
ExecStart=/usr/bin/node /opt/lark-bot/dist/index.js
EnvironmentFile=/opt/lark-bot/.env
Restart=always
RestartSec=3
# 1GB 小机器：限制内存，OOM 时由 Restart 拉起
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lark-bot
journalctl -u lark-bot -f
```

> 1GB 无 swap 的机器先加 swap，再上常驻进程。
