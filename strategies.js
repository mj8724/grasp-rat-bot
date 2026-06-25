// strategies.js - 战斗策略

import { CONSTANTS } from './game-state.js';
import { calculateMoveDirection } from './targeting.js';

const DANGER_RADIUS = 20000; // 200m - 普通玩家危险距离
const KILLER_DANGER_RADIUS = 30000; // 300m - 杀手危险距离
const CHASE_TIMEOUT_TICKS = 600; // 30秒
const COIN_CLUSTER_RADIUS = 15000; // 150m - 金币聚集判定范围

export class Strategy {
  constructor(gameState, wsClient, log) {
    this.game = gameState;
    this.ws = wsClient;
    this.log = log;
    this.currentVel = { dx: 1, dy: 1 };
    this.lastVelSent = { dx: 0, dy: 0 };
    this.mode = 'collect';
    this.lastHp = 100;
    this.initialized = false;
    this.tickCount = 0;
    this.lastTeleportAt = 0;
    // 逃跑追踪
    this.fleeingSince = 0;
    this.fleeTargetId = null;
    // 蹲守记录 { userId: { count, lastTime, name } }
    this.campers = {};
    // 杀手记录 { userId: { kills, name } }
    this.killers = {};
    // 已处理的消息ID（去重用）
    this.seenMessageIds = new Set();
    // 下线回调
    this.onForceLeave = null;
    this.onHitLeave = null;
  }

  /**
   * 处理游戏消息，记录击杀信息
   */
  processMessages(messages) {
    if (!messages) return;
    const selfName = this.game.getDisplayName(this.game.userId);

    for (const item of messages) {
      // 去重：跳过已处理的消息
      if (item.id && this.seenMessageIds.has(item.id)) continue;
      if (item.id) this.seenMessageIds.add(item.id);

      if (item.kind === 'kill') {
        const text = item.text || '';
        const match = text.match(/^(.+)\s+killed\s+(.+)$/);
        if (match) {
          const killer = match[1].trim();
          const victim = match[2].trim();

          // 记录杀手（排除自己）
          if (killer !== selfName) {
            this._recordKiller(killer);
          }
        }
      }
    }

    // 清理旧消息ID，防止内存泄漏
    if (this.seenMessageIds.size > 500) {
      const arr = [...this.seenMessageIds];
      this.seenMessageIds = new Set(arr.slice(-250));
    }
  }

  /**
   * 记录杀手击杀数
   */
  _recordKiller(name) {
    // 通过名字查找 userId
    let userId = null;
    for (const [id, userName] of this.game.userNames.entries()) {
      if (userName === name) {
        userId = id;
        break;
      }
    }
    if (!userId) return;

    if (!this.killers[userId]) {
      this.killers[userId] = { kills: 0, name };
    }
    this.killers[userId].kills++;
    this.killers[userId].name = name;
    this.log(`[杀手] ${name} 击杀 ${this.killers[userId].kills} 人`);
  }

  /**
   * 检查玩家是否是危险杀手
   */
  _isDangerKiller(userId) {
    const killer = this.killers[userId];
    return killer && killer.kills >= 2;
  }

