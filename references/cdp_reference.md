# Chrome DevTools Protocol 速查（通用，无账号信息）

本技能通过 CDP 控制本机浏览器抓取公众号后台数据。以下为涉及的接口，均不绑定任何特定账号。

## 1. 启动远程调试

浏览器以如下参数启动后即可被本机脚本控制：

```
--remote-debugging-port=9223
--user-data-dir=<临时目录>
--remote-allow-origins=*
```

- 启动后访问 `http://127.0.0.1:9223/json/version` 确认可用。
- `http://127.0.0.1:9223/json` 列出所有标签页，取 `type:"page"` 的 `webSocketDebuggerUrl`。

## 2. 连接与调用

- 用 WebSocket 连接上一步拿到的 `webSocketDebuggerUrl`。
- 每个请求带自增 `id`，响应同 `id` 即对应结果；无 `id` 的是事件（如 `Runtime.consoleAPICalled`），可忽略。
- 先 `Runtime.enable`、`Page.enable` 再操作。

## 3. 常用命令

| 命令 | 作用 |
|------|------|
| `Runtime.evaluate` | 在页面执行 JS，`returnByValue:true` 取返回值；异步用 `awaitPromise:true` |
| `Page.navigate` | 跳转 URL |
| `Runtime.enable` / `Page.enable` | 开启对应域事件与能力 |

## 4. 关键 DOM 选择器（文章页）

| 选择器 | 内容 |
|--------|------|
| `#js_content` | 文章正文 HTML |
| `#activity-name` | 文章标题 |
| `#js_name` | 公众号名称 |

## 5. 后台文章列表接口（需登录态 token）

```
GET https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin={offset}&count=10&type=9&token={token}&lang=zh_CN&f=json&ajax=1
```

- `type=9`：已发表图文（群发）。
- `token` 从已登录后台页面的 URL 中 `token=` 参数实时读取，不写死。
- 返回 `app_msg_list[]`，每项含 `title` / `link` / `create_time`（Unix 秒）。
- 分页：`begin` 每次 +10，直到列表为空或不足 10 条。
- 该接口依赖登录态 Cookie，须用 `fetch(url, {credentials:"include"})` 在页面上下文发起。

## 6. 注意事项

- 未登录时接口返回 `invalid csrf token`（ret≠0），需先扫码登录。
- 列表按 `create_time` 倒序，增量下载时以"上次最新文章时间戳"为界，取 `create_time` 更大者。
- token 仅运行时内存读取，不落盘、不外传。
