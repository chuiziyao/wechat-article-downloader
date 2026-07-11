# 锤无双丨公众号文章下载

> 作者：锤无双 ｜ 技术支持：https://chuisoft.cn ｜ 版本：1.0.0

把某个微信公众号**已发表**的文章批量备份到本地，每篇生成 **HTML + Markdown 双格式**。

## 核心方案

用 Chrome DevTools Protocol（CDP）连接本机浏览器 → 在已登录的公众号后台里抓取文章列表 → 逐篇打开文章页提取正文 → 落盘为 HTML 与 MD。

**零额外依赖**：脚本只用 Node.js 内置能力（`http` / `fs` / `child_process` / 全局 `WebSocket`），不 `npm install` 任何包。只要本机有 Chrome 或任意 Chromium 内核浏览器即可。

**安全合规**：
- 任何账号的 AppID / Secret / token **都不会写死在脚本里**，token 仅在运行时从用户已登录的浏览器会话中实时读取，绝不落盘、绝不外传。
- 本技能不绑定任何特定公众号，可对任意账号使用。

## 适用场景

- 公众号主备份自己账号的历史文章
- 把已发表文章导出为 Markdown 做二次编辑 / 归档
- 定期增量同步新发表的文章

## 浏览器探测策略（首选 Chrome，也支持其他 Chromium 内核）

`scripts/launch.js` 按以下优先级自动探测本机浏览器，找到第一个就启动：

```
Chrome → Chromium → Edge → Brave → Opera / Vivaldi → 其他 Chromium 内核
```

若端口 9223 已有开启远程调试的浏览器在运行，则直接复用，不再启动新实例。

## 使用流程（重要：必须先登录，再下载）

> ⚠️ 触发后第一步必须明确提示用户扫码登录自己的公众号后台，严禁在用户确认登录前开始下载。

### 第 1 步：启动浏览器并提示登录

```bash
node "<skill_dir>/scripts/launch.js"
```

脚本会检测浏览器 → 以远程调试端口 9223 启动（或复用已运行的）→ 打开 `https://mp.weixin.qq.com/` → 打印登录提示。

**然后必须用文字明确告诉用户：**

> "浏览器已打开并指向公众号后台。请你在浏览器里**扫码登录你自己的公众号账号**，登录完成后回复「登录好了」，我再开始下载。"

**必须停下来等待用户回复确认，收到前绝对不要运行 download.js。**

### 第 2 步：执行下载

```bash
# 默认（有历史记录则增量；首次无记录则自动全量）
node "<skill_dir>/scripts/download.js" --out <输出目录>

# 强制全量下载（用户明确说"全量下载"）
node "<skill_dir>/scripts/download.js" --out <输出目录> --mode full

# 从指定日期起下载（用户说"下载 2026-06-01 之后的"）
node "<skill_dir>/scripts/download.js" --out <输出目录> --mode since --since 2026-06-01
```

| 参数 | 说明 |
|------|------|
| `--out <dir>` | 输出目录（默认 `./公众号文章`）。每篇文章生成 `<日期>_<标题>.html` 与 `.md` |
| `--mode full` | 全量：下载后台所有已发表文章 |
| `--mode inc` | 增量（默认）：仅下载"上次最后一篇文章时间"之后的文章 |
| `--mode since` | 指定日期起：配合 `--since YYYY-MM-DD` |
| `--since YYYY-MM-DD` | since 模式下生效，下载该日期（含）之后的文章 |
| `--port <port>` | CDP 端口，默认 9223 |

### 第 3 步：汇报结果

脚本会输出"新下载 N 篇，跳过 M 篇"。把结果告诉用户即可。

## 增量逻辑（核心约定）

- **首次运行**（输出目录里没有 `.download_state.json` 状态文件）：自动执行**全量**下载。
- **后续运行**（默认不指定模式）：读取状态文件里记录的 `last_time`（上次下载到的最新一篇文章的发表时间戳），只下载 `create_time > last_time` 的文章。
- 用户明确说 **「全量下载」** → 强制 `--mode full`。
- 用户明确说 **「下载某年某月某日之后的」** → 用 `--mode since --since <日期>`。
- 每篇下载成功后会以"日期+标题"文件名去重，已存在的不会重复下载。
- 状态文件 `.download_state.json` 仅记录时间戳，**不含任何账号凭证**。

## 输出格式

每篇文章两份文件：

- `<日期>_<标题>.html`：含标题、来源账号名（自动从页面提取）、正文原文。
- `<日期>_<标题>.md`：含 YAML frontmatter（title / date / source）+ 正文转写。

## 文件结构

```
锤无双丨公众号文章下载/
├── SKILL.md                  # 技能说明（WorkBuddy 等平台加载用）
├── scripts/
│   ├── launch.js            # 浏览器探测 + 启动远程调试（无依赖）
│   └── download.js          # CDP 抓取文章并落盘（无依赖）
└── references/
    └── cdp_reference.md      # CDP 接口速查（通用，无账号信息）
```

## 工作原理

```
launch.js: 探测浏览器 → 启动 --remote-debugging-port=9223 → 打开 mp 后台
        ↓ （用户扫码登录，回复"登录好了"）
download.js:
   连接 127.0.0.1:9223
   → 从已登录页面实时读取 token
   → 调 list_ex 分页拉取已发表文章列表
   → 按模式(全量/增量/指定日期) + 文件名去重 筛选出待下载
   → 逐篇 Page.navigate 打开文章页
   → 提取 #js_content 正文 + #activity-name 标题 + #js_name 账号名
   → 写 HTML + MD
   → 更新 .download_state.json
```

## 注意事项

1. **必须先登录**：token 来自用户浏览器里的登录态，未登录时列表接口返回错误，脚本会报错退出。
2. **不要关闭浏览器**：下载过程中保持启动的浏览器窗口打开。
3. **中文路径/标题**：完全支持。
4. **零依赖**：脚本只用 Node 内置模块 + 全局 WebSocket（Node 21+ 自带）。若报 `WebSocket is not defined`，请升级 Node 到 21 以上。
5. **仅已发表文章**：拉取的是群发已发表文章；草稿箱不在范围内。
6. **凭证不落盘**：脚本不读取、不存储任何 AppSecret / token，仅运行时从浏览器会话内存读取。

## 许可

本项目基于 [MIT License](./LICENSE) 开源。
