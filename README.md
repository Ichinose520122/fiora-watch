# Fiora Watch

独立部署的双人 / 小群影院。Fiora 负责聊天入口和身份交接，影院负责播放器、同步、解析、下载和媒体库。无需访问 Fiora 的数据库，支持部署在另一台服务器。

## 功能

- Fiora `/watch` 发出邀请，点击后通过 60 秒一次性签名票据进入对应聊天的影院。
- 放映室保留播放器、选集和聊天；片源搜索、媒体库、下载任务和播放设置位于独立的「媒体中心」。界面采用石墨灰与青绿色，支持桌面及手机布局。点击视频画面可同步暂停 / 播放。
- 管理页支持 Girigirilove 番名搜索、封面和分集列表，简中 / 繁中线路分组。播放器下方选集和上下集会重新解析对应来源页。
- 选择影片后，Fiora 当前聊天的最新影院邀请原位更新为封面和标题；点击卡片进入，不重复发送邀请。需要同时更新 Fiora。
- 评论使用 Fiora 原来的聊天记录：加载最近 50 条文字消息，每 2 秒刷新；发送后写入 Fiora 并通知在线聊天客户端，撤回消息同步显示。发送失败保留草稿，同一次发送重试不会产生重复消息。
- 私聊双方可以控制播放；群聊由群主或站点管理员控制，其他成员跟随。音量、清晰度、字幕和全屏各自独立。提供横竖屏布局，全屏保留播放器菜单和同步控制。
- 放映室接入 Girigiri 使用的 Atom-Player v1.5.0 前端，播放、暂停、触屏拖动仍经过房间权限和同步接口；清晰度与字幕由现有 HLS / DASH 组件处理。全屏空闲隐藏整个控制区，视频保持完整比例。播放器初始化失败时保留原控制界面。为保持房间同步，本机倍速固定为 1。
- Fiora 当前聊天室的新文字消息显示为聊天弹幕，可在播放器中单独关闭。首次进入不回放历史弹幕，暂停、切片、后台或关闭期间不累积弹幕；撤回会移除对应弹幕。聊天仍以约 2 秒间隔同步，弹幕不会逐帧同步或随回放重复。
- 暂停、继续、拖动进度同步；服务端校验版本，防止旧操作覆盖新的房间状态。选片后从头自动播放，加入和重连跟随房间状态，不启动已经暂停的房间。浏览器禁止有声自动播放时先尝试静音，点击「开启声音」恢复声音；若静音播放也被禁止，才显示手动观看按钮。
- 在线：HLS / MP4 直链、MacCMS JSON 播放页，以及 Girigirilove 新版详情与播放地址。Girigirilove 搜索和分集通过站点公开接口读取，保留线路与集数选择，兼容旧版保存链接。所有受支持的在线片源均可选择浏览器直连或服务器中继。
- Bilibili：普通公开视频的 BV / av / b23.tv 地址，支持读取分 P、DASH 清晰度切换及可选字幕。固定官方 API 解析；管理员可扫码绑定 B站账号，解析时使用该账号允许的清晰度和字幕。默认用户端直连，可在后台切换服务器中转，来源拒绝直连时自动回退并显示实际方式。暂不支持付费或地区受限内容、番剧、直播、课程及提前下载。
- 提前下载：管理员按线路多选或全选分集，批量排队并去重；任务串行执行，显示进度、阶段、分段、已下载大小、近期速度、预计剩余时间和缓存容量。来源总大小未知时不估算剩余时间，HLS 按分段显示进度；完整下载后才进入媒体库。
- 本地：挂载目录中的 MP4 / WebM，以及下载完成的 MP4 / HLS，支持 Range 拖动播放。媒体库按番剧分组，支持筛选、多选及批量删除已下载媒体；只读挂载文件与正在被房间使用的媒体不可删除。
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

已有源码部署应沿用原目录和 Compose 项目名，以复用现有数据卷。以下配置复制命令仅用于首次部署；已有 `.env` 时应保留原文件。创建配置并启动：

```sh
cp .env.example .env
mkdir -p library
openssl rand -hex 32
# 编辑 .env，填写真实域名及上一步生成的专用密钥。
docker compose pull
docker compose up -d
docker compose logs -f watch
```

