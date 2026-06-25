// dashboard.js - Web 控制面板

import http from 'http';

export class Dashboard {
  constructor(port = 38473) {
    this.port = port;
    this.state = {};
    this.server = null;
    // 回调函数
    this.onLeave = null;
    this.onOnline = null;
    this.onOffline = null;
    this.onLogin = null;
    this.gameStateGetter = null;
    this.logBuffer = [];
  }

  update(state) {
    this.state = { ...state, updatedAt: new Date().toLocaleTimeString() };
  }

  start() {
    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // API: 获取游戏状态
      if (req.url === '/api/state' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
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

      // API: 上线
      if (req.url === '/api/online' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        const result = this.onOnline ? this.onOnline() : { ok: false, message: '未初始化' };
        res.end(JSON.stringify(result));
        return;
      }

      // API: 下线
      if (req.url === '/api/offline' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        const result = this.onOffline ? this.onOffline() : { ok: false, message: '未初始化' };
        res.end(JSON.stringify(result));
        return;
      }

      // API: 登录
      if (req.url === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data.userId || !data.token) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: '缺少 userId 或 token' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            const result = this.onLogin ? this.onLogin(Number(data.userId), data.token) : { ok: false, message: '未初始化' };
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: '请求格式错误' }));
          }
        });
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
    const online = s.online ?? false;
    const savedUserId = s.savedUserId ?? null;
    const logs = s.logs ?? [];

    // Bot 在线时显示游戏状态
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
    const killers = s.killers ?? '';
    const allKillers = s.allKillers ?? [];
    const wsStatus = s.wsStatus || (online ? 'connecting' : 'offline');
    const restRemaining = s.restRemaining;
    const isResting = mode === 'rest';

    let wsBadgeColor = '#f87171';
    if (wsStatus === 'ws online') wsBadgeColor = '#4ade80';
    else if (isResting) wsBadgeColor = '#facc15';
    else if (!online) wsBadgeColor = '#475569';

    let wsBadgeText = wsStatus;
    if (!online) wsBadgeText = 'offline';

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
.game-view{max-width:900px;margin:16px auto;background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px}
.game-view h3{color:#38bdf8;font-size:14px;margin-bottom:12px}
#gameCanvas{display:block;margin:0 auto;background:#060b16;border-radius:8px;border:1px solid #334155}
.log-view{max-width:900px;margin:16px auto;background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px;max-height:300px;overflow-y:auto}
.footer{text-align:center;margin-top:20px;color:#475569;font-size:12px}
</style></head><body>
<h1>🐭 囤囤鼠 Bot 控制台 <span class="ws-badge">${wsBadgeText}</span></h1>

${isResting ? `<div class="rest-alert"><h2>😴 体力耗尽，休息中</h2><p>剩余时间: ${restRemaining ?? '?'} 分钟</p><p>恢复后将自动重新连接</p></div>` : ''}

${online ? `
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
  ${killers ? `<div class="card" style="grid-column:span 2"><div class="label">⚠️ 危险杀手 (300m)</div><div class="value" style="font-size:16px;color:#f87171">${killers}</div></div>` : ''}
</div>
${allKillers.length > 0 ? `
<div style="max-width:900px;margin:12px auto;background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px">
  <h3 style="color:#f87171;font-size:14px;margin-bottom:12px">📋 杀手记录 (持久化)</h3>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
    ${allKillers.map(function(k) {
      const parts = k.split(': ');
      const name = parts[0];
      const killCount = parseInt(parts[1]) || 0;
      const color = killCount >= 5 ? '#ef4444' : killCount >= 2 ? '#f87171' : '#94a3b8';
      return '<div style="background:#0f172a;padding:8px 12px;border-radius:6px;border:1px solid #334155"><span style="color:' + color + ';font-weight:600">' + name + '</span><span style="color:#64748b;font-size:12px;float:right">' + killCount + '杀</span></div>';
    }).join('')}
  </div>
</div>
` : ''}
` : `
<div style="max-width:900px;margin:40px auto;text-align:center">
  <div style="font-size:48px;margin-bottom:16px">⏸️</div>
  <div style="font-size:18px;color:#94a3b8">Bot 离线</div>
  ${savedUserId ? `<div style="font-size:14px;color:#64748b;margin-top:8px">用户 ID: ${savedUserId}</div>` : ''}
</div>
`}

<div class="btn-row">
  <button onclick="doOnline()" style="background:${online ? '#475569' : '#4ade80'};color:#0f172a;border:none;padding:12px 32px;font-size:16px;font-weight:600;border-radius:8px;cursor:pointer;margin-right:12px;${online ? 'opacity:0.5' : ''}">🟢 上线</button>
  <button onclick="doOffline()" style="background:${online ? '#f87171' : '#475569'};color:white;border:none;padding:12px 32px;font-size:16px;font-weight:600;border-radius:8px;cursor:pointer;${online ? '' : 'opacity:0.5'}">🔴 下线</button>
  <div id="actionMsg" style="margin-top:8px;font-size:13px;color:#94a3b8"></div>
</div>

${!savedUserId ? `
<div style="max-width:900px;margin:16px auto;background:#1e293b;border-radius:10px;border:1px solid #334155;padding:20px">
  <h3 style="color:#38bdf8;font-size:16px;margin-bottom:16px">🔑 首次登录</h3>
  <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">登录后 Token 会自动保存，之后只需点击「上线/下线」按钮</p>
  <div style="display:flex;gap:12px;align-items:end;flex-wrap:wrap">
    <div>
      <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">用户 ID</label>
      <input id="inputUserId" type="text" placeholder="输入用户ID" style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;width:150px;font-size:14px">
    </div>
    <div>
      <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">Session Token</label>
      <input id="inputToken" type="text" placeholder="输入Token" style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;width:300px;font-size:14px">
    </div>
    <button onclick="doLogin()" style="background:#38bdf8;color:#0f172a;border:none;padding:8px 24px;font-size:14px;font-weight:600;border-radius:6px;cursor:pointer">保存并启动</button>
    <a href="https://grasp-rat-game.h-e.top" target="_blank" style="color:#38bdf8;font-size:13px;text-decoration:none;padding:8px">打开游戏 →</a>
  </div>
  <div style="margin-top:12px;font-size:12px;color:#64748b">
    <p>获取 Token 方法:</p>
    <ol style="margin:8px 0 0 20px">
      <li>打开游戏网站并登录</li>
      <li>按 F12 打开开发者工具</li>
      <li>在 Console 中输入: <code style="background:#334155;padding:2px 6px;border-radius:3px">localStorage.tmpGameUserId</code></li>
      <li>再输入: <code style="background:#334155;padding:2px 6px;border-radius:3px">localStorage.tmpGameSessionToken</code></li>
    </ol>
  </div>
</div>
` : ''}

${online ? `
<div class="game-view">
  <h3>🗺️ 游戏视图 (半径 300m)</h3>
  <canvas id="gameCanvas" width="600" height="600"></canvas>
</div>
` : ''}

<div class="log-view">
  <h3 style="color:#38bdf8;font-size:14px;margin-bottom:12px">📋 运行日志</h3>
  <div id="logContent" style="font-family:monospace;font-size:12px;color:#94a3b8;line-height:1.6">${logs.map(function(log) { return '<div>' + log + '</div>'; }).join('')}</div>
</div>

<div class="footer">每 2 秒自动刷新 · ${s.updatedAt || ''}</div>
<script>
async function doOnline() {
  const msg = document.getElementById('actionMsg');
  msg.textContent = '正在上线...';
  msg.style.color = '#facc15';
  try {
    const resp = await fetch('/api/online', { method: 'POST' });
    const data = await resp.json();
    msg.textContent = data.message;
    msg.style.color = data.ok ? '#4ade80' : '#f87171';
    if (data.ok) setTimeout(function() { location.reload(); }, 1000);
  } catch(e) {
    msg.textContent = '请求失败: ' + e.message;
    msg.style.color = '#f87171';
  }
}

async function doOffline() {
  const msg = document.getElementById('actionMsg');
  msg.textContent = '正在下线...';
  msg.style.color = '#facc15';
  try {
    const resp = await fetch('/api/offline', { method: 'POST' });
    const data = await resp.json();
    msg.textContent = data.message;
    msg.style.color = data.ok ? '#4ade80' : '#f87171';
    if (data.ok) setTimeout(function() { location.reload(); }, 1000);
  } catch(e) {
    msg.textContent = '请求失败: ' + e.message;
    msg.style.color = '#f87171';
  }
}

async function doLogin() {
  const userId = document.getElementById('inputUserId').value.trim();
  const token = document.getElementById('inputToken').value.trim();
  const msg = document.getElementById('actionMsg');

  if (!userId || !token) {
    msg.textContent = '请输入用户ID和Token';
    msg.style.color = '#f87171';
    return;
  }

  msg.textContent = '正在保存并启动...';
  msg.style.color = '#facc15';

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(userId), token: token })
    });
    const data = await resp.json();
    msg.textContent = data.message;
    msg.style.color = data.ok ? '#4ade80' : '#f87171';
    if (data.ok) setTimeout(function() { location.reload(); }, 1000);
  } catch(e) {
    msg.textContent = '请求失败: ' + e.message;
    msg.style.color = '#f87171';
  }
}

