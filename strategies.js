// strategies.js - 战斗策略

import { CONSTANTS } from './game-state.js';
import { calculateMoveDirection } from './targeting.js';

const DANGER_RADIUS = 15000; // 150m
const CHASE_TIMEOUT_TICKS = 600; // 30秒

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
    // 蹲守记录 { userId: { count, lastTime } }
    this.campers = {};
    // 下线回调
    this.onForceLeave = null;
    this.onHitLeave = null;
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

    // 检测 150m 内敌人 → 逃跑
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

    // 收集金币（避开玩家）
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

    // 收集所有活着的玩家位置（用于避让）
    const dangerPlayers = [];
    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      dangerPlayers.push({ x: Number(p.x), y: Number(p.y) });
    }

    // 找最近的安全金币
    let nearest = null;
    let nearestDist = Infinity;
    for (const coin of this.game.coinDrops) {
      const dist = Math.hypot(coin.x - selfX, coin.y - selfY);

      // 跳过150m内有玩家的金币
      let nearPlayer = false;
      for (const p of dangerPlayers) {
        if (Math.hypot(coin.x - p.x, coin.y - p.y) < DANGER_RADIUS) {
          nearPlayer = true;
          break;
        }
      }
      if (nearPlayer) continue;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = coin;
      }
    }

    if (!nearest) {
      this._executeRoam(self);
      return;
    }

    // 传送冷却5秒，距离超过500m才传送
    const TELEPORT_DIST = 50000;
    const now = Date.now();
    if (nearestDist > TELEPORT_DIST && now - this.lastTeleportAt > 5000) {
      const stamina = this.game.getStaminaInfo(self);
      if (stamina.canTeleport) {
        this.ws.teleport(nearest.x, nearest.y);
        this.lastTeleportAt = now;
        this.log(`[传送] 前往金币 ${Math.round(nearestDist / 100)}m`);
        return;
      }
    }

    const dir = calculateMoveDirection(self, nearest.x, nearest.y);
    this._sendVel(dir.dx || 1, dir.dy || 1);
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
