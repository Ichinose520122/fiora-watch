# Fiora Watch

独立部署的双人 / 小群影院。Fiora 负责聊天入口和身份交接，影院负责播放器、同步、解析、下载和媒体库。无需访问 Fiora 的数据库，支持部署在另一台服务器。

## 已实现

- Fiora `/watch` 发出邀请，点击后通过 60 秒一次性签名票据进入对应聊天的影院。
- 放映室保留播放器、选集和聊天；片源搜索、媒体库、下载任务位于独立的「片源与下载」页面。点击视频画面可同步暂停 / 播放。
- 管理页支持 Girigirilove 番名搜索、封面和分集列表，简中 / 繁中线路分组。播放器下方选集和上下集会重新解析对应来源页。
- 选择影片后，Fiora 当前聊天的最新影院邀请原位更新为封面和标题；点击卡片进入，不重复发送邀请。需要同时更新 Fiora。
- 评论使用 Fiora 原来的聊天记录：加载最近 50 条文字消息，每 2 秒刷新；发送后写入 Fiora 并通知在线聊天客户端，撤回消息同步显示。发送失败保留草稿，同一次发送重试不会产生重复消息。
- 私聊双方可以控制播放；群聊由群主或站点管理员控制，其他成员跟随。音量、清晰度、字幕和全屏各自独立。横竖屏完整适配，全屏保留播放器菜单和同步控制。
- 放映室接入 Girigiri 使用的 Atom-Player v1.5.0 前端，播放、暂停、触屏拖动仍经过房间权限和同步接口；清晰度与字幕由现有 HLS / DASH 组件处理。全屏空闲隐藏整个控制区，视频保持完整比例。播放器初始化失败时保留原控制界面。为保持房间同步，本机倍速固定为 1。
- Fiora 当前聊天室的新文字消息显示为聊天弹幕，可在播放器中单独关闭。首次进入不刷历史，暂停、切片、后台或关闭期间不积压；撤回会移除对应弹幕。聊天仍以约 2 秒间隔同步，弹幕不会逐帧同步或随回放重复。
- 暂停、继续、拖动进度同步；服务端校验版本，避免两个人的旧操作覆盖新状态；断线暂停本机，恢复后手动开启。
- 在线：HLS / MP4 直链，以及 MacCMS JSON 播放页解析，已适配用户提供的 Girigirilove 页面格式。在线视频由浏览器直连来源，不经过影院服务器转发。
- Bilibili：普通公开视频的 BV / av / b23.tv 地址，支持读取分 P、DASH 清晰度切换及可选字幕。固定官方 API 解析；管理员可扫码绑定 B站账号，解析时使用该账号允许的清晰度和字幕。默认用户端直连，可在后台切换服务器中转，来源拒绝直连时自动回退并显示实际方式。暂不支持付费或地区受限内容、番剧、直播、课程及提前下载。
- 提前下载：管理员按线路多选或全选分集，批量排队并去重；任务串行执行，显示阶段、分段、字节数、速度、错误和缓存容量；完整下载后才进入媒体库。
- 本地：挂载目录中的 MP4 / WebM，以及下载完成的 MP4 / HLS，支持 Range 拖动播放。
- 房间和任务持久化；重启房间暂停，未完成任务标记失败并清理临时分段，可以重新提交。

## 部署

需要 Docker Compose、一个 HTTPS 域名。默认使用预构建镜像，无需在服务器安装 Node.js 或构建源码。