镜像拉取提示 `denied` 时，应核对容器包的可见性及访问权限。私有包可执行 `docker login ghcr.io -u Ichinose520122`，密码输入拥有 `read:packages` 权限的个人访问令牌（classic），或在包设置中将镜像设为公开后匿名拉取。不要把令牌填入 Compose 或提交到仓库。[GitHub 容器仓库说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

更新时，在原部署目录执行 `docker compose pull` 和 `docker compose up -d`。镜像直接写在 `compose.yaml` 的 `image: ghcr.io/ichinose520122/fiora-watch:latest`，`.env` 仅保存业务配置，不配置镜像。不要使用 `down -v`，以免删除影院数据卷。需要回滚时，在 Compose 中明确指定旧的 `sha-完整提交SHA` 标签或镜像摘要；恢复常规更新时改回 `latest`。

`main` 的代码通过测试后自动发布 `latest`、`main` 和 `sha-完整提交SHA` 标签，并使用仓库 Compose 执行启动健康检查。当前 Compose 固定引用 `latest`，该检查未绑定本次构建的精确镜像摘要。PR 仅执行测试，不发布镜像；生产服务器需单独执行更新。

需要自行构建时，在完整源码目录使用 `docker compose -f compose.yaml -f compose.build.yaml up -d --build`。

`WATCH_PUBLIC_URL` 填影院公开地址，`FIORA_ORIGIN` 填 Fiora 地址，均为域名根路径，例如 `https://watch.example.com`。不支持安装在 `/watch` 子路径。两端时钟应同步。

主要配置项如下：

| 变量 | 用途 | 默认值或要求 |
| --- | --- | --- |
| `WATCH_PUBLIC_URL` | 影院公开地址，同时用于票据接收者与请求来源校验 | 生产环境使用 HTTPS 根地址 |
| `FIORA_ORIGIN` | Fiora 公开地址，同时用于票据签发者校验及聊天桥接 | 与 Fiora 的 `WatchIssuer` 一致 |
| `WATCH_SHARED_SECRET` | 票据和聊天凭据签名、Bilibili 账号加密密钥派生 | 至少 32 字符，两端一致，不复用 Fiora JWT 密钥 |
| `WATCH_PORT` | Compose 映射到宿主机回环地址的端口 | `9300`；容器内端口保持 9300 |
| `MEDIA_ALLOWED_HOSTS` | 通用片源请求允许的域名 | `ani.girigirilove.com,akua.girigirilove.com` |
| `CACHE_GB` | 下载缓存总配额 | `20`，按 GiB 计算 |
| `MAX_DOWNLOAD_GB` | 单个下载任务的容量上限 | `4`，按 GiB 计算 |

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

Fiora 的 Compose 自动传入 `WatchIssuer=https://${FIORA_DOMAIN}`。非 Compose 部署使用 `WatchServerUrl`、`WatchIssuer`、`WatchSharedSecret` 环境变量。修改 Fiora 环境变量后重建容器以应用配置，再在聊天输入 `/watch` 或 `/watch 视频地址`。地址只预填，进入影院后再选择视频，不会因别人点击旧邀请而覆盖正在看的内容。

## B站扫码登录

从 Fiora 以站点管理员身份进入影院，打开「媒体中心」→「B站账号」→「扫码登录」，使用 Bilibili 手机客户端扫描并确认。成功后重新选择当前视频 / 分 P，播放器会从账号获准的 H.264 清晰度中自动选择。可用画质还取决于视频本身、账号权益和网络速度，登录不保证所有视频都有高画质。

绑定的账号由这台影院的房间共用，只有站点管理员可以查看状态或解除绑定。无需填写密码、复制 Cookie 或修改 Compose；登录信息加密存放在 `/data/bilibili-account.json`，使用现有 `WATCH_SHARED_SECRET` 派生专用加密密钥，重启可保留。更换密钥或登录失效后需要重新扫码；暂不自动续期。解除绑定只删除影院保存的登录信息。

凭据只发往固定的 B站官方接口和视频页，不发给视频 CDN 或其他片源，也不会通过房间状态、聊天或二维码生成服务外传。二维码由影院本地生成；未完成的二维码约 3 分钟过期。

B站账号资料解析由服务器完成。直连会将当前片源的短期 CDN 地址提供给有房间权限的浏览器，不提供账号 Cookie；DASH 清单直接引用经过域名校验的官方媒体地址。新选片固定从 0 开始，不采用 B站账号观看历史；进入正在放映的房间仍跟随房间进度。

播放器字幕菜单可选择来源提供的语言或关闭字幕。字幕资料使用已绑定账号读取，正文经服务器转换为 WebVTT；未登录、来源限制、无字幕分别提示，不阻塞视频。部分 AI 字幕需要账号登录，网络出口位置不替代账号权限。

## 播放方式

管理员在「媒体中心」→「播放设置」选择「浏览器直连」或「服务器中继」。设置适用于所有受支持的在线 HLS / MP4 片源与 Bilibili，下次选择影片时生效；本地媒体仍由影院服务器提供。升级时保留旧版已保存的 B站播放方式，并将其作为全站设置。

默认使用浏览器直连；因来源跨域或网络限制加载失败时，播放器自动尝试服务器中继，并显示实际加载方式。明确选择服务器中继后，媒体请求始终经影院服务器，不自动回退直连。中继仍受来源可用性、允许域名、服务器出口及带宽限制，不解除来源的访问权限要求。

通用中继支持普通 HLS 分段、主 / 子清单、多音轨、AES-128 密钥、fMP4 初始化片段、BYTERANGE 及 MP4 Range 请求。HLS 变量替换、Content Steering 和未知 URI 扩展会明确拒绝；不提供完整 LL-HLS 阻塞重载语义。中继与提前下载使用不同的格式处理流程，中继支持的格式不代表可提前下载。

HLS 清单解压后最多 2 MiB、单份清单最多 16384 个资源地址，单个资源 URL 最多 4096 字符。资源令牌绑定房间与当前影片版本，并使用进程内密钥加密验证；服务重启后需刷新播放页以重新读取清单。中继同时请求上限为全局 256、每房间 24，换片、退出或请求断开时取消对应上游传输。

服务器中继保持背压流式转发；对已校验的公网 DNS 结果缓存 15 秒并合并并发查询，视频 Range 响应要求反向代理关闭缓冲和内容转换。清单、分段与密钥均校验来源域名和公网地址，不向片源传递浏览器 Cookie 或 B站账号凭据。实际吞吐仍取决于服务器带宽、路由和来源 CDN；生产吞吐需在实际部署环境中测量。

Atom 运行脚本及来源、兼容修改说明位于 `public/vendor/atom/`，未加载 Girigiri 的初始化和统计脚本。该快照的公开再分发许可尚待确认。Atom 动态生成样式需要允许内联 CSS；脚本策略仍只允许本站脚本，不开启内联 JavaScript 或 eval。

播放器脚本、样式及本站公开图片 / 字体使用内容版本地址，浏览器可缓存一年，未变化时直接使用本地缓存；资源内容更新会自动更换地址，无需手动清除缓存。JS / CSS / SVG 同时支持 Brotli / gzip 压缩；未带版本号的旧地址保留 ETag 校验。HLS / DASH 播放组件按片源需要加载并共享同一资源版本；支持 MediaSource 的浏览器保留 HLS 清晰度切换，其他兼容浏览器使用原生 HLS。HTML、接口、字幕与视频继续使用各自现有的鉴权及缓存规则；第三方封面按图片来源返回的缓存规则处理。

## 模式与文件

- 在线解析：打开「媒体中心」→「发现影片」，填写已适配页面 / 视频直链，点击「立即播放」，回到放映室自动跟随播放。若浏览器要求手动开启声音，播放器会显示提示。
- 搜索番剧：在「发现影片」输入番名，点封面查看分集，选择线路和集数后点击「播放当前集」或「下载当前集」。B站链接粘贴后可点「读取分集」选择分 P，或直接播放该地址的 `?p=` 分 P。
- 提前下载：Fiora 管理员搜索番剧或在「下载任务」粘贴 Girigirilove 番剧 / 播放页地址，读取完整分集后选择线路，勾选或全选并批量排队。相同源已排队或已完成时批量提交会复用；失败任务可重新排队。完成后从「媒体库」加载，播放流量从影院服务器发出。

下载速度按最近约 5 秒内的传输字节计算，停传后归零；仅在总大小已知且有有效速度时显示预计剩余时间。任务详情可展开查看来源、编号和时间，列表刷新保留展开状态。

Girigirilove 支持 `https://ani.girigirilove.com/detail/27217` 和 `https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=2` 等新版地址。`sourceIndex`、`episodeIndex` 从 0 开始，分别表示线路和该线路内的分集位置；省略时取 0。不存在的线路或集数返回错误，不自动切换到第一集。旧版 `/GV{id}/`、`/playGV{id}-{线路}-{集数}/` 地址在原页面失效后通过新接口解析；旧地址中的线路和集数从 1 开始。
- 本地媒体：把 `.mp4` / `.webm` 放到宿主机 `library/`，支持子目录；目录只读挂载，不跟随符号链接。文件应对容器 UID 1000 可读。刷新媒体库即可发现。
- 下载 HLS 保持为本地分段，不实时转码，不必合并成一个 MP4。下载支持有限长度、未加密、MPEG-TS 分段的 HLS；加密、分离音轨、fMP4、直播清单会明确拒绝。
- 本地库对所有成功从 Fiora 进入的用户共享，下载管理只有站点管理员可用。下载缓存与本地挂载目录分开计量。管理员可按片名或番剧筛选、勾选整组或全选当前结果，再批量删除下载文件及记录。单次最多删除 1000 项，整批验证通过后才执行；挂载文件只读，任何房间正在使用的媒体均需先切换或清空。删除中途重启会根据已持久化的任务记录恢复或清理暂存文件。
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

Girigirilove 适配器在站点域名已获允许的前提下，使用固定的 `https://m3u8.girigirilove.com/api.php/Vod/` 公共接口读取搜索和分集数据。该接口独立限定为精确域名，并沿用公网 IP、DNS 固定和重定向检查；无需将它加入现有 `MEDIA_ALLOWED_HOSTS`。接口返回的实际媒体地址仍必须命中 `MEDIA_ALLOWED_HOSTS`。封面仅接受站点自身及 `jpg.girigirilove.net` 的 HTTPS `/upload/` 图片地址。

## 功能限制

- Bilibili 账号支持扫码绑定；暂不自动续期或支持通用视频网站解析器。不支持的页面会明确提示。
- 在线模式依赖来源的 CORS、有效期、用户网络与浏览器编码支持。不提供通用代理，也不保证所有 MP4 / WebM 编码都能播放。
- 同步通过 SSE 广播房间状态，浏览器偏差超过约 1.2 秒时校正。同步精度不达到逐帧级别，单个客户端缓冲不会自动暂停全房间播放。
- 使用单进程 JSON 持久化，适用于双人或小群。同一数据卷仅允许一个实例写入。
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
