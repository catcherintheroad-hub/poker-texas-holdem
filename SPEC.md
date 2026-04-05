# 德州扑克在线多人游戏 — SPEC.md

## 1. Concept & Vision

一款简洁、流畅的在线德州扑克游戏，8-10名玩家通过房间码加入，手机浏览器直接打开即可玩。核心体验是「快速开局、流畅对战、实时记分」，不需要下载任何东西。

风格参考：深色主题 + 扑克牌美学，简洁不花哨。

## 2. Design Language

- **Aesthetic**: 深色扑克主题，类似高端线上赌场
- **Colors**:
  - Background: `#1a1a2e`
  - Card table felt: `#16213e`
  - Accent gold: `#e6b800`
  - Chip red: `#c0392b`
  - Text: `#ecf0f1`
  - Dealer button: `#f39c12`
- **Typography**: 系统字体栈，移动端清晰
- **Motion**: 快速发牌动画，卡片翻转效果

## 3. Game Rules (Texas Hold'em)

### 牌型大小（从大到小）
1. 皇家同花顺 (Royal Flush)
2. 同花顺 (Straight Flush)
3. 四条 (Four of a Kind)
4. 葫芦 (Full House)
5. 同花 (Flush)
6. 顺子 (Straight)
7. 三条 (Three of a Kind)
8. 两对 (Two Pair)
9. 一对 (One Pair)
10. 高牌 (High Card)

### 下注规则
- **小盲注 (SB)**: 房间创建时设定（如 10 分）
- **大盲注 (BB)**: SB 的两倍
- **加注**: 必须至少是前一个加注的两倍
- **All-in**: 携带全部筹码
- **轮次**: Pre-flop → Flop → Turn → River → Showdown

### 游戏流程
1. 玩家入座，发 2 张底牌
2. Pre-flop 下注
3. 发 Flop（3 张公共牌），下注
4. 发 Turn（1 张），下注
5. 发 River（1 张），下注
6. Showdown 比牌

## 4. Features

### 房间系统
- 创建房间：生成 4 位房间码
- 加入房间：输入房间码加入
- 座位数：2-10 人（默认 10 人桌）
- 房主可开始游戏、踢人

### 计分系统
- 每局记分：赢家赢走底池
- 总积分榜：实时显示所有玩家积分
- 积分初始：每人 1000 分（可配置）
- 破产：0 分玩家出局（可选择观战）

### 操作界面（手机优先）
- 底部操作区：跟注/加注/弃牌/All-in 按钮
- 中央公共牌区
- 四周玩家座位（转盘式布局）
- 自己底牌显示在底部
- 当前下注金额、底池金额清晰显示
- 倒计时（optional）

### 聊天功能
- 房间内文字聊天
- 简单表情系统

## 5. Technical Architecture

### 后端：Next.js API Route WebSocket
- 端点：`/api/poker`（Upgrade WebSocket）
- 状态：内存管理（不持久化，重启重置）
- 房间列表：Map<roomCode, Room>
- 玩家连接：Map<playerId, WebSocket>

### 消息协议（双向 JSON）

**Client → Server:**
```json
{ "type": "create_room", "playerName": "张三", "bigBlind": 10, "maxPlayers": 10 }
{ "type": "join_room", "roomCode": "ABCD", "playerName": "李四" }
{ "type": "action", "action": "call|raise|fold|check|allin" }
{ "type": "start_game" }
{ "type": "chat", "message": "..." }
```

**Server → Client:**
```json
{ "type": "room_created", "roomCode": "ABCD", "playerId": "xxx" }
{ "type": "player_joined", "player": {...} }
{ "type": "game_state", "phase": "preflop", "communityCards": [], "pot": 0, "players": [...] }
{ "type": "action_required", "currentPlayerId": "xxx", "minRaise": 20 }
{ "type": "action_result", "playerId": "xxx", "action": "fold" }
{ "type": "hand_result", "winners": ["xxx"], "handType": "flush", "prize": 100 }
{ "type": "scoreboard", "scores": [{"name": "张三", "score": 1100}, ...] }
{ "type": "chat_message", "from": "李四", "message": "..." }
```

### 数据模型

**Player:**
- id, name, socketId
- hand: [Card, Card] | null
- chips: number
- score: number（累计积分）
- isFolded, isAllIn, isDealer, isSmallBlind, isBigBlind

**Room:**
- code: string (4位)
- players: Player[]
- phase: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
- communityCards: Card[]
- pot: number
- currentBet: number
- dealerIndex: number
- bigBlind: number

## 6. Frontend

- 纯 HTML + Vanilla JS（无框架依赖，手机浏览器直接打开）
- 单文件 `poker.html`
- 可独立部署在任意静态托管（Vercel / GitHub Pages / 直接 file:// 打开）

## 7. 优先级

**Phase 1（本次实现）:**
- 房间创建和加入
- 完整下注流程（跟注/加注/弃牌/过牌/全下）
- 计分系统
- 基本 UI（手机适配）
- 聊天

**Phase 2（后续）:**
- 倒计时
- 托管/旁观模式
- 牌型提示
- 声音效果