- 镜像：`ghcr.io/ichinose520122/fiora-watch:latest`（Linux / amd64，与 Fiora 当前镜像平台一致）。
- [Compose 文件](https://github.com/Ichinose520122/fiora-watch/blob/main/compose.yaml) · [直接下载 Compose](https://raw.githubusercontent.com/Ichinose520122/fiora-watch/main/compose.yaml) · [环境变量示例](https://github.com/Ichinose520122/fiora-watch/blob/main/.env.example)
- [镜像与标签](https://github.com/Ichinose520122/fiora-watch/pkgs/container/fiora-watch) · [构建状态](https://github.com/Ichinose520122/fiora-watch/actions/workflows/ci.yml)

首次部署可只下载配置文件，在新的部署目录中执行：

```sh
mkdir -p fiora-watch
cd fiora-watch
curl -fLO https://raw.githubusercontent.com/Ichinose520122/fiora-watch/main/compose.yaml
curl -fLO https://raw.githubusercontent.com/Ichinose520122/fiora-watch/main/.env.example
```

如果已经克隆仓库，直接在原目录继续，保持原目录和 Compose 项目名，以复用现有数据卷。创建配置并启动：

```sh
cp .env.example .env
mkdir -p library
openssl rand -hex 32
# 编辑 .env，填写真实域名及上一步生成的专用密钥。
docker compose pull
docker compose up -d
docker compose logs -f watch
```

已有 `.env` 时保留原文件，不要再次复制覆盖。GitHub 新建容器包默认为私有；如果拉取提示 `denied`，先执行 `docker login ghcr.io -u Ichinose520122`，密码输入拥有 `read:packages` 权限的个人访问令牌（classic），或在包设置中将镜像设为公开后匿名拉取。不要把令牌填入 Compose 或提交到仓库。[GitHub 容器仓库说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

以后更新，在原部署目录执行 `docker compose pull` 和 `docker compose up -d`。镜像直接写在 `compose.yaml` 的 `image: ghcr.io/ichinose520122/fiora-watch:latest`，`.env` 仅保存业务配置，不配置镜像。不要使用 `down -v`，以免删除影院数据卷。需要回滚时，在 Compose 中明确指定旧的 `sha-完整提交SHA` 标签或镜像摘要；恢复常规更新时改回 `latest`。

`main` 的代码通过测试后自动发布 `latest`、`main` 和 `sha-完整提交SHA` 标签，再用仓库 Compose 拉取发布的精确摘要并进行启动健康检查。PR 只测试，不发布镜像。自动流程不会连接或部署你的生产服务器。

需要自行构建时，在完整源码目录使用 `docker compose -f compose.yaml -f compose.build.yaml up -d --build`。

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

## B站扫码登录

从 Fiora 以站点管理员身份进入影院，打开「片源与下载」→「B站账号」→「扫码登录」，使用 Bilibili 手机客户端扫描并确认。成功后重新选择当前视频 / 分 P，播放器会从账号获准的 H.264 清晰度中自动选择。可用画质还取决于视频本身、账号权益和网络速度，登录不保证所有视频都有高画质。

绑定的账号由这台影院的房间共用，只有站点管理员可以查看状态或解除绑定。无需填写密码、复制 Cookie 或修改 Compose；登录信息加密存放在 `/data/bilibili-account.json`，使用现有 `WATCH_SHARED_SECRET` 派生专用加密密钥，重启可保留。更换密钥或登录失效后需要重新扫码；暂不自动续期。解除绑定只删除影院保存的登录信息。

凭据只发往固定的 B站官方接口和视频页，不发给视频 CDN 或其他片源，也不会通过房间状态、聊天或二维码生成服务外传。二维码由影院本地生成；未完成的二维码约 3 分钟过期。

「B站账号」页的「播放加载方式」默认用户端直连；也可选择服务器中转，保存后下次选片生效。已明确保存的服务器中转设置保留。B站账号资料解析仍由服务器完成，视频数据优先由用户浏览器直接从来源加载。直连会将当前片源的短期 CDN 地址提供给有房间权限的浏览器，不提供账号 Cookie；DASH 清单直接引用经过域名校验的官方媒体地址，不再逐个分段通过 Watch 重定向。受来源防盗链、CORS、出口 IP 和网络影响，失败时播放器自动回退到服务器加载，并持续显示实际加载方式。它不保证比服务器模式更快。新选片固定从 0 开始，不采用 B站账号观看历史；进入正在放映的房间仍跟随房间进度。

播放器字幕菜单可选择来源提供的语言或关闭字幕。字幕资料使用已绑定账号读取，正文经服务器转换为 WebVTT；未登录、来源限制、无字幕分别提示，不阻塞视频。部分 AI 字幕需要登录，并非换成国内出口就能匿名取得。

服务器中转保持背压流式转发；对已校验的公网 DNS 结果缓存 15 秒并合并并发查询，视频 Range 响应要求反向代理关闭缓冲和内容转换。实际吞吐仍取决于服务器带宽、路由和来源 CDN；这些优化不代表已经完成生产测速。

Atom 运行脚本及来源、兼容修改说明位于 `public/vendor/atom/`，未加载 Girigiri 的初始化和统计脚本。该快照的公开再分发许可尚待确认。Atom 动态生成样式需要允许内联 CSS；脚本策略仍只允许本站脚本，不开启内联 JavaScript 或 eval。

## 模式与文件

- 在线解析：打开「片源与下载」，在「在线片源」填写已适配页面 / 视频直链，点击「加载到放映室」，回到放映室播放。两个人各自点击「点击观看」，以满足浏览器声音策略。
- 搜索番剧：在「在线片源」输入番名，点封面查看分集，选择线路和集数后点击「播放选中」或「下载选中」。B站链接粘贴后可点「读取分集」选择分 P，或直接播放该地址的 `?p=` 分 P。
- 提前下载：Fiora 管理员搜索番剧或在「下载任务」粘贴 Girigirilove 番剧 / 播放页地址，读取完整分集后选择线路，勾选或全选并批量排队。相同源已排队或已完成时批量提交会复用；失败任务可重新排队。完成后从「媒体库」加载，播放流量从影院服务器发出。
- 本地媒体：把 `.mp4` / `.webm` 放到宿主机 `library/`，支持子目录；目录只读挂载，不跟随符号链接。文件应对容器 UID 1000 可读。刷新媒体库即可发现。
- 下载 HLS 保持为本地分段，不实时转码，不必合并成一个 MP4。首版下载支持有限长度、未加密、MPEG-TS 分段的 HLS；加密、分离音轨、fMP4、直播清单会明确拒绝。
- 本地库对所有成功从 Fiora 进入的用户共享，下载管理只有站点管理员可用。下载缓存与本地挂载目录分开计量。
- 缓存满时拒绝新下载，不自动删除视频。管理员可删除已下载视频；正在被房间选中的文件需先清空 / 切换。`CACHE_GB` 默认 20，单任务 `MAX_DOWNLOAD_GB` 默认 4，每批最多 100 集，待处理队列最多 200 集，任务最长两小时。来源未提供总大小时明确显示未知；HLS 按分段显示进度。

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

选片另调用 `{action:"media",title,cover,source}`，Fiora 再次检查当前用户控制权限，仅更新该聊天最新的影院邀请，并广播 `watchMedia` 更新已有卡片；没有邀请时返回 `updated:false`，不创建新消息。封面和来源仅接受无凭据的 HTTPS 链接。

修改密码或退群后，聊天接口拒绝旧授权；正在观看的页面下次聊天轮询收到拒绝时停止播放并作废对应房间会话。没有打开聊天页面的播放/管理授权不提供后台主动撤销，仍受 180 分钟上限约束。Fiora 普通退出不等于撤销影院会话，可在影院点击「退出」。角色修改也需重新进入影院更新播放/下载权限。

来源请求必须命中 `MEDIA_ALLOWED_HOSTS`，逗号分隔，支持 `*.example.com`（不包含根域名）；页面、清单、分段和所有重定向均校验。解析时只读 JSON，不执行来源脚本。下载连接将解析到的公网 IP 固定到实际连接，禁止内网 / 元数据地址。新增来源可能需要同时配置页面和 CDN 域名；此配置只允许管理员在服务器修改。

## 当前边界

- Bilibili 账号支持扫码绑定；暂不自动续期或支持通用视频网站解析器。不支持的页面会明确提示。
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