${online ? `
// 游戏视图
var canvas = document.getElementById('gameCanvas');
var ctx = canvas.getContext('2d');
var W = canvas.width, H = canvas.height;
var VIEW_RADIUS = 30000;

async function fetchAndDraw() {
  try {
    var resp = await fetch('/api/state');
    var state = await resp.json();
    draw(state);
    if (state.logs) {
      var logContent = document.getElementById('logContent');
      logContent.innerHTML = state.logs.map(function(log) { return '<div>' + log + '</div>'; }).join('');
      logContent.scrollTop = logContent.scrollHeight;
    }
  } catch(e) {}
}

function worldToScreen(wx, wy, selfX, selfY) {
  var scale = W / (VIEW_RADIUS * 2);
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

  var selfX = state.self.x;
  var selfY = state.self.y;
  var scale = W / (VIEW_RADIUS * 2);

  ctx.strokeStyle = 'rgba(148,163,184,0.1)';
  ctx.lineWidth = 1;
  for (var i = -300; i <= 300; i += 50) {
    var p = worldToScreen(selfX + i*100, selfY, selfX, selfY);
    ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, H); ctx.stroke();
    var p2 = worldToScreen(selfX, selfY + i*100, selfX, selfY);
    ctx.beginPath(); ctx.moveTo(0, p2.y); ctx.lineTo(W, p2.y); ctx.stroke();
  }

  var dangerR = 20000 * scale;
  ctx.strokeStyle = 'rgba(248,113,113,0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6,6]);
  ctx.beginPath(); ctx.arc(W/2, H/2, dangerR, 0, Math.PI*2); ctx.stroke();
  ctx.setLineDash([]);

  var killerR = 30000 * scale;
  ctx.strokeStyle = 'rgba(239,68,68,0.4)';
  ctx.lineWidth = 2;
  ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.arc(W/2, H/2, killerR, 0, Math.PI*2); ctx.stroke();
  ctx.setLineDash([]);

  if (state.coins) {
    for (var ci = 0; ci < state.coins.length; ci++) {
      var coin = state.coins[ci];
      var cp = worldToScreen(coin.x, coin.y, selfX, selfY);
      if (cp.x < -10 || cp.x > W+10 || cp.y < -10 || cp.y > H+10) continue;
      ctx.fillStyle = '#facc15';
      ctx.beginPath(); ctx.arc(cp.x, cp.y, 4, 0, Math.PI*2); ctx.fill();
    }
  }

  if (state.players) {
    for (var pi = 0; pi < state.players.length; pi++) {
      var player = state.players[pi];
      var pp = worldToScreen(player.x, player.y, selfX, selfY);
      if (pp.x < -20 || pp.x > W+20 || pp.y < -20 || pp.y > H+20) continue;
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(pp.x, pp.y, 6, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#020617'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#a7f3d0';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(player.name || '???', pp.x + 10, pp.y - 5);
      ctx.fillText('HP ' + player.hp, pp.x + 10, pp.y + 7);
    }
  }

  ctx.fillStyle = '#38bdf8';
  ctx.beginPath(); ctx.arc(W/2, H/2, 8, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#020617'; ctx.lineWidth = 2; ctx.stroke();

  ctx.fillStyle = '#bae6fd';
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('你 HP ' + state.self.hp, W/2 + 14, H/2 - 5);
  ctx.fillText('(' + Math.round(selfX/100) + 'm, ' + Math.round(selfY/100) + 'm)', W/2 + 14, H/2 + 7);

  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🔵 你  🟢 玩家  🟡 金币  🔴 200m  🟠 300m杀手', 10, H - 10);
}

fetchAndDraw();
setInterval(fetchAndDraw, 2000);
` : ''}
</script>
</body></html>`;
  }
}
