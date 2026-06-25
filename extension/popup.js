// popup.js - 弹出窗口逻辑

const btnManual = document.getElementById('btnManual');
const btnCheck = document.getElementById('btnCheck');
const status = document.getElementById('status');

function setStatus(msg, type = 'info') {
  status.className = `status ${type}`;
  status.innerHTML = msg;
}

async function getGameTab() {
  const tabs = await chrome.tabs.query({ url: 'https://grasp-rat-game.h-e.top/*' });
  return tabs[0] || null;
}

async function readToken() {
  const tab = await getGameTab();
  if (!tab) {
    throw new Error('未找到游戏页面，请先打开游戏');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return {
        userId: localStorage.getItem('tmpGameUserId'),
        token: localStorage.getItem('tmpGameSessionToken')
      };
    }
  });

  const data = results[0]?.result;
  if (!data || !data.userId || !data.token) {
    throw new Error('未检测到登录信息，请先登录游戏');
  }

  return data;
}

async function sendToken(data) {
  const resp = await fetch('http://localhost:38472/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  if (!resp.ok) {
    throw new Error('发送失败: ' + resp.status);
  }

  return true;
}

// 手动发送
btnManual.addEventListener('click', async () => {
  btnManual.disabled = true;
  setStatus('正在读取Token...', 'loading');

  try {
    const data = await readToken();
    setStatus(`用户ID: ${data.userId}<br>正在发送...`, 'loading');

    await sendToken(data);
    setStatus(`✅ 已发送!<br>用户ID: ${data.userId}<br>Bot正在启动...`, 'ok');
  } catch (err) {
    setStatus(`❌ ${err.message}`, 'error');
  } finally {
    btnManual.disabled = false;
  }
});

// 检查登录状态
btnCheck.addEventListener('click', async () => {
  btnCheck.disabled = true;
  setStatus('正在检查...', 'loading');

  try {
    const data = await readToken();
    setStatus(`✅ 已登录<br>用户ID: ${data.userId}`, 'ok');
  } catch (err) {
    setStatus(`⚠️ ${err.message}`, 'error');
  } finally {
    btnCheck.disabled = false;
  }
});

// 初始化检查
(async () => {
  try {
    const data = await readToken();
    setStatus(`✅ 已检测到登录<br>用户ID: ${data.userId}<br>点击下方按钮启动Bot`, 'ok');
  } catch (err) {
    setStatus(`等待登录...<br>${err.message}`, 'info');
  }
})();
