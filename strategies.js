// strategies.js - 战斗策略

import { CONSTANTS } from './game-state.js';
import { calculateMoveDirection } from './targeting.js';

const DANGER_RADIUS = 20000; // 200m - 普通玩家危险距离
const KILLER_DANGER_RADIUS = 30000; // 300m - 杀手危险距离
const LOW_HP_THRESHOLD = 50;
const SAFE_KILLER_DISTANCE = 50000; // 500m - 低血时与杀手保持的距离
const CHASE_TIMEOUT_TICKS = 600; // 30秒
const COIN_CLUSTER_RADIUS = 15000; // 150m - 金币聚集判定范围
const TELEPORT_COOLDOWN_MS = 5000;

export class Strategy {
  constructor(gameState, wsClient, log, store = null) {
    this.game = gameState;
    this.ws = wsClient;
    this.log = log;
    this.store = store;
    this.currentVel = { dx: 1, dy: 1 };
    this.lastVelSent = { dx: 0, dy: 0 };
    this.mode = 'collect';
    this.lastHp = 100;
    this.initialized = false;
    this.tickCount = 0;
    this.lastTeleportAt = 0;
    this.survivalStartedAt = 0;
    this.survivalThreatId = null;
    this.lastSurvivalLogAt = 0;
    // 逃跑追踪
    this.fleeingSince = 0;
    this.fleeTargetId = null;
    // 蹲守记录 { userId: { count, lastTime, name } }
    this.campers = this.store ? this.store.loadCampers() : {};
    // 杀手记录 { name: { kills, name, lastTime } }
    this.killers = this.store ? this.store.loadKillers() : {};
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
            this._recordKiller(killer, victim);
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
   * 记录杀手击杀数（直接用名字作 key，不依赖 userNames 映射）
   */
  _recordKiller(name, victim = '') {
    if (!name) return null;
    if (this.store) {
      this.killers[name] = this.store.recordKiller(name, victim) || this.killers[name];
      this.log(`[杀手] ${name} 击杀 ${this.killers[name].kills} 人`);
      return this.killers[name];
    }

    if (!this.killers[name]) {
      this.killers[name] = { kills: 0, name, lastTime: 0 };
    }
    this.killers[name].kills++;
    this.killers[name].lastTime = Date.now();
    this.log(`[杀手] ${name} 击杀 ${this.killers[name].kills} 人`);
  }

  /**
   * 检查玩家是否是危险杀手（通过名字匹配）
   */
  _isDangerKiller(userId) {
    const name = this.game.getDisplayName(userId);
    const killer = this.killers[name];
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
      const camper = this._recordCamper(attackerId, attackerName, self);
      if (camper && camper.count > 1 && this.onHitLeave) {
        const restMs = this._getRestDuration(attackerId);
        this.onHitLeave(attackerName, restMs);
        return;
      }
    }

      this._startSurvival(attackerId);
      if (hp < LOW_HP_THRESHOLD) {
        this._executeSurvival(self, hp, stamina);
      }
      return;
    }
    this.lastHp = hp;

    if (this.mode === 'survive' || hp < LOW_HP_THRESHOLD) {
      if (this._canResumeCollect(self, hp)) {
        this.log('[保命] HP 已恢复且杀手距离安全，恢复采集');
        this.survivalStartedAt = 0;
        this.survivalThreatId = null;
      } else {
        this._executeSurvival(self, hp, stamina);
        return;
      }
    }

