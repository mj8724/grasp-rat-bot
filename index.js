// index.js - 入口: 启动 Bot

import http from 'http';
import { exec } from 'child_process';
import { Bot } from './bot.js';

const GAME_URL = 'https://grasp-rat-game.h-e.top';
const LOCAL_PORT = 38472;

let bot = null;
let tokenServer = null;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
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

function startBot(userId, token) {
  log(`用户 ID: ${userId}`);
  log('正在启动 Bot...');
  bot = new Bot(userId, token);
  bot.start();

  process.on('SIGINT', () => {
    log('\n正在退出...');
    if (bot) bot.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (bot) bot.stop();
    process.exit(0);
  });
}

function startTokenServer(onToken) {
  tokenServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
          onToken(Number(data.userId), data.token);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
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
    startBot(userId, token);
    return;
  }

  // 方式2: 启动 HTTP 服务器（持续运行，可重复发送 Token）
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   囤囤鼠历险记 - 自动游戏工具            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('🤖 自动模式已就绪!');
  console.log('');
  console.log('控制面板: http://localhost:38473');
  console.log('等待登录中...');
  console.log('');

  openBrowser(GAME_URL);

  // 持续监听 Token（不关闭服务器）
  startTokenServer((userId, token) => {
    log(`收到 Token! 用户ID: ${userId}`);

    if (bot) {
      // 已有 bot 在运行，停止旧的启动新的
      log('停止旧 Bot，使用新 Token 重新启动...');
      bot.stop();
      bot = null;
    }

    startBot(userId, token);
  });
}

main();
