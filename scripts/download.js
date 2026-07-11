#!/usr/bin/env node
'use strict';
// 通过 Chrome DevTools Protocol 下载公众号已发表文章为 HTML + Markdown（无额外依赖）
//
// 依赖：仅 Node.js 内置模块 + 全局 WebSocket（Node 21+ 自带）。不安装任何 npm 包。
// 安全：token 仅从已登录浏览器会话运行时读取，绝不落盘、绝不外传。不绑定任何特定账号。

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = globalThis.WebSocket;

const PORT_DEFAULT = 9223;

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const a = { out: path.join(process.cwd(), '公众号文章'), port: PORT_DEFAULT, mode: 'inc', since: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--mode') a.mode = argv[++i];
    else if (k === '--since') a.since = argv[++i];
    else if (k === '-h' || k === '--help') { printHelp(); process.exit(0); }
  }
  return a;
}

function printHelp() {
  console.log(`用法: node download.js --out <输出目录> [--mode full|inc|since] [--since YYYY-MM-DD] [--port 9223]

  --out <dir>    输出目录（默认 ./公众号文章）
  --mode full    全量下载所有已发表文章
  --mode inc     增量（默认）：仅下载上次记录时间之后的文章
  --mode since   配合 --since，下载指定日期(含)之后的文章
  --since <date> since 模式生效，格式 YYYY-MM-DD
  --port <port>  CDP 端口（默认 9223）
`);
}

// ---------- 工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(new URL(res.headers.location, url).href));
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dateStart(s) { return Math.floor(new Date(s + 'T00:00:00').getTime() / 1000); }