  tick() {
    const self = this.game.self;
    if (!self) return;

    this.tickCount++;
    const stamina = this.game.getStaminaInfo(self);
    const hp = Number(self.hp || 0);

    // 体力耗尽
    if (stamina.exhausted) {
      this._setMode('rest');
      this._sendVel(0, 0, true);
      this.lastHp = hp;
      return;
    }

    // 首次tick初始化HP
    if (!this.initialized) {
      this.lastHp = hp;
      this.initialized = true;
      return;
    }

    // 被打了 → 找到攻击者
    if (hp < this.lastHp && this.lastHp > 0 && hp > 0) {
      const attacker = this._findAttacker(self);
      const attackerName = attacker ? this.game.getDisplayName(attacker.user_id) : '未知';
      const attackerId = attacker ? Number(attacker.user_id) : 0;

      this.log(`[被攻击] HP: ${this.lastHp} -> ${hp}, 来自: ${attackerName}`);
      this.lastHp = hp;

      // 记录蹲守者
      if (attackerId) {
        this._recordCamper(attackerId, attackerName);
      }

      // 通知 bot 下线（蹲守次数决定休息时长）
      if (this.onHitLeave) {
        const restMs = this._getRestDuration(attackerId);
        this.onHitLeave(attackerName, restMs);
      }
      return;
    }
    this.lastHp = hp;

    // 检测 300m 内危险杀手 → 逃跑
    const killerThreat = this._findKillerThreat(self);
    if (killerThreat) {
      this._setMode('flee');
      this._executeFleeFrom(self, killerThreat);
      const dist = Math.round(Math.hypot(Number(killerThreat.x) - Number(self.x), Number(killerThreat.y) - Number(self.y)) / 100);
      const name = this.game.getDisplayName(killerThreat.user_id);
      const kills = this.killers[Number(killerThreat.user_id)]?.kills || 0;
      this.log(`[逃跑] 杀手 ${name}(${kills}杀) 靠近 ${dist}m`);
      return;
    }

    // 检测 200m 内普通敌人 → 逃跑
    const dangerEnemy = this._findDangerEnemy(self);
    if (dangerEnemy) {
      this._setMode('flee');
      this._executeFleeFrom(self, dangerEnemy);

      // 记录逃跑目标
      if (this.fleeTargetId !== Number(dangerEnemy.user_id)) {
        this.fleeTargetId = Number(dangerEnemy.user_id);
        this.fleeingSince = this.tickCount;
        this.log(`[逃跑] ${this.game.getDisplayName(dangerEnemy.user_id)} 靠近 ${Math.round(Math.hypot(Number(dangerEnemy.x) - Number(self.x), Number(dangerEnemy.y) - Number(self.y)) / 100)}m`);
      }

      // 被追超过30秒 → 下线
      const fleeingTicks = this.tickCount - this.fleeingSince;
      const fleeingSecs = Math.round(fleeingTicks / 20);
      if (fleeingSecs >= 30) {
        const name = this.game.getDisplayName(this.fleeTargetId);
        this.log(`[逃跑] 被 ${name} 追了 ${fleeingSecs} 秒，下线!`);
        if (this.onForceLeave) {
          const restMs = this._getRestDuration(this.fleeTargetId);
          this.onForceLeave(name, restMs);
        }
      }
      return;
    }

    // 没有危险，重置逃跑
    if (this.fleeingSince > 0) {
      this.log('[安全] 危险解除');
      this.fleeingSince = 0;
      this.fleeTargetId = null;
    }

    // 收集金币（避开玩家和杀手）
    this._setMode('collect');
    this._executeCollect(self);

    if (this.tickCount % 3 === 0) {
      this._sendVel(this.currentVel.dx, this.currentVel.dy, true);
    }
  }

  /**
   * 记录蹲守者
   */
  _recordCamper(userId, name) {
    if (!this.campers[userId]) {
      this.campers[userId] = { count: 0, name, lastTime: 0 };
    }
    this.campers[userId].count++;
    this.campers[userId].lastTime = Date.now();
    this.campers[userId].name = name;
    this.log(`[蹲守] ${name} 已攻击 ${this.campers[userId].count} 次`);
  }

  /**
   * 根据蹲守次数决定休息时长
   * 第1次: 5分钟, 第2次: 10分钟, 第3次+: 20分钟
   */
  _getRestDuration(userId) {
    if (!userId || !this.campers[userId]) return 5 * 60 * 1000;
    const count = this.campers[userId].count;
    if (count >= 3) return 20 * 60 * 1000;
    if (count >= 2) return 10 * 60 * 1000;
    return 5 * 60 * 1000;
  }

