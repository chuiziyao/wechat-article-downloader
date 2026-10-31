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
  const a = { out: path.join(process.cwd(), '公众号文章下载'), port: PORT_DEFAULT, mode: 'inc', since: null };
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
  console.log(`用法: node download.js --out <输出根目录> [--mode full|inc|since] [--since YYYY-MM-DD] [--port 9223]

输出结构（--out 为根目录，自动创建）:
  <root>/公众号文章/   正式图文文章（HTML + Markdown + 索引）
  <root>/公众号贴图/   贴图号图文（系统二创，单独存放，避免内容混杂）
  <root>/.download_state.json

  --out <dir>    输出根目录（默认 ./公众号文章下载）
  --mode full    全量下载所有已发表内容
  --mode inc     增量（默认）：仅下载上次记录时间之后的内容
  --mode since   配合 --since，下载指定日期(含)之后的内容
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

// ---------- 分页拉取「发表记录」（发布/群发全量，补充 type=9 之外的"仅发布"文章）----------
// 注意：该接口不返回 create_time，日期需在打开文章页后从 #publish_time 提取（downloadOne 内回填）
async function fetchPublishRecords(cdp, token) {
  const out = [];
  const seen = new Set();
  for (let off = 0; off < 300; off += 10) {
    const api = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&search_field=null&begin=${off}&count=10&query_fake=1&token=${token}&lang=zh_CN&f=json&ajax=1`;
    const expr = `(async()=>{const r=await fetch("${api}",{credentials:"include"});return await r.text();})()`;
    let data;
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      data = JSON.parse(r.result.result.value);
    } catch (e) { break; }
    if (!data || !data.publish_page) break;
    let pp;
    try { pp = JSON.parse(data.publish_page); } catch (e) { break; }
    const list = (pp.publish_list || []);
    if (!list.length) break;
    for (const item of list) {
      let info;
      try { info = JSON.parse(item.publish_info); } catch (e) { continue; }
      for (const a of (info.appmsg_info || [])) {
        if (!a.content_url || a.is_deleted) continue;
        if (seen.has(a.content_url)) continue;
        seen.add(a.content_url);
        out.push({ ts: null, date: null, title: a.title, link: a.content_url, safe: sanitize(a.title) });
      }
    }
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
// dirs = { article: 文章目录, tuitu: 贴图目录 }
// 贴图号图文（系统把已发表文章二创成贴图，合集多为「无双快讯」）单独落盘到贴图目录，
// 与正式文章分开存放，避免索引内容混杂。
const TUITU_MARKERS = ['无双快讯', '更多名称已清空', '微信扫一扫赞赏作者'];