    // 检测 300m 内危险杀手 → 逃跑
    const killerThreat = this._findKillerThreat(self);
    if (killerThreat) {
      this._setMode('flee');
      this._executeFleeFrom(self, killerThreat);
      const dist = Math.round(Math.hypot(Number(killerThreat.x) - Number(self.x), Number(killerThreat.y) - Number(self.y)) / 100);
      const name = this.game.getDisplayName(killerThreat.user_id);
      const kills = this.killers[name]?.kills || 0;
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
  _recordCamper(userId, name, self = null) {
    if (this.store) {
      const record = this.store.recordCamper(userId, name, this._buildThreatContext(self));
      this.campers[userId] = record;
      this.log(`[蹲守] ${name} 已攻击 ${record.count} 次，下次休息 ${Math.round(record.restMs / 60000)} 分钟`);
      return record;
    }

    if (!this.campers[userId]) {
      this.campers[userId] = { count: 0, name, lastTime: 0 };
    }
    this.campers[userId].count++;
    this.campers[userId].lastTime = Date.now();
    this.campers[userId].name = name;
    this.log(`[蹲守] ${name} 已攻击 ${this.campers[userId].count} 次`);
    return this.campers[userId];
  }

  /**
   * 根据蹲守次数决定休息时长
   * 第1次: 10分钟, 第2次: 20分钟, 第3次: 40分钟, 第4次+: 60分钟
   */
  _getRestDuration(userId) {
    if (!userId || !this.campers[userId]) return 10 * 60 * 1000;
    const record = this.campers[userId];
    if (record.restMs) return record.restMs;
    const count = record.count;
    if (count >= 4) return 60 * 60 * 1000;
    if (count >= 3) return 40 * 60 * 1000;
    if (count >= 2) return 20 * 60 * 1000;
    return 10 * 60 * 1000;
  }

  _startSurvival(threatId = null) {
    if (!this.survivalStartedAt) this.survivalStartedAt = Date.now();
    this.survivalThreatId = threatId || this.survivalThreatId;
    this._setMode('survive');
  }

  _canResumeCollect(self, hp) {
    const maxHp = Number(self.max_hp || 100);
    if (hp < maxHp) return false;
    const killer = this._findNearestKiller(self, SAFE_KILLER_DISTANCE);
    return !killer;
  }

  _executeSurvival(self, hp, stamina) {
    this._startSurvival();
    const threat = this._findNearestThreat(self);
    const now = Date.now();

    if (!threat) {
      this._sendVel(0, 0, true);
      if (now - this.lastSurvivalLogAt > 2000) {
        this.log(`[保命] HP ${hp}/${self.max_hp || 100}，附近暂无威胁，暂停采集等待回血`);
        this.lastSurvivalLogAt = now;
      }
      return;
    }

    const dist = Math.hypot(Number(threat.x) - Number(self.x), Number(threat.y) - Number(self.y));
    const name = this.game.getDisplayName(threat.user_id);
    if (stamina.canTeleport && now - this.lastTeleportAt > TELEPORT_COOLDOWN_MS) {
      const safePoint = this._calculateSafeTeleportPoint(self, threat);
      this.ws.teleport(safePoint.x, safePoint.y);
      this.lastTeleportAt = now;
      this.log(`[保命] HP ${hp}，传送远离 ${name} -> ${Math.round(safePoint.x / 100)}m,${Math.round(safePoint.y / 100)}m`);
      return;
    }

    this._executeFleeFrom(self, threat);
    if (now - this.lastSurvivalLogAt > 2000) {
      const threatType = this._isDangerKiller(threat.user_id) ? '杀手' : '玩家';
      this.log(`[保命] HP ${hp}，无法传送，远离${threatType} ${name} (${Math.round(dist / 100)}m)`);
      this.lastSurvivalLogAt = now;
    }
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
    return this._findNearestKiller(self, KILLER_DANGER_RADIUS);
  }

  _findNearestKiller(self, maxDistance = Infinity) {
    const selfX = Number(self.x);
    const selfY = Number(self.y);
    let nearest = null;
    let nearestDist = Infinity;
    for (const p of this.game.otherPlayers) {
      if (p.life === 'Dead' || p.hp <= 0) continue;
      const invUntil = Number(p.invulnerable_until_tick || 0);
      if (invUntil > 0) continue;

      const userId = Number(p.user_id);
      if (!this._isDangerKiller(userId)) continue;

      const dist = Math.hypot(Number(p.x) - selfX, Number(p.y) - selfY);
      if (dist <= maxDistance && dist < nearestDist) {
        nearest = p;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  _findNearestThreat(self) {
    const killer = this._findNearestKiller(self);
    if (killer) return killer;

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
        nearest = p;
        nearestDist = dist;
      }
    }
    return nearest;
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

  _calculateSafeTeleportPoint(self, threat) {
    const selfX = Number(self.x);
    const selfY = Number(self.y);
    let dx = selfX - Number(threat.x);
    let dy = selfY - Number(threat.y);
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;

    const targetX = Number(threat.x) + dx * SAFE_KILLER_DISTANCE;
    const targetY = Number(threat.y) + dy * SAFE_KILLER_DISTANCE;
    const radius = CONSTANTS.WORLD_RADIUS_CM || 1000000;
    return {
      x: Math.max(-radius, Math.min(radius, targetX)),
      y: Math.max(-radius, Math.min(radius, targetY)),
    };
  }

  _buildThreatContext(self) {
    if (!self) return {};
    const selfX = Number(self.x);
    const selfY = Number(self.y);
    return {
      self: { x: selfX, y: selfY, hp: Number(self.hp || 0) },
      nearbyPlayers: this.game.otherPlayers
        .map(p => ({
          userId: Number(p.user_id),
          name: this.game.getDisplayName(p.user_id),
          hp: Number(p.hp || 0),
          distM: Math.round(Math.hypot(Number(p.x) - selfX, Number(p.y) - selfY) / 100),
          killer: this._isDangerKiller(p.user_id),
        }))
        .sort((a, b) => a.distM - b.distM)
        .slice(0, 10),
    };
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
    // 每 5 秒（100 tick）随机改变方向，避免一直朝同一方向卡住
    const shouldChangeDirection = this.currentVel.dx === 0 && this.currentVel.dy === 0 || this.tickCount % 100 === 0;

    if (shouldChangeDirection) {
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
