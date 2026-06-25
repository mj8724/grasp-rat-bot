// bot.js - 核心 Bot 逻辑

import { GameState, CONSTANTS } from './game-state.js';
import { WSClient } from './ws-client.js';
import { Strategy } from './strategies.js';
import { Dashboard } from './dashboard.js';
import https from 'https';

export class Bot {
  constructor(userId, token) {
    this.userId = Number(userId);
    this.token = token;
    this.game = new GameState();
    this.game.userId = this.userId;
    this.ws = null;
    this.strategy = null;
    this.tickTimer = null;
    this.statsTimer = null;
    this.killCount = 0;
    this.deathCount = 0;
    this.seenMessageIds = new Set();
    this.dashboard = new Dashboard(38473);
    this.resting = false;
    this.restUntil = 0;
    this.restCheckTimer = null;
    this.leftGame = false;
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${msg}`);
  }

  async start() {
    this.log(`Bot starting for user ${this.userId}...`);

    // 设置 Dashboard 回调
    this.dashboard.onLeave = () => {
      this.log('[手动] 用户点击离开');
      this._startRest('手动离开', 5 * 60 * 1000);
    };
    this.dashboard.gameStateGetter = () => this._getGameState();
    this.dashboard.start();

    // 先通过 HTTP 检查体力，如果耗尽直接下线
    const staminaOk = await this._checkStaminaBeforeConnect();
    if (!staminaOk) {
      this.log('[启动] 体力已耗尽，执行下线...');
      this._leaveGame();
      this._startRestFromSnapshot();
      return;
    }

    this._connectAndPlay();
  }

  _getGameState() {
    const self = this.game.self;
    if (!self) return { self: null, players: [], coins: [], bullets: [] };

    const selfX = Number(self.x);
    const selfY = Number(self.y);

    return {
      self: { x: selfX, y: selfY, hp: self.hp, max_hp: self.max_hp },
      players: this.game.otherPlayers
        .filter(p => p.life !== 'Dead' && p.hp > 0)
        .map(p => ({
          x: Number(p.x), y: Number(p.y),
          name: this.game.getDisplayName(p.user_id),
          hp: p.hp, max_hp: p.max_hp,
        })),
      coins: this.game.coinDrops.map(c => ({ x: c.x, y: c.y, amount: c.amount || 1 })),
      bullets: this.game.bullets.slice(0, 50).map(b => ({
        x: b.start_x, y: b.start_y,
        dir_x: (b.dir_x_micros || 0) / 1000000,
        dir_y: (b.dir_y_micros || 0) / 1000000,
      })),
    };
  }

  async _checkStaminaBeforeConnect() {
    try {
      this.log('[检查] 正在检查体力状态...');
      const data = await this._fetchSnapshot();
      if (!data || !data.entities) {
        this.log('[检查] 无法获取快照，直接连接');
        return true;
      }

      const selfEntity = data.entities.find(e => Number(e.user_id) === this.userId);
      if (!selfEntity) {
        this.log('[检查] 未找到自身实体，可能已离线，直接连接');
        return true;
      }

      const s1h = selfEntity.stamina_1h_remaining_milli || 0;
      const s1d = selfEntity.stamina_1d_remaining_milli || 0;
      const s1hMax = selfEntity.stamina_1h_limit_milli || 3000000;
      const s1dMax = selfEntity.stamina_1d_limit_milli || 20000000;

      this.log(`[检查] 体力: 1h=${Math.floor(s1h/1000)}/${Math.floor(s1hMax/1000)} 1d=${Math.floor(s1d/1000)}/${Math.floor(s1dMax/1000)}`);

      if (s1h < 1000) {
        this.log('[检查] ❌ 1h 体力已耗尽!');
        this.restReason = '1h';
        this.restDurationMs = 60 * 60 * 1000;
        return false;
      }
      if (s1d < 1000) {
        this.log('[检查] ❌ 1d 体力已耗尽!');
        this.restReason = '1d';
        this.restDurationMs = 24 * 60 * 60 * 1000;
        return false;
      }

      this.log('[检查] ✅ 体力充足，开始游戏');
      return true;
    } catch (err) {
      this.log(`[检查] 检查失败: ${err.message}，直接连接`);
      return true;
    }
  }

  _startRestFromSnapshot() {
    const reason = this.restReason || '未知';
    const durationMs = this.restDurationMs || 60 * 60 * 1000;
    this._startRest(reason, durationMs);
  }

  _connectAndPlay() {
    this.resting = false;
    this.leftGame = false;

    this.ws = new WSClient(
      this.userId,
      this.token,
      (msg) => this._handleMessage(msg),
      (status) => {
        this.log(`[WS] ${status}`);
        this._updateDashboard();
      }
    );

    this.strategy = new Strategy(this.game, this.ws, (msg) => this.log(msg));
    // 被打了 → 下线（蹲守者休息更久）
    this.strategy.onHitLeave = (attackerName, restMs) => {
      const mins = Math.round(restMs / 60000);
      this.log(`[被攻击] 被 ${attackerName} 攻击，休息 ${mins} 分钟...`);
      this._startRest(`被${attackerName}攻击`, restMs);
    };
    // 被追超过30秒 → 下线
    this.strategy.onForceLeave = (chaserName, restMs) => {
      const mins = Math.round(restMs / 60000);
      this.log(`[紧急] 被 ${chaserName} 追杀超过30秒，休息 ${mins} 分钟...`);
      this._startRest(`被${chaserName}追杀`, restMs);
    };
    this.ws.connect();

    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.resting) this.strategy.tick();
    }, CONSTANTS.SERVER_TICK_MS);

    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
      this._printStats();
      this._updateDashboard();
      this._checkStaminaLimit();
    }, 2000);
  }

  stop() {
    this.log('Bot stopping...');
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.restCheckTimer) clearTimeout(this.restCheckTimer);
    if (this.ws) this.ws.disconnect();
    this.dashboard.stop();
  }

  _checkStaminaLimit() {
    if (this.resting) return;
    const self = this.game.self;
    if (!self) return;

    const s1h = self.stamina_1h_remaining_milli || 0;
    const s1d = self.stamina_1d_remaining_milli || 0;

    // 1h 体力耗尽
    if (s1h < 1000) {
      this._startRest('1h', 60 * 60 * 1000);
      return;
    }

    // 1d 体力耗尽
    if (s1d < 1000) {
      this._startRest('1d', 24 * 60 * 60 * 1000);
      return;
    }
  }

  async _startRest(reason, durationMs) {
    this.resting = true;
    this.restUntil = Date.now() + durationMs;

    const resumeTime = new Date(this.restUntil).toLocaleTimeString();
    this.log(`[休息] ${reason} 体力耗尽，下线休息`);
    this.log(`[休息] 预计 ${resumeTime} 恢复 (${Math.round(durationMs / 60000)} 分钟后)`);

    // 停止游戏循环
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);

    // 调用游戏的离开 API (点击"离开"按钮)
    this._leaveGame();

    // 断开 WebSocket
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }

    // 更新控制面板
    this.dashboard.update({
      ...this.dashboard.state,
      mode: 'rest',
      wsStatus: `休息中 - ${resumeTime} 恢复`,
      restRemaining: Math.round(durationMs / 60000),
    });

    // 设置定时恢复 - 每5分钟检查一次体力是否恢复
    this._startRestCheck(durationMs);
  }

  _startRestCheck(totalDurationMs) {
    const checkInterval = 5 * 60 * 1000; // 每5分钟检查一次
    const startTime = Date.now();

    const check = () => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.round((this.restUntil - Date.now()) / 60000));

      // 更新控制面板剩余时间
      this.dashboard.update({
        ...this.dashboard.state,
        mode: 'rest',
        wsStatus: `休息中 - ${remaining}分钟后恢复`,
        restRemaining: remaining,
      });

      this.log(`[休息] 体力恢复中... 剩余 ${remaining} 分钟`);

      // 时间到了，尝试重新连接
      if (Date.now() >= this.restUntil) {
        this.log('[休息] 等待时间结束，检查体力并重新连接...');
        this._tryResume();
        return;
      }

      // 继续等待
      this.restCheckTimer = setTimeout(check, checkInterval);
    };

    // 首次5分钟后开始检查
    this.restCheckTimer = setTimeout(check, Math.min(checkInterval, totalDurationMs));
  }

  async _tryResume() {
    // 先通过 HTTP snapshot 检查体力
    try {
      const snapshotData = await this._fetchSnapshot();
      if (snapshotData) {
        const selfEntity = snapshotData.entities?.find(e => Number(e.user_id) === this.userId);
        if (selfEntity) {
          const s1h = selfEntity.stamina_1h_remaining_milli || 0;
          const s1d = selfEntity.stamina_1d_remaining_milli || 0;

          if (s1h < 1000 || s1d < 1000) {
            this.log(`[休息] 体力尚未完全恢复 (1h:${Math.floor(s1h/1000)} 1d:${Math.floor(s1d/1000)})，继续等待...`);
            this.restCheckTimer = setTimeout(() => this._tryResume(), 5 * 60 * 1000);
            return;
          }
        }
      }
    } catch (err) {
      this.log(`[休息] 检查体力失败: ${err.message}，尝试直接连接`);
    }

    this.log('[休息] 体力已恢复，重新上线!');
    this._connectAndPlay();
  }

  _fetchSnapshot() {
    return new Promise((resolve, reject) => {
      const url = `https://grasp-rat-game.h-e.top/snapshot?user_id=${this.userId}&token=${encodeURIComponent(this.token)}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON'));
          }
        });
      }).on('error', reject);
    });
  }

  _leaveGame() {
    if (this.leftGame) return;
    this.leftGame = true;

    const leaveUrl = `https://grasp-rat-game.h-e.top/leave?user_id=${this.userId}&token=${encodeURIComponent(this.token)}`;
    https.get(leaveUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          this.log(`[离开] 游戏内退出: ${json.ok ? '成功' : '失败'}`);
        } catch {
          this.log(`[离开] 响应: ${data}`);
        }
      });
    }).on('error', (err) => {
      this.log(`[离开] API 调用失败: ${err.message}`);
    });
  }

  _handleMessage(msg) {
    if (msg.type === 'snapshot') {
      this.game.applySnapshot(msg);
      this._processMessages(msg.messages);
    } else if (msg.type === 'pos') {
      this.game.applyPositionUpdate(msg);
    } else if (msg.type === 'shoot_failed') {
      this.log('[射击] 失败');
    } else if (msg.type === 'teleport_ok') {
      this.log(`[传送] 成功 -> ${msg.x}, ${msg.y}`);
    } else if (msg.type === 'teleport_failed') {
      this.log(`[传送] 失败: ${msg.error}`);
    }
  }

  _processMessages(messages) {
    if (!messages) return;
    const selfName = this.game.getDisplayName(this.userId);
    for (const item of messages) {
      if (item.id && this.seenMessageIds.has(item.id)) continue;
      if (item.id) this.seenMessageIds.add(item.id);

      if (item.kind === 'kill') {
        const text = item.text || '';
        const match = text.match(/^(.+)\s+killed\s+(.+)$/);
        if (match) {
          const killer = match[1].trim();
          const victim = match[2].trim();
          if (victim === selfName) {
            this.deathCount++;
            this.log(`[死亡] ${text} (总计: ${this.deathCount})`);
          } else if (killer === selfName) {
            this.killCount++;
            this.log(`[击杀] ${text} (总计: ${this.killCount})`);
          }
        }
      }
    }
    if (this.seenMessageIds.size > 500) {
      const arr = [...this.seenMessageIds];
      this.seenMessageIds = new Set(arr.slice(-250));
    }
  }

  _updateDashboard() {
    const self = this.game.self;
    const stamina = self ? this.game.getStaminaInfo(self) : null;

    let nearestCoinDist = null;
    let totalCoinValue = 0;
    if (self && this.game.coinDrops.length > 0) {
      const selfX = Number(self.x);
      const selfY = Number(self.y);
      let minDist = Infinity;

      for (const coin of this.game.coinDrops) {
        const dist = Math.hypot(coin.x - selfX, coin.y - selfY);
        if (dist < minDist) minDist = dist;
        totalCoinValue += coin.amount || 1;
      }
      nearestCoinDist = Math.round(minDist / 100);
    }

    let restRemaining = null;
    if (this.resting) {
      restRemaining = Math.max(0, Math.round((this.restUntil - Date.now()) / 60000));
    }

    this.dashboard.update({
      hp: self ? self.hp : null,
      maxHp: self ? self.max_hp : 100,
      stamina: stamina ? Math.floor(stamina.s5s / 1000) : null,
      stamina1h: stamina ? Math.floor(stamina.s1h / 1000) : null,
      stamina1d: stamina ? Math.floor(stamina.s1d / 1000) : null,
      x: self ? Math.round(self.x / 100) : null,
      y: self ? Math.round(self.y / 100) : null,
      players: this.game.otherPlayers.length,
      coins: this.game.coinDrops.length,
      nearestCoinDist: nearestCoinDist,
      totalCoinValue: totalCoinValue,
      kills: this.killCount,
      deaths: this.deathCount,
      mode: this.resting ? 'rest' : (this.strategy ? this.strategy.mode : '-'),
      wsStatus: this.resting
        ? `休息中 - ${restRemaining}分钟后恢复`
        : (this.ws ? (this.ws.connected ? 'ws online' : 'ws offline') : 'no ws'),
      restRemaining: restRemaining,
    });
  }

  _printStats() {
    if (this.resting) {
      const remain = Math.max(0, Math.round((this.restUntil - Date.now()) / 60000));
      this.log(`[休息] 体力恢复中... 剩余 ${remain} 分钟 | 击杀: ${this.killCount} | 死亡: ${this.deathCount}`);
      return;
    }

    const self = this.game.self;
    if (!self) {
      this.log(`[状态] 等待同步... | 击杀: ${this.killCount} | 死亡: ${this.deathCount}`);
      return;
    }

    const hp = self.hp || 0;
    const maxHp = self.max_hp || 100;
    const stamina = this.game.getStaminaInfo(self);
    const x = Math.round((self.x || 0) / 100);
    const y = Math.round((self.y || 0) / 100);
    const players = this.game.otherPlayers.length;
    const coins = this.game.coinDrops.length;
    const mode = this.strategy ? this.strategy.mode : '-';
    const s1h = Math.floor((self.stamina_1h_remaining_milli || 0) / 1000);
    const s1d = Math.floor((self.stamina_1d_remaining_milli || 0) / 1000);

    this.log(
      `[状态] HP: ${hp}/${maxHp} | STA: ${Math.floor(stamina.s5s / 1000)}/10 1h:${s1h}/3000 1d:${s1d}/20000 | ` +
      `位置: ${x}m,${y}m | 附近玩家: ${players} | 金币: ${coins} | ` +
      `模式: ${mode} | 击杀: ${this.killCount} | 死亡: ${this.deathCount}`
    );
  }
}
