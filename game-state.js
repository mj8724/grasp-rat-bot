// game-state.js - 游戏状态管理

export const CONSTANTS = {
  WORLD_RADIUS_CM: 1000000,
  DEFAULT_VIEW_RADIUS_CM: 10000,
  ACTIVE_VIEW_RADIUS_CM: 50000,
  CELL_SIZE_CM: 1000,
  SERVER_TICK_MS: 50,
  PLAYER_SPEED_PER_TICK: 50,
  PLAYER_DIAGONAL_SPEED_PER_TICK: 35,
  BULLET_RANGE_CM: 15000,
  BULLET_SPEED_PER_TICK: 500,
  BULLET_HIT_RADIUS_CM: 90,
  FIRE_RATE_MS: 100,
  BULLET_DAMAGE: 3,
  BULLET_STAMINA_COST_MILLI: 500,
  MOVE_STAMINA_PER_10M: 1,
  TELEPORT_STAMINA_COST: 1500000,
};

export class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.entities = [];
    this.bullets = [];
    this.coinDrops = [];
    this.userId = 0;
    this.snapshots = [];
    this.tick = 0;
    this.userNames = new Map();
  }

  get self() {
    if (!this.userId) return null;
    return this.entities.find(e => Number(e.user_id) === this.userId) || null;
  }

  get aliveEntities() {
    return this.entities.filter(e => e.life !== 'Dead' && e.hp > 0);
  }

  get otherPlayers() {
    return this.aliveEntities.filter(e => Number(e.user_id) !== this.userId);
  }

  applySnapshot(msg) {
    this.tick = msg.tick || this.tick;
    this.entities = msg.entities || [];
    this.bullets = msg.bullets || [];
    this.coinDrops = msg.coin_drops || [];

    for (const entity of this.entities) {
      if (entity.user_id && entity.name) {
        this.userNames.set(Number(entity.user_id), entity.name);
      }
    }

    // Keep last 8 snapshots for interpolation
    const snap = {
      tick: this.tick,
      entities: this.entities,
      bullets: this.bullets,
      coinDrops: this.coinDrops,
      receivedAt: Date.now(),
    };
    this.snapshots.push(snap);
    while (this.snapshots.length > 8) this.snapshots.shift();
  }

  applyPositionUpdate(msg) {
    this.tick = msg.tick || this.tick;
    const prevMap = new Map(this.entities.map(e => [Number(e.user_id), e]));
    const merged = [];

    for (const item of msg.entities || []) {
      const id = Number(item.user_id);
      const base = prevMap.get(id) || {};
      merged.push({ ...base, ...item });
    }

    this.entities = merged;
    this.bullets = msg.bullets || [];

    const snap = {
      tick: this.tick,
      entities: this.entities,
      bullets: this.bullets,
      coinDrops: this.coinDrops,
      receivedAt: Date.now(),
    };
    this.snapshots.push(snap);
    while (this.snapshots.length > 8) this.snapshots.shift();
  }

  getDisplayName(userId) {
    return this.userNames.get(Number(userId)) || `User ${userId}`;
  }

  getStaminaInfo(entity) {
    if (!entity) return { exhausted: false, windows: {} };
    const s5s = entity.stamina_5s_remaining_milli || 0;
    const s1h = entity.stamina_1h_remaining_milli || 0;
    const s1d = entity.stamina_1d_remaining_milli || 0;
    const exhausted = s5s < 1000 || s1h < 1000 || s1d < 1000;
    return {
      exhausted,
      s5s, s1h, s1d,
      canShoot: s5s >= CONSTANTS.BULLET_STAMINA_COST_MILLI,
      canTeleport: s1h >= CONSTANTS.TELEPORT_STAMINA_COST && s1d >= CONSTANTS.TELEPORT_STAMINA_COST,
    };
  }
}