async function downloadOne(cdp, a, dirs) {
  const base = a.date ? `${a.date}_${a.safe}` : null;
  if (base && (fs.existsSync(path.join(dirs.article, `${base}.md`)) || fs.existsSync(path.join(dirs.tuitu, `${base}.md`)))) return 'exists';

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
        expression: '(()=>{const c=document.querySelector("#js_content")?.innerHTML||"";const t=document.querySelector("#activity-name")?.innerText?.trim()||"";const n=document.querySelector("#js_name")?.innerText?.trim()||"";const p=document.querySelector("#publish_time")?.innerText?.trim()||"";return JSON.stringify({title:t,content:c,account:n,ptime:p});})()',
        returnByValue: true
      });
      const jd = JSON.parse(cd.result.result.value);
      title = jd.title || a.title;
      content = jd.content || '';
      account = jd.account || '微信公众号';
      // 「发表记录」来源的文章无 date，从文章页 #publish_time 回填。
      // 页面时间可能是：绝对("2026年10月04日 08:00")、无年份("10月09日")、相对("今天 08:00"/"昨天"/"前天"/"3天前")。
      if (!a.date) {
        const now = new Date();
        const pt = jd.ptime || '';
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        let pm = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(pt);
        if (pm) {
          a.date = `${pm[1]}-${pad(parseInt(pm[2], 10))}-${pad(parseInt(pm[3], 10))}`;
        } else if (/^今天/.test(pt)) {
          a.date = fmt(now);
        } else if (/^昨天/.test(pt)) {
          a.date = fmt(new Date(now.getTime() - 86400000));
        } else if (/^前天/.test(pt)) {
          a.date = fmt(new Date(now.getTime() - 2 * 86400000));
        } else if ((pm = /(\d+)天前/.exec(pt))) {
          a.date = fmt(new Date(now.getTime() - parseInt(pm[1], 10) * 86400000));
        } else {
          const pm2 = /(\d{1,2})月(\d{1,2})日/.exec(pt);
          if (pm2) {
            let y = now.getFullYear();
            const d = new Date(y, parseInt(pm2[1], 10) - 1, parseInt(pm2[2], 10));
            if (d > now) y -= 1;
            a.date = `${y}-${pad(parseInt(pm2[1], 10))}-${pad(parseInt(pm2[2], 10))}`;
          } else {
            a.date = fmtDate(now);
          }
        }
      }
      if (content) break;
    } catch (e) {
      // 重试
    }
  }
  if (!content) return 'skip';

  // 贴图判定：标题或正文含合集标记，或带贴图页模板残留
  const isTuitu = TUITU_MARKERS.some((m) => title.includes(m) || content.includes(m));
  const targetDir = isTuitu ? dirs.tuitu : dirs.article;

  const realBase = `${a.date}_${sanitize(title)}`;
  if (fs.existsSync(path.join(targetDir, `${realBase}.md`))) return 'exists';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{max-width:680px;margin:0 auto;padding:10px;font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;line-height:1.8;color:#333}img{max-width:100%;height:auto}</style></head><body><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(account)} · ${a.date}</div>${content}</body></html>`;
  fs.writeFileSync(path.join(targetDir, `${realBase}.html`), html, 'utf8');

  let md = `---\ntitle: "${title.replace(/"/g, '\\"')}"\ndate: ${a.date}\nsource: ${account}\n---\n\n# ${title}\n\n> 发表于 ${a.date} | 来源：${account}\n\n`;
  md += htmlToMd(content);
  fs.writeFileSync(path.join(targetDir, `${realBase}.md`), md, 'utf8');
  return isTuitu ? 'tuitu' : 'ok';
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
  const dirs = {
    article: path.join(args.out, '公众号文章'),
    tuitu: path.join(args.out, '公众号贴图'),
  };
  fs.mkdirSync(dirs.article, { recursive: true });
  fs.mkdirSync(dirs.tuitu, { recursive: true });

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

  // 「发表记录」（发布/群发全量）全部并入候选，由文件名去重兜底
  const publishRecords = await fetchPublishRecords(cdp, token);
  console.log(`「发表记录」接口补充 ${publishRecords.length} 篇候选（含仅"发布"不占群发的文章）`);

  // 注意：群发列表(type=9)的标题被微信截断(约30字)，发表记录接口返回完整标题。
  // 去重规则：完整标题相等（不限长度） OR 任一方是另一方的前缀（阈值20字防误判）。
  // 查重范围 = 文章目录 + 贴图目录 + 根目录下的存档目录（_重复存档，兼容历史结构）。
  // 贴图与重复内容不查档会每次下载都被重新拉进候选、反复回流（2026-10-31 教训）。
  const stripDate = (n) => n.replace(/\.md$/, '').replace(/^\d{4}-\d{1,2}-\d{1,2}_/, '');
  const listTitles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map(stripDate) : [];
  const knownTitles = [dirs.article, dirs.tuitu, path.join(args.out, '_重复存档')].flatMap(listTitles);
  const knownFiles = [...fs.readdirSync(dirs.article), ...fs.readdirSync(dirs.tuitu)];
  toDownload = toDownload.filter((a) => a.date && !knownFiles.includes(`${a.date}_${a.safe}.md`));
  const extra = publishRecords.filter((a) => !knownTitles.some((t) => a.safe === t || (t.length >= 20 && a.safe.startsWith(t)) || (a.safe.length >= 20 && t.startsWith(a.safe))));
  toDownload = toDownload.concat(extra);

  console.log(`本次模式：${mode}；待下载 ${toDownload.length} 篇`);
  let ok = 0, skip = 0, tuitu = 0;
  for (let i = 0; i < toDownload.length; i++) {
    const a = toDownload[i];
    process.stdout.write(`[${i + 1}/${toDownload.length}] ${a.date} ${a.title.slice(0, 40)} ... `);
    const r = await downloadOne(cdp, a, dirs);
    if (r === 'ok') { ok++; console.log('OK(文章)'); }
    else if (r === 'exists') { skip++; console.log('EXISTS'); }
    else if (r === 'tuitu') { tuitu++; console.log('OK(贴图)'); }
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

  console.log(`\n完成。新下载文章 ${ok} 篇、贴图 ${tuitu} 篇，跳过 ${skip} 篇。`);
  console.log(`文章目录: ${dirs.article}`);
  console.log(`贴图目录: ${dirs.tuitu}`);
  cdp.ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('出错：', e.message || e);
  process.exit(1);
});
