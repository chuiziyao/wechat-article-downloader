#!/usr/bin/env node
'use strict';
// 浏览器探测 + 启动远程调试（无额外依赖，仅用 Node 内置模块）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 9223;

// 探测优先级：Chrome -> Chromium -> Edge -> Brave -> 其他 Chromium 内核
const CANDIDATES = [
  // Windows - Chrome（首选）
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  // Windows - Chromium
  'C:\\Program Files\\Chromium\\Application\\chromium.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Chromium', 'Application', 'chromium.exe'),
  // Windows - Edge
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Windows - Brave
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
];

function findBrowser() {
  for (const c of CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

function printLoginHint() {
  console.log('\n============================================================');
  console.log('请在已打开的浏览器中，扫码登录你自己的公众号后台');
  console.log('（mp.weixin.qq.com）。');
  console.log('');
  console.log('登录完成后，回到对话告诉我「登录好了」，我再开始下载。');
  console.log('============================================================');
}

async function main() {
  // 端口已被占用（已有远程调试浏览器在跑）→ 直接复用
  try {
    await httpGet(`http://127.0.0.1:${PORT}/json/version`);
    console.log(`端口 ${PORT} 已有开启远程调试的浏览器在运行，直接复用。`);
    printLoginHint();
    return;
  } catch (e) {
    // 继续启动新浏览器
  }

  const exe = findBrowser();
  if (!exe) {
    console.error('未检测到 Chrome / Chromium 内核浏览器，请先安装 Chrome 后重试。');
    process.exit(1);
  }
  console.log('使用浏览器：', exe);

  const userData = path.join(os.tmpdir(), 'wechat-article-cdp');
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--new-window',
    'https://mp.weixin.qq.com/'
  ];

  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    console.error('启动浏览器失败：', e.message);
    process.exit(1);
  }

  // 等待端口就绪
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await httpGet(`http://127.0.0.1:${PORT}/json/version`);
      console.log('浏览器已启动，远程调试端口', PORT);
      printLoginHint();
      return;
    } catch (e) {
      // 继续等待
    }
  }
  console.error('浏览器启动超时，请检查是否被系统拦截或手动打开 mp.weixin.qq.com 后重试。');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
