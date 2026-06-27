// index.js - 入口: 启动 Bot

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { Bot } from './bot.js';
import { Dashboard } from './dashboard.js';
import { Persistence } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_URL = 'https://grasp-rat-game.h-e.top';
const LOCAL_PORT = 38472;
const DASHBOARD_PORT = 38473;
const TOKEN_FILE = path.join(__dirname, '.token.json');

let bot = null;
let tokenServer = null;
let dashboard = null;
let savedUserId = null;
let savedToken = null;
let logBuffer = [];
const store = new Persistence();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const logEntry = `[${time}] ${msg}`;
  console.log(logEntry);
  store.logMessage('index', msg);
  logBuffer.push(logEntry);
  if (logBuffer.length > 100) logBuffer.shift();
  // 同步到 dashboard
  if (dashboard) {
    dashboard.update({
      ...dashboard.state,
      logs: logBuffer.slice(-30),
    });
  }
}

// 保存 Token 到文件
function saveToken(userId, token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ userId, token }));
    log(`Token 已保存`);
  } catch (err) {
    log(`保存 Token 失败: ${err.message}`);
  }
}

// 从文件加载 Token
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (data.userId && data.token) {
        return data;
      }
    }
  } catch (err) {
    log(`加载 Token 失败: ${err.message}`);
  }
  return null;
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') cmd = `start "" "${url}"`;
  else if (platform === 'darwin') cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log(`无法自动打开浏览器: ${err.message}`);
    else log('浏览器已打开');
  });
}

function updateDashboard() {
  if (!dashboard) return;
  dashboard.update({
    online: !!bot,
    savedUserId: savedUserId,
    logs: logBuffer.slice(-30),
  });
}

function startBot(userId, token) {
  if (bot) {
    log('停止旧 Bot...');
    bot.stop();
    bot = null;
  }

  log(`用户 ID: ${userId}`);
  log('正在启动 Bot...');
  savedUserId = userId;
  savedToken = token;
  saveToken(userId, token);
  updateDashboard();

  bot = new Bot(userId, token, dashboard, store);
  updateDashboard();
  bot.start();
}

function stopBot() {
  if (bot) {
    log('Bot 已停止');
    bot.stop();
    bot = null;
    if (dashboard) dashboard.gameStateGetter = null;
    updateDashboard();
  }
}

function startDashboard() {
  dashboard = new Dashboard(DASHBOARD_PORT);

  // 设置回调
  dashboard.onOnline = () => {
    if (bot) return { ok: false, message: 'Bot 已在运行' };
    if (!savedUserId || !savedToken) return { ok: false, message: '未找到 Token，请先登录' };
    startBot(savedUserId, savedToken);
    return { ok: true, message: 'Bot 已上线' };
  };

  dashboard.onOffline = () => {
    stopBot();
    return { ok: true, message: 'Bot 已下线' };
  };

  dashboard.onLogin = (userId, token) => {
    startBot(userId, token);
    return { ok: true, message: 'Token 已保存，Bot 已启动' };
  };

  dashboard.logBuffer = logBuffer;
  dashboard.start();
  updateDashboard();
}

function startTokenServer() {
  tokenServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 接收 Token (Chrome 扩展调用)
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.userId || !data.token) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing userId or token');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          startBot(Number(data.userId), data.token);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  tokenServer.listen(LOCAL_PORT, () => {
    log(`本地服务器已启动 (端口 ${LOCAL_PORT})`);
  });
}

async function main() {
  const args = process.argv.slice(2);

  // 方式1: 命令行参数直接传入
  if (args.length >= 2) {
    const userId = Number(args[0]);
    const token = args[1];
    if (!userId || !token) {
      console.log('用法: node index.js <user_id> <session_token>');
      process.exit(1);
    }
    startDashboard();
    startBot(userId, token);
    return;
  }

  // 方式2: 启动 HTTP 服务器
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   囤囤鼠历险记 - 自动游戏工具            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 尝试加载已保存的 Token
  const saved = loadToken();
  if (saved) {
    savedUserId = saved.userId;
    savedToken = saved.token;
    console.log(`✅ 已加载 Token (用户ID: ${savedUserId})`);
    console.log(`   点击控制面板「上线」按钮启动 Bot`);
  } else {
    console.log('📋 首次使用请在控制面板输入 Token');
  }

  console.log('');
  console.log(`控制面板: http://localhost:${DASHBOARD_PORT}`);
  console.log('');

  startDashboard();
  startTokenServer();
}

// 优雅退出
process.on('SIGINT', () => {
  log('\n正在退出...');
  if (bot) bot.stop();
  store.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (bot) bot.stop();
  store.close();
  process.exit(0);
});

main();
