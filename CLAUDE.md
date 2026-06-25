# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

「囤囤鼠历险记」(grasp-rat) 浏览器游戏的自动化 Bot。通过 WebSocket 连接游戏服务器，自动收集金币、躲避敌人、管理体力。

## 启动方式

```bash
npm install
npm start
```

启动后访问 http://localhost:38473 控制面板。

**使用流程**：
1. 首次使用：在控制面板输入 User ID 和 Token 登录
2. Token 自动保存到 `.token.json`
3. 之后只需点击「上线/下线」按钮控制 Bot

**获取 Token**：
1. 访问 https://grasp-rat-game.h-e.top 并登录
2. 按 F12 打开开发者工具
3. Console 中输入 `localStorage.tmpGameUserId` 和 `localStorage.tmpGameSessionToken`

## 架构

```
index.js          入口：Dashboard + Token 服务器 (38472/38473)
bot.js            核心编排器：生命周期管理、状态轮询、休息恢复
ws-client.js      WebSocket 客户端：连接、压缩解码、自动重连
game-state.js     游戏状态：实体/子弹/金币、体力计算、快照历史
strategies.js     战斗策略：collect/flee/rest 模式切换、杀手追踪
targeting.js      目标选择：评分算法、预判射击、移动方向计算
dashboard.js      Web 控制台：实时状态展示、游戏小地图、登录/上下线
extension/        Chrome 扩展（可选）：从游戏页面读取 Token 发送到本地
```

## 核心数据流

```
Dashboard (38473) → /api/login → index.js → new Bot(userId, token, dashboard)
                                              ↓
                                        bot.start()
                                              ↓
                        ws-client.js ← WebSocket 连接游戏服务器
                              ↓
                        收到消息 → game-state.js 更新状态
                              ↓
                        strategies.js 每 50ms tick() 决策
                              ↓
                        ws-client.js 发送 vel/shoot/tp 指令
```

## 关键常量 (game-state.js CONSTANTS)

- 坐标单位：**厘米** (100cm = 1m)，Dashboard 显示时除以 100
- `SERVER_TICK_MS: 50` — 服务器 tick 间隔
- `BULLET_RANGE_CM: 15000` — 射程 150m
- `BULLET_DAMAGE: 3` — 每发伤害
- `TELEPORT_STAMINA_COST: 1500000` — 传送体力消耗

## 体力系统

三个时间窗口，任一耗尽则进入 rest 模式：
- `stamina_5s` — 短期体力，影响射击 (每发消耗 500ms)
- `stamina_1h` — 小时限额 (3000s)
- `stamina_1d` — 日限额 (20000s)

## 策略逻辑 (strategies.js)

- **collect** — 收集金币，优先去金币密集区域，避开 200m 内有玩家的金币
- **flee** — 200m 危险圈内有敌人时逃跑，300m 内有杀手(击杀2+)时逃跑
- **rest** — 体力耗尽或被攻击后下线休息，蹲守者递增休息时长 (5→10→20 分钟)

## WebSocket 协议

- 二进制消息带 `GRZ1` 头部标识压缩，支持 gzip/inflate/zstd
- 文本消息为 JSON：`snapshot`(全量)、`pos`(增量)、`shoot_failed`、`teleport_ok/failed`
- 发送命令：`vel dx dy`、`shoot tx ty sx sy`、`tp x y`、`chat msg`
