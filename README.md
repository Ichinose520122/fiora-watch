# Fiora Watch

独立部署的双人 / 小群影院。Fiora 负责聊天入口和身份交接，影院负责播放器、同步、解析、下载和媒体库。无需访问 Fiora 的数据库，支持部署在另一台服务器。

## 已实现

- Fiora `/watch` 发出邀请，点击后通过 60 秒一次性签名票据进入对应聊天的影院。
- 放映室只保留播放器和聊天；片源、媒体库、下载任务位于独立的「片源与下载」页面。
- 评论使用 Fiora 原来的聊天记录：加载最近 50 条文字消息，每 2 秒刷新；发送后写入 Fiora 并通知在线聊天客户端，撤回消息同步显示。发送失败保留草稿，同一次发送重试不会产生重复消息。
- 私聊双方可以控制播放；群聊由群主或站点管理员控制，其他成员跟随。音量和全屏各自独立。
- 暂停、继续、拖动进度同步；服务端校验版本，避免两个人的旧操作覆盖新状态；断线暂停本机，恢复后手动开启。
- 在线：HLS / MP4 直链，以及 MacCMS JSON 播放页解析，已适配用户提供的 Girigirilove 页面格式。在线视频由浏览器直连来源，不经过影院服务器转发。
- 提前下载：管理员提交任务，单任务串行执行；取消、失败说明、进度和缓存容量；完整下载后才进入媒体库。
- 本地：挂载目录中的 MP4 / WebM，以及下载完成的 MP4 / HLS，支持 Range 拖动播放。
- 房间和任务持久化；重启房间暂停，未完成任务标记失败并清理临时分段，可以重新提交。

## 部署

需要 Docker Compose、一个 HTTPS 域名。首次先从源码构建；CI 会验证镜像，不自动发布或部署生产环境。

```sh
cp .env.example .env
mkdir -p library
openssl rand -hex 32
# 编辑 .env，填写真实域名及上一步生成的专用密钥。
docker compose up -d --build
docker compose logs -f watch
```

`WATCH_PUBLIC_URL` 填影院公开地址，`FIORA_ORIGIN` 填 Fiora 地址，均为域名根路径，例如 `https://watch.example.com`。不支持安装在 `/watch` 子路径。两端时钟应同步。

宿主机 Caddy 示例：

```caddy
watch.example.com {
    reverse_proxy 127.0.0.1:9300
}
```

如果 Caddy 也在容器里，把两个容器接入同一 Docker 网络，代理到 `watch:9300`；不要使用 Caddy 容器自己的 `127.0.0.1`。Nginx 对 `/api/events` 需关闭代理缓冲并允许长连接。

在 Fiora 的 `.env` 中配置：

```dotenv
WATCH_SERVER_URL=https://watch.example.com
WATCH_SHARED_SECRET=与影院完全相同的专用密钥
```

Fiora 的 Compose 自动传入 `WatchIssuer=https://${FIORA_DOMAIN}`。非 Compose 部署使用 `WatchServerUrl`、`WatchIssuer`、`WatchSharedSecret` 环境变量。更新 Fiora 后重建 / 重启容器，再在聊天输入 `/watch` 或 `/watch 视频地址`。地址只预填，进入影院后再选择视频，不会因别人点击旧邀请而覆盖正在看的内容。

## 模式与文件

- 在线解析：打开「片源与下载」，在「在线片源」填写已适配页面 / 视频直链，点击「加载到放映室」，回到放映室播放。两个人各自点击「点击观看」，以满足浏览器声音策略。
- 提前下载：Fiora 管理员在独立管理页的「下载任务」提交地址。完成后从「媒体库」加载，播放流量从影院服务器发出。
- 本地媒体：把 `.mp4` / `.webm` 放到宿主机 `library/`，支持子目录；目录只读挂载，不跟随符号链接。文件应对容器 UID 1000 可读。刷新媒体库即可发现。
- 下载 HLS 保持为本地分段，不实时转码，不必合并成一个 MP4。首版下载支持有限长度、未加密、MPEG-TS 分段的 HLS；加密、分离音轨、fMP4、直播清单会明确拒绝。
- 本地库对所有成功从 Fiora 进入的用户共享，下载管理只有站点管理员可用。下载缓存与本地挂载目录分开计量。
- 缓存满时拒绝新下载，不自动删除视频。管理员可删除已下载视频；正在被房间选中的文件需先清空 / 切换。`CACHE_GB` 默认 20，单任务 `MAX_DOWNLOAD_GB` 默认 4，队列最多 10 个，任务最长两小时。