function sanitize(title) {
  return title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- CDP 连接 ----------
async function connectCDP(port) {
  await httpGet(`http://127.0.0.1:${port}/json/version`); // 探活
  const tabs = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json`));
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  if (!page) throw new Error('未发现可用的 page 标签页');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || e.type))));
  });

  let idc = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idc;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 调用超时: ' + method)); }
      }, 25000);
    });
  }
  return { ws, send };
}

async function evalExpr(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r && r.result && r.result.result ? r.result.result.value : null;
}

// ---------- 获取 token（运行时从已登录页面读取）----------
async function getToken(cdp) {
  let url = await evalExpr(cdp, 'location.href');
  let m = /token=(\d+)/.exec(url || '');
  if (m) return m[1];
  // 回到后台首页拿 token
  await cdp.send('Page.navigate', { url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN' });
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    url = await evalExpr(cdp, 'location.href');
    m = /token=(\d+)/.exec(url || '');
    if (m) return m[1];
  }
  return null;
}

// ---------- 分页拉取已发表文章 ----------
async function fetchAll(cdp, token) {
  const out = [];
  for (let off = 0; off < 3000; off += 10) {
    const api = `https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=${off}&count=10&type=9&query=&token=${token}&lang=zh_CN&f=json&ajax=1`;
    const expr = `(async()=>{const r=await fetch("${api}",{credentials:"include"});return await r.text();})()`;
    let data;
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      data = JSON.parse(r.result.result.value);
    } catch (e) {
      break;
    }
    const list = (data && data.app_msg_list) || [];
    if (!list.length) break;
    for (const x of list) {
      const ts = x.create_time;
      const d = new Date(ts * 1000);
      out.push({ ts, date: fmtDate(d), title: x.title, link: x.link, safe: sanitize(x.title) });
    }
    if (list.length < 10) break;
  }
  return out;
}

// ---------- HTML -> Markdown ----------
function htmlToMd(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<section[^>]*>/gi, '');
  s = s.split('</section>').join('');
  s = s.replace(/<span[^>]*>/gi, '');
  s = s.split('</span>').join('');
  s = s.replace(/<img[^>]*?(?:data-src|src)="([^"]*)"[^>]*>/gi, '![image]($1)');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ---------- 下载单篇 ----------
async function downloadOne(cdp, a, outDir) {
  const base = `${a.date}_${a.safe}`;
  if (fs.existsSync(path.join(outDir, `${base}.md`))) return 'exists';

  let content = '', title = a.title, account = '微信公众号';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cdp.send('Page.navigate', { url: a.link });
      let ok = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const has = await evalExpr(cdp, '!!document.querySelector("#js_content")');
        if (has) { ok = true; break; }
      }
      if (!ok) continue;
      const cd = await cdp.send('Runtime.evaluate', {
        expression: '(()=>{const c=document.querySelector("#js_content")?.innerHTML||"";const t=document.querySelector("#activity-name")?.innerText?.trim()||"";const n=document.querySelector("#js_name")?.innerText?.trim()||"";return JSON.stringify({title:t,content:c,account:n});})()',
        returnByValue: true
      });
      const jd = JSON.parse(cd.result.result.value);
      title = jd.title || a.title;
      content = jd.content || '';
      account = jd.account || '微信公众号';
      if (content) break;
    } catch (e) {
      // 重试
    }
  }
  if (!content) return 'skip';

  const realBase = `${a.date}_${sanitize(title)}`;
  if (fs.existsSync(path.join(outDir, `${realBase}.md`))) return 'exists';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{max-width:680px;margin:0 auto;padding:10px;font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;line-height:1.8;color:#333}img{max-width:100%;height:auto}</style></head><body><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(account)} · ${a.date}</div>${content}</body></html>`;
  fs.writeFileSync(path.join(outDir, `${realBase}.html`), html, 'utf8');

  let md = `---\ntitle: "${title.replace(/"/g, '\\"')}"\ndate: ${a.date}\nsource: ${account}\n---\n\n# ${title}\n\n> 发表于 ${a.date} | 来源：${account}\n\n`;
  md += htmlToMd(content);
  fs.writeFileSync(path.join(outDir, `${realBase}.md`), md, 'utf8');
  return 'ok';
}

// ---------- 状态文件 ----------
function loadState(outDir) {
  const f = path.join(outDir, '.download_state.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
  }
  return {};
}
function saveState(outDir, st) {
  fs.writeFileSync(path.join(outDir, '.download_state.json'), JSON.stringify(st, null, 2), 'utf8');
}

// ---------- 主流程 ----------
async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('当前 Node 版本不支持全局 WebSocket，请升级到 Node 21 以上。');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.out, { recursive: true });

  const cdp = await connectCDP(args.port);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const token = await getToken(cdp);
  if (!token) {
    console.error('未能从浏览器会话中获取 token。请确认你已在浏览器中扫码登录公众号后台（mp.weixin.qq.com），然后重试。');
    process.exit(1);
  }
  console.log('已连接到公众号后台，登录态有效。');

  const published = await fetchAll(cdp, token);
  console.log(`后台已发表文章共 ${published.length} 篇`);

  const state = loadState(args.out);
  let mode = args.mode;
  if (mode === 'inc' && !state.last_time) mode = 'full'; // 首次无记录 → 全量
  if (args.since) mode = 'since';

  let toDownload = [];
  if (mode === 'full') {
    toDownload = published;
  } else if (mode === 'since') {
    const sinceTs = dateStart(args.since);
    toDownload = published.filter((a) => a.ts >= sinceTs);
  } else {
    const lt = state.last_time || 0;
    toDownload = published.filter((a) => a.ts > lt);
  }

  const existing = new Set(fs.readdirSync(args.out));
  toDownload = toDownload.filter((a) => !existing.has(`${a.date}_${a.safe}.md`));

  console.log(`本次模式：${mode}；待下载 ${toDownload.length} 篇`);
  let ok = 0, skip = 0;
  for (let i = 0; i < toDownload.length; i++) {
    const a = toDownload[i];
    process.stdout.write(`[${i + 1}/${toDownload.length}] ${a.date} ${a.title.slice(0, 40)} ... `);
    const r = await downloadOne(cdp, a, args.out);
    if (r === 'ok') { ok++; console.log('OK'); }
    else if (r === 'exists') { skip++; console.log('EXISTS'); }
    else { skip++; console.log('SKIP(空内容)'); }
  }

  if (published.length) {
    saveState(args.out, {
      last_time: published[0].ts,
      last_date: published[0].date,
      last_title: published[0].title,
      updated_at: new Date().toISOString()
    });
  }

  console.log(`\n完成。新下载 ${ok} 篇，跳过 ${skip} 篇。`);
  cdp.ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('出错：', e.message || e);
  process.exit(1);
});
