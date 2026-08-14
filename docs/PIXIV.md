# Pixiv 数据源 403 说明与代理方案

## 现象
运行历史里出现：
```
[Pixiv 日榜] 拉取失败: HTTP 403 for https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json&p=1
```
其他源（如 Safebooru）正常，只有 Pixiv 报 403。

## 根本原因：是 IP 被封，不是缺 cookie
实测把 `ranking.php` 这个榜单接口从普通 IP 直接请求：

| 请求方式 | 结果 |
|---|---|
| 只带 `Referer: https://www.pixiv.net/`（和现有代码一致） | 200 |
| 浏览器 UA + Referer + X-Requested-With | 200 |
| **完全不带任何头、不带 cookie** | 200 |
| 用 worker 那个 `acg-rank-pusher/0.1` 的 UA | 200 |

结论：`ranking.php?mode=daily&content=illust&format=json`（全年龄日榜）是**公开接口**，不需要登录、cookie、特殊 UA 或 Referer。

**403 只发生在 Worker 上**，因为 Worker 从 **Cloudflare 出口 IP** 发起请求，而 **Pixiv 封禁 Cloudflare / 数据中心 IP**。
- 所以：**写 cookie 没用**——请求依然来自被封的 Cloudflare IP，照样 403；而且这个榜单本来也不需要登录。
- 这与本项目 QQ 官方回调遇到的问题同类：都是「Cloudflare 出口 IP 不被对方接受」。

## 需要代理哪个接口
只有 **1 个 API** 需要代理：
```
GET https://www.pixiv.net/ranking.php?mode=<daily|weekly|monthly>&content=illust&format=json&p=1
```
- 返回 JSON：`{ "contents": [ { "illust_id", "title", "user_name", "url", "tags", "rank", "illust_content_type", ... } ] }`
- 请求头可带 `Referer: https://www.pixiv.net/`（带不带都能通，公开接口）。

> 图片本身（`i.pximg.net`，有防盗链）是**另一回事**，已由 `PIXIV_PROXY_HOST` 反代处理，和本文的 API 403 无关。

## 修复方案：给榜单 API 加反代
需要一台 **Pixiv 不封的 IP** 的机器（能在浏览器正常打开 pixiv.net 的机器基本就行；日本/新加坡等地的 VPS 通常可以，国内住宅 IP 不一定稳）。在上面架一个反向代理，把 `ranking.php` 转发到 Pixiv。

nginx 示例：
```nginx
location = /ranking.php {
    proxy_pass https://www.pixiv.net/ranking.php$is_args$args;
    proxy_set_header Host www.pixiv.net;
    proxy_set_header Referer https://www.pixiv.net/;
    proxy_ssl_server_name on;
}
```

然后在**后台「🔑 密钥凭证」里配置 `PIXIV_API_BASE`**（我已在代码里加好这个开关）：
- 填你的反代地址，例如 `https://your-proxy.example.com`
- 代码会自动请求 `PIXIV_API_BASE/ranking.php?...`；**留空则直连 www.pixiv.net**（即当前会 403 的行为）。

## 注意
- `PIXIV_API_BASE`（榜单 API 反代）和 `PIXIV_PROXY_HOST`（图片反代）是两件事，可用同一台机器的不同路径，也可分开。
- 代理机的 IP 必须 Pixiv 不封，否则等于把 403 换个地方。
- 不想弄代理：把「Pixiv 日榜」这个数据源在后台停用即可，用 Safebooru 等 booru 源，不影响其他功能。
