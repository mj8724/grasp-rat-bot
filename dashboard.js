// dashboard.js - Web 控制面板

import http from 'http';

export class Dashboard {
  constructor(port = 38473) {
    this.port = port;
    this.state = {};
    this.server = null;
    this.onLeave = null;
    this.gameStateGetter = null;
  }

  update(state) {
    this.state = { ...state, updatedAt: new Date().toLocaleTimeString() };
  }

  start() {
    this.server = http.createServer((req, res) => {
      // API: 获取游戏状态
      if (req.url === '/api/state' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const gameState = this.gameStateGetter ? this.gameStateGetter() : {};
        res.end(JSON.stringify(gameState));
        return;
      }

      // API: 手动离开
      if (req.url === '/leave' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        if (this.onLeave) {
          this.onLeave();
          res.end(JSON.stringify({ ok: true, message: '已触发离开' }));
        } else {
          res.end(JSON.stringify({ ok: false, message: 'Bot未初始化' }));
        }
        return;
      }

      // 主页面
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(this._render());
    });
    this.server.listen(this.port, () => {
      console.log(`[控制面板] http://localhost:${this.port}`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  _render() {
    const s = this.state;
    const mode = s.mode || '-';
    const modeEmoji = { collect: '💰', flee: '🏃', finish: '🎯', roam: '🚶', rest: '😴', fight_back: '⚔️', '-': '⏳' };
    const hp = s.hp ?? '-';
    const maxHp = s.maxHp ?? 100;
    const hpPercent = typeof hp === 'number' ? Math.round(hp / maxHp * 100) : 0;
    const sta = s.stamina ?? '-';
    const sta1h = s.stamina1h ?? '-';
    const sta1d = s.stamina1d ?? '-';
    const x = s.x ?? '-';
    const y = s.y ?? '-';
    const players = s.players ?? 0;
    const coins = s.coins ?? 0;
    const nearestCoinDist = s.nearestCoinDist ?? '-';
    const totalCoinValue = s.totalCoinValue ?? 0;
    const kills = s.kills ?? 0;
    const deaths = s.deaths ?? 0;
    const wsStatus = s.wsStatus || 'offline';
    const restRemaining = s.restRemaining;
    const isResting = mode === 'rest';

    let wsBadgeColor = '#f87171';
    if (wsStatus === 'ws online') wsBadgeColor = '#4ade80';
    else if (isResting) wsBadgeColor = '#facc15';

    const sta1hPercent = typeof sta1h === 'number' ? Math.round(sta1h / 3000 * 100) : 0;
    const sta1dPercent = typeof sta1d === 'number' ? Math.round(sta1d / 20000 * 100) : 0;

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>囤囤鼠 Bot 控制台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:20px}
h1{text-align:center;color:#38bdf8;margin-bottom:20px;font-size:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;max-width:900px;margin:0 auto}
.card{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}
.card .label{font-size:12px;color:#64748b;text-transform:uppercase;margin-bottom:4px}
.card .value{font-size:24px;font-weight:700}
.card .sub{font-size:11px;color:#94a3b8;margin-top:4px}
.hp-bar,.sta-bar{height:8px;background:#334155;border-radius:4px;margin-top:8px;overflow:hidden}
.hp-fill{height:100%;border-radius:4px;transition:width 0.3s;background:${hpPercent > 50 ? '#4ade80' : hpPercent > 20 ? '#facc15' : '#f87171'}}
.sta-fill{height:100%;border-radius:4px;transition:width 0.3s}
.mode-card{text-align:center;grid-column:span 2}
.mode-emoji{font-size:48px}
.mode-name{font-size:18px;font-weight:600;margin-top:4px;text-transform:uppercase}
.stats{display:flex;gap:12px;justify-content:center;margin-top:12px}
.stat{text-align:center}
.stat .num{font-size:28px;font-weight:700}
.stat .lbl{font-size:11px;color:#64748b}
.kill{color:#4ade80}.death{color:#f87171}
.ws-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${wsBadgeColor};color:#0f172a}
.rest-alert{background:#2a1f00;border:2px solid #facc15;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px;max-width:900px;margin:0 auto 20px}
.rest-alert h2{color:#facc15;font-size:20px;margin-bottom:8px}
.rest-alert p{color:#fef08a;font-size:14px}
.btn-row{max-width:900px;margin:16px auto;text-align:center}
.btn-leave{background:#ef4444;color:white;border:none;padding:12px 32px;font-size:16px;font-weight:600;border-radius:8px;cursor:pointer;transition:background 0.2s}
.btn-leave:hover{background:#dc2626}
.btn-leave:disabled{background:#475569;cursor:not-allowed}
#leaveMsg{color:#94a3b8;font-size:13px;margin-top:8px}
.game-view{max-width:900px;margin:16px auto;background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px}
.game-view h3{color:#38bdf8;font-size:14px;margin-bottom:12px}
#gameCanvas{display:block;margin:0 auto;background:#060b16;border-radius:8px;border:1px solid #334155}
.footer{text-align:center;margin-top:20px;color:#475569;font-size:12px}
</style></head><body>
<h1>🐭 囤囤鼠 Bot 控制台 <span class="ws-badge">${wsStatus}</span></h1>
${isResting ? `<div class="rest-alert"><h2>😴 体力耗尽，休息中</h2><p>剩余时间: ${restRemaining ?? '?'} 分钟</p><p>恢复后将自动重新连接</p></div>` : ''}
<div class="grid">
  <div class="card mode-card">
    <div class="mode-emoji">${modeEmoji[mode] || '❓'}</div>
    <div class="mode-name">${mode}</div>
    <div class="stats">
      <div class="stat"><div class="num kill">${kills}</div><div class="lbl">击杀</div></div>
      <div class="stat"><div class="num death">${deaths}</div><div class="lbl">死亡</div></div>
    </div>
  </div>
  <div class="card">
    <div class="label">HP</div>
    <div class="value">${hp} / ${maxHp}</div>
    <div class="hp-bar"><div class="hp-fill" style="width:${hpPercent}%"></div></div>
  </div>
  <div class="card">
    <div class="label">体力 5s</div>
    <div class="value">${sta} / 10</div>
  </div>
  <div class="card">
    <div class="label">体力 1h</div>
    <div class="value">${sta1h} / 3000</div>
    <div class="sta-bar"><div class="sta-fill" style="width:${sta1hPercent}%;background:${sta1hPercent > 20 ? '#38bdf8' : '#f87171'}"></div></div>
  </div>
  <div class="card">
    <div class="label">体力 1d</div>
    <div class="value">${sta1d} / 20000</div>
    <div class="sta-bar"><div class="sta-fill" style="width:${sta1dPercent}%;background:${sta1dPercent > 20 ? '#38bdf8' : '#f87171'}"></div></div>
  </div>
  <div class="card">
    <div class="label">位置</div>
    <div class="value">${x}, ${y}</div>
    <div class="sub">单位: 米</div>
  </div>
  <div class="card">
    <div class="label">金币信息</div>
    <div class="value">${coins} 个</div>
    <div class="sub">最近: ${nearestCoinDist}m · 总价值: ${totalCoinValue}</div>
  </div>
  <div class="card">
    <div class="label">附近</div>
    <div class="value">${players} 玩家</div>
  </div>
</div>
<div class="btn-row">
  <button class="btn-leave" onclick="doLeave()">离开游戏</button>
  <div id="leaveMsg"></div>
</div>
<div class="game-view">
  <h3>🗺️ 游戏视图 (半径 300m)</h3>
  <canvas id="gameCanvas" width="600" height="600"></canvas>
</div>
<div class="footer">每 2 秒自动刷新 · ${s.updatedAt || ''}</div>
<script>
async function doLeave() {
  const btn = document.querySelector('.btn-leave');
  const msg = document.getElementById('leaveMsg');
  btn.disabled = true;
  btn.textContent = '正在离开...';
  try {
    const resp = await fetch('/leave', { method: 'POST' });
    const data = await resp.json();
    msg.textContent = data.message;
    msg.style.color = data.ok ? '#4ade80' : '#f87171';
  } catch(e) {
    msg.textContent = '请求失败: ' + e.message;
    msg.style.color = '#f87171';
  }
  btn.disabled = false;
  btn.textContent = '离开游戏';
}

// 游戏视图
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const VIEW_RADIUS = 30000; // 300m

async function fetchAndDraw() {
  try {
    const resp = await fetch('/api/state');
    const state = await resp.json();
    draw(state);
  } catch(e) {}
}

function worldToScreen(wx, wy, selfX, selfY) {
  const scale = W / (VIEW_RADIUS * 2);
  return {
    x: W/2 + (wx - selfX) * scale,
    y: H/2 + (wy - selfY) * scale
  };
}

function draw(state) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#060b16';
  ctx.fillRect(0, 0, W, H);

  if (!state.self) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待游戏数据...', W/2, H/2);
    return;
  }

  const selfX = state.self.x;
  const selfY = state.self.y;
  const scale = W / (VIEW_RADIUS * 2);

  // 网格
  ctx.strokeStyle = 'rgba(148,163,184,0.1)';
  ctx.lineWidth = 1;
  for (let i = -300; i <= 300; i += 50) {
    const p = worldToScreen(selfX + i*100, selfY, selfX, selfY);
    ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, H); ctx.stroke();
    const p2 = worldToScreen(selfX, selfY + i*100, selfX, selfY);
    ctx.beginPath(); ctx.moveTo(0, p2.y); ctx.lineTo(W, p2.y); ctx.stroke();
  }

  // 150m 危险圈
  const dangerR = 15000 * scale;
  ctx.strokeStyle = 'rgba(248,113,113,0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6,6]);
  ctx.beginPath(); ctx.arc(W/2, H/2, dangerR, 0, Math.PI*2); ctx.stroke();
  ctx.setLineDash([]);

  // 金币
  if (state.coins) {
    for (const coin of state.coins) {
      const p = worldToScreen(coin.x, coin.y, selfX, selfY);
      if (p.x < -10 || p.x > W+10 || p.y < -10 || p.y > H+10) continue;
      ctx.fillStyle = '#facc15';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2); ctx.fill();
    }
  }

  // 玩家
  if (state.players) {
    for (const player of state.players) {
      const p = worldToScreen(player.x, player.y, selfX, selfY);
      if (p.x < -20 || p.x > W+20 || p.y < -20 || p.y > H+20) continue;
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#020617'; ctx.lineWidth = 1.5; ctx.stroke();
      // 名字
      ctx.fillStyle = '#a7f3d0';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(player.name || '???', p.x + 10, p.y - 5);
      ctx.fillText('HP ' + player.hp, p.x + 10, p.y + 7);
    }
  }

  // 自身
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath(); ctx.arc(W/2, H/2, 8, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#020617'; ctx.lineWidth = 2; ctx.stroke();

  // 自身标签
  ctx.fillStyle = '#bae6fd';
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('你 HP ' + state.self.hp, W/2 + 14, H/2 - 5);
  ctx.fillText('(' + Math.round(selfX/100) + 'm, ' + Math.round(selfY/100) + 'm)', W/2 + 14, H/2 + 7);

  // 图例
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🔵 你  🟢 玩家  🟡 金币  🔴 150m危险圈', 10, H - 10);
}

fetchAndDraw();
setInterval(fetchAndDraw, 2000);
</script>
</body></html>`;
  }
}