## 接入约定

Fiora 通过现有 Socket 登录检查与聊天成员校验后签发：

```text
BASE64URL(JSON payload) + "." + BASE64URL(HMAC-SHA256(body, WATCH_SHARED_SECRET))
```

Payload：`v=1, iss, aud, iat, exp, jti, sub, name, avatar, room, canControl, admin, chatGrant`。`sub` 为用户 ID，`room` 为聊天 ID，`exp-iat=60` 秒，`jti` 为 16 字节随机值的十六进制。普通用户不能自行指定权限。

跳转 `https://watch.example.com/#ticket=...`，影院立即清除 fragment，用同源 POST 换取 HttpOnly / SameSite=Strict 会话 Cookie。票据不会写入聊天记录或 URL 查询参数；已使用的票据持久化，重启后也不能再次使用。共享密钥独立于 Fiora JWT 密钥。

影院会话和聊天授权均为 **180 分钟**，到期从 Fiora 重新进入。每个房间单独授权，同浏览器可打开多个房间；重启影院会使所有影院会话失效。60 秒只用于一次性跳转票据，不限制观看时长。

`chatGrant` 是专用于当前用户、当前聊天的 HMAC 凭据，含 `purpose=watch-chat`、`sub`、`room`、`tokenVersion`、`iat`、`exp`，最长 180 分钟。换取会话后仅保存在 Watch 服务端内存，不通过状态接口返回，也不使用 Fiora 的通用登录 token。

Watch 服务端调用 `FIORA_ORIGIN/api/watch/chat`，使用 `Authorization: Bearer <chatGrant>`，POST `{action:"read"}` 或 `{action:"send",content,requestId}`。Fiora 每次检查 tokenVersion、封禁状态和当前成员资格；发送沿用原消息流程、禁言规则和消息广播，按唯一 requestId 去重。评论始终按文字处理，不执行 `/watch` 等命令。必须同时更新 Fiora 和 Watch 才能使用聊天；旧 Fiora 会显示升级提示，且跨服务器部署时 Watch 必须能通过 HTTPS 访问此接口。

修改密码或退群后，聊天接口拒绝旧授权；正在观看的页面下次聊天轮询收到拒绝时停止播放并作废对应房间会话。没有打开聊天页面的播放/管理授权不提供后台主动撤销，仍受 180 分钟上限约束。Fiora 普通退出不等于撤销影院会话，可在影院点击「退出」。角色修改也需重新进入影院更新播放/下载权限。

来源请求必须命中 `MEDIA_ALLOWED_HOSTS`，逗号分隔，支持 `*.example.com`（不包含根域名）；页面、清单、分段和所有重定向均校验。解析时只读 JSON，不执行来源脚本。下载连接将解析到的公网 IP 固定到实际连接，禁止内网 / 元数据地址。新增来源可能需要同时配置页面和 CDN 域名；此配置只允许管理员在服务器修改。

## 当前边界

- 尚未接入 Bilibili 账号或通用视频网站解析器；不支持的页面会明确提示，不会假装解析成功。
- 在线模式依赖来源的 CORS、有效期、用户网络与浏览器编码支持。不提供通用代理，也不保证所有 MP4 / WebM 编码都能播放。
- 同步通过 SSE 广播房间状态，浏览器偏差超过约 1.2 秒时校正。不是逐帧同步，也不自动因某一方缓冲而暂停全房间。
- 使用单进程 JSON 持久化，适合两个人 / 小群。不要让多个实例同时写同一个数据卷。
- 默认容器限制 512 MB / 1 CPU，无实时转码。大媒体库、更多用户或大量任务应另行压测。

## 开发与测试

Node.js 24，pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm test
# 设置 WATCH_SHARED_SECRET 至少 32 字符；开发地址可用 localhost HTTP。
pnpm start
```

测试覆盖票据签名 / 过期 / 重放、180 分钟会话、房间权限与同步冲突、聊天凭据隔离与权限失效、SSRF 地址拒绝、下载配额与失败清理、持久化恢复、媒体 Range 请求。真实来源和浏览器兼容性需按部署网络复核。