  /**
   * 找攻击者（HP下降时，找最近的活着的非无敌玩家）
   */
  _findAttacker(self) {
    const selfX = Number(self.x);
    const selfY = Number(self.y);
    let nearest = null;
    let nearestDist = Infinity;

    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      const invUntil = Number(p.invulnerable_until_tick || 0);
      if (invUntil > 0) continue;
      const dist = Math.hypot(Number(p.x) - selfX, Number(p.y) - selfY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = p;
      }
    }
    return nearest;
  }

  /**
   * 查找 300m 内的危险杀手
   */
  _findKillerThreat(self) {
    const selfX = Number(self.x);
    const selfY = Number(self.y);

    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      const invUntil = Number(p.invulnerable_until_tick || 0);
      if (invUntil > 0) continue;

      const userId = Number(p.user_id);
      if (!this._isDangerKiller(userId)) continue;

      const dist = Math.hypot(Number(p.x) - selfX, Number(p.y) - selfY);
      if (dist <= KILLER_DANGER_RADIUS) return p;
    }
    return null;
  }

  /**
   * 查找 200m 内的普通敌人
   */
  _findDangerEnemy(self) {
    const selfX = Number(self.x);
    const selfY = Number(self.y);
    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      const invUntil = Number(p.invulnerable_until_tick || 0);
      if (invUntil > 0) continue;
      const dist = Math.hypot(Number(p.x) - selfX, Number(p.y) - selfY);
      if (dist <= DANGER_RADIUS) return p;
    }
    return null;
  }

  _setMode(mode) {
    if (this.mode !== mode) this.mode = mode;
  }

  _executeFleeFrom(self, enemy) {
    const dir = calculateFleeDirection(self, Number(enemy.x), Number(enemy.y));
    this._sendVel(dir.dx || 1, dir.dy || 1);
  }

  _executeCollect(self) {
    if (!this.game.coinDrops.length) {
      this._executeRoam(self);
      return;
    }

    const selfX = Number(self.x);
    const selfY = Number(self.y);

    // 收集危险区域（普通玩家 200m + 杀手 300m）
    const dangerZones = [];
    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      const userId = Number(p.user_id);
      const radius = this._isDangerKiller(userId) ? KILLER_DANGER_RADIUS : DANGER_RADIUS;
      dangerZones.push({ x: Number(p.x), y: Number(p.y), radius });
    }

    // 找金币密集区域（150m 范围内金币最多的中心点）
    const bestCluster = this._findBestCoinCluster(selfX, selfY, dangerZones);

    if (!bestCluster) {
      this._executeRoam(self);
      return;
    }

    const dist = Math.hypot(bestCluster.x - selfX, bestCluster.y - selfY);

    // 传送冷却5秒，距离超过500m才传送
    const TELEPORT_DIST = 50000;
    const now = Date.now();
    if (dist > TELEPORT_DIST && now - this.lastTeleportAt > 5000) {
      const stamina = this.game.getStaminaInfo(self);
      if (stamina.canTeleport) {
        this.ws.teleport(bestCluster.x, bestCluster.y);
        this.lastTeleportAt = now;
        this.log(`[传送] 前往金币密集区 ${Math.round(dist / 100)}m (${bestCluster.count}个金币)`);
        return;
      }
    }

    const dir = calculateMoveDirection(self, bestCluster.x, bestCluster.y);
    this._sendVel(dir.dx || 1, dir.dy || 1);
  }

  /**
   * 找最佳金币聚集点
   * 优先选择：金币数量多 > 距离近 > 安全
   */
  _findBestCoinCluster(selfX, selfY, dangerZones) {
    const coins = this.game.coinDrops;
    if (!coins.length) return null;

    // 过滤掉危险区域内的金币
    const safeCoins = coins.filter(coin => {
      for (const zone of dangerZones) {
        if (Math.hypot(coin.x - zone.x, coin.y - zone.y) < zone.radius) {
          return false;
        }
      }
      return true;
    });

    if (!safeCoins.length) return null;

    // 计算每个金币附近的聚集数量
    let bestScore = -Infinity;
    let bestCoin = null;

    for (const coin of safeCoins) {
      // 统计 150m 内的金币数量
      let clusterCount = 0;
      for (const other of safeCoins) {
        if (Math.hypot(coin.x - other.x, coin.y - other.y) < COIN_CLUSTER_RADIUS) {
          clusterCount++;
        }
      }

      const dist = Math.hypot(coin.x - selfX, coin.y - selfY);

      // 评分：金币数量权重高，距离权重低
      // 金币数量每个多 10 分，距离每 100m 减 1 分
      const score = clusterCount * 10 - (dist / 100);

      if (score > bestScore) {
        bestScore = score;
        bestCoin = { x: coin.x, y: coin.y, count: clusterCount };
      }
    }

    return bestCoin;
  }

  _executeRoam(self) {
    if (this.currentVel.dx === 0 && this.currentVel.dy === 0) {
      const dx = Math.random() > 0.5 ? 1 : -1;
      const dy = Math.random() > 0.5 ? 1 : -1;
      this._sendVel(dx, dy, true);
    }
  }

  _sendVel(dx, dy, force = false) {
    const changed = dx !== this.lastVelSent.dx || dy !== this.lastVelSent.dy;
    if (changed || force) {
      this.ws.sendVel(dx, dy);
      this.lastVelSent = { dx, dy };
    }
    this.currentVel = { dx, dy };
  }
}

function calculateFleeDirection(self, threatX, threatY) {
  const dx = threatX - Number(self.x);
  const dy = threatY - Number(self.y);
  return { dx: -Math.sign(dx), dy: -Math.sign(dy) };
}
