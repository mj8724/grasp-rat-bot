// targeting.js - 目标选择与瞄准算法

import { CONSTANTS } from './game-state.js';

/**
 * 从可用目标中选择最佳射击目标
 * 优先级: 低HP > 高Drop > 距离近 > 非无敌
 */
export function selectBestTarget(self, targets, maxRange = CONSTANTS.BULLET_RANGE_CM) {
  if (!self || !targets.length) return null;

  const selfX = Number(self.x);
  const selfY = Number(self.y);

  let best = null;
  let bestScore = -Infinity;

  for (const target of targets) {
    const id = Number(target.user_id);
    const tx = Number(target.x);
    const ty = Number(target.y);
    const dx = tx - selfX;
    const dy = ty - selfY;
    const dist = Math.hypot(dx, dy);

    // Skip if out of range
    if (dist > maxRange) continue;

    // Skip invulnerable
    const invUntil = Number(target.invulnerable_until_tick || 0);
    if (invUntil > 0) continue;

    // Skip dead
    if (target.life === 'Dead' || target.hp <= 0) continue;

    // Score calculation
    const hp = Number(target.hp || 100);
    const maxHp = Number(target.max_hp || 100);
    const drop = Number(target.death_reward_preview || target.death_drop_coins || 0);

    // Lower HP = higher priority (easier to kill)
    const hpScore = (1 - hp / maxHp) * 100;

    // Higher drop = higher priority
    const dropScore = Math.min(drop * 0.5, 50);

    // Closer = higher priority
    const distScore = Math.max(0, (maxRange - dist) / maxRange) * 30;

    // Bonus for very low HP (finish them off)
    const finishBonus = hp <= CONSTANTS.BULLET_DAMAGE * 3 ? 80 : 0;

    const score = hpScore + dropScore + distScore + finishBonus;

    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }

  return best;
}

/**
 * 计算射击预判位置
 * 考虑目标移动速度和子弹飞行时间
 * 注意: 当前策略以逃跑为主，此函数暂未使用
 */
export function calculateLeadPosition(self, target) {
  const selfX = Number(self.x);
  const selfY = Number(self.y);
  const targetX = Number(target.x);
  const targetY = Number(target.y);
  const targetVx = Number(target.vx || 0);
  const targetVy = Number(target.vy || 0);

  const dx = targetX - selfX;
  const dy = targetY - selfY;
  const dist = Math.hypot(dx, dy);

  if (dist === 0) return { x: targetX, y: targetY };

  // Bullet travel time in ticks
  const travelTime = dist / CONSTANTS.BULLET_SPEED_PER_TICK;

  // Predict where target will be when bullet arrives
  const predictX = targetX + targetVx * travelTime * CONSTANTS.SERVER_TICK_MS / 10;
  const predictY = targetY + targetVy * travelTime * CONSTANTS.SERVER_TICK_MS / 10;

  return { x: predictX, y: predictY };
}

/**
 * 计算移动方向，朝目标移动
 * 返回 { dx, dy } 归一化方向 (-1, 0, 1)
 */
export function calculateMoveDirection(self, targetX, targetY) {
  const dx = targetX - Number(self.x);
  const dy = targetY - Number(self.y);
  const dist = Math.hypot(dx, dy);

  if (dist < 50) return { dx: 0, dy: 0 }; // 非常近才停下

  // 归一化到 -1/0/1，确保至少有一个方向
  let ndx = Math.sign(dx);
  let ndy = Math.sign(dy);

  // 如果距离很小，只取主方向
  if (dist < 500) {
    if (Math.abs(dx) > Math.abs(dy) * 2) ndy = 0;
    else if (Math.abs(dy) > Math.abs(dx) * 2) ndx = 0;
  }

  return { dx: ndx, dy: ndy };
}

/**
 * 计算逃离方向，远离威胁
 */
export function calculateFleeDirection(self, threatX, threatY) {
  const dir = calculateMoveDirection(self, threatX, threatY);
  return { dx: -dir.dx, dy: -dir.dy };
}
