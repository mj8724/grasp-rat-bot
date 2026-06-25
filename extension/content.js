// content.js - 自动检测登录并发送Token

(function() {
  'use strict';

  const BOT_SERVER = 'http://localhost:38472/token';
  const CHECK_INTERVAL = 3000;
  const MAX_RETRIES = 20;

  let retries = 0;
  let sent = false;
  let lastUserId = null;
  let lastToken = null;

  function log(msg) {
    console.log(`[囤囤鼠Bot] ${msg}`);
  }

  async function sendToken(userId, token) {
    // 防止重复发送相同的 token
    if (sent && lastUserId === userId && lastToken === token) {
      return;
    }

    try {
      const resp = await fetch(BOT_SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, token })
      });

      if (resp.ok) {
        sent = true;
        lastUserId = userId;
        lastToken = token;
        log(`✅ Token已发送! 用户ID: ${userId}`);
        showNotification('Bot已启动', `用户ID: ${userId}`);
      } else {
        log(`❌ 发送失败: ${resp.status}`);
      }
    } catch (err) {
      log(`❌ 连接失败: ${err.message} (Bot可能未启动)`);
    }
  }

  function showNotification(title, body) {
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #1e293b;
      color: #e2e8f0;
      padding: 16px 24px;
      border-radius: 10px;
      border: 2px solid #38bdf8;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 14px;
      z-index: 99999;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      animation: slideIn 0.3s ease-out;
    `;
    div.innerHTML = `<strong style="color:#38bdf8">🐭 ${title}</strong><br>${body}`;
    document.body.appendChild(div);

    setTimeout(() => {
      div.style.animation = 'slideOut 0.3s ease-in';
      setTimeout(() => div.remove(), 300);
    }, 5000);

    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
    `;
    document.head.appendChild(style);
  }

  function checkLogin() {
    const userId = localStorage.getItem('tmpGameUserId');
    const token = localStorage.getItem('tmpGameSessionToken');

    if (userId && token) {
      // 只有 token 变化了才重新发送
      if (userId !== lastUserId || token !== lastToken) {
        log(`检测到登录: 用户ID ${userId}`);
        sendToken(userId, token);
      }
    } else {
      retries++;
      sent = false;
      lastUserId = null;
      lastToken = null;
      if (retries < MAX_RETRIES) {
        setTimeout(checkLogin, CHECK_INTERVAL);
      }
    }
  }

  // 页面加载后延迟检测（等页面完全加载）
  setTimeout(() => {
    log('开始检测登录状态...');
    checkLogin();
  }, 1000);

  // 监听storage变化
  window.addEventListener('storage', (e) => {
    if (e.key === 'tmpGameUserId' || e.key === 'tmpGameSessionToken') {
      log('检测到登录信息变化');
      sent = false; // 重置，允许重新发送
      checkLogin();
    }
  });
})();
