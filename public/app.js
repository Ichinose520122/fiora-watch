/* global Hls */
const $ = id => document.getElementById(id);
const video = $('video');
let room = /^\/room\/([a-f0-9]+)$/.exec(location.pathname)?.[1];
let state; let receivedAt = 0; let currentMedia = ''; let hls; let enabled = false; let events; let activeTab = 'online'; let applying = false;
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); };
const bytes = value => `${(value / 1024 ** 3).toFixed(2)} GB`;
const time = value => { const seconds = Math.max(0, Math.floor(value || 0)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };

async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { video.pause(); enabled = false; }
    throw new Error(result.error || '请求失败');
  }
  return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
function target() { return state ? state.position + (state.paused ? 0 : Math.max(0, (state.serverTime - state.updatedAt) / 1000 + (performance.now() - receivedAt) / 1000)) : 0; }
function synchronize() {
  if (!state?.media || video.readyState < 1 || !enabled || applying) return;
  const goal = Math.min(target(), Number.isFinite(video.duration) ? video.duration : Infinity);
  if (Math.abs(video.currentTime - goal) > 1.2) video.currentTime = goal;
  if (state.paused) { video.pause(); return; }
  if (video.paused && !video.ended) {
    applying = true;
    video.play().catch(() => { enabled = false; $('join').hidden = false; notice('浏览器需要你点击「开启本机播放」后播放。'); }).finally(() => { applying = false; });
  }
}
function receive(next) {
  if (state && next.revision < state.revision) return;
  state = next; receivedAt = performance.now();
  $('identity').textContent = next.user.name;
  $('logout').hidden = false;
  $('download-tab').hidden = !next.user.admin;
  $('connection').textContent = next.paused ? '房间已暂停' : '同步播放中';
  $('title').textContent = next.media?.title || '尚未选择视频';
  $('permission').textContent = next.canControl ? '你可以切换视频并控制房间播放。音量和全屏只影响自己。' : '跟随房间播放，由群主或管理员控制。';
  for (const id of ['play', 'pause', 'seek']) $(id).disabled = !next.canControl || !next.media;
  for (const id of ['load', 'clear']) $(id).disabled = !next.canControl;
  const source = next.media?.url || '';
  if (source !== currentMedia) {
    currentMedia = source; hls?.destroy(); hls = null; video.pause(); video.removeAttribute('src'); video.load();
    $('empty').hidden = !!source;
    if (source) {
      if (next.media.kind === 'hls' && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
        hls.loadSource(source); hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) notice('视频加载失败：来源可能过期、限制跨域或网络不可达。请重新解析或使用下载模式。', true); });
      } else video.src = source;
    }
  }
  synchronize();
}
async function action(action, extra = {}) {
  try { await api('/api/control', { action, revision: state.revision, ...extra }); }
  catch (error) { receive(await api('/api/state')); throw error; }
}
$('join').onclick = () => {
  enabled = true; $('join').hidden = true;
  // Call play inside the click handler to unlock audio on mobile browsers.
  if (state?.media) video.play().then(() => synchronize()).catch(() => { enabled = false; $('join').hidden = false; notice('视频尚未就绪，请稍后再次开启播放。'); });
  else notice('已准备好，选择视频后开始播放。');
};
$('play').onclick = () => attempt(() => action('play'));
$('pause').onclick = () => attempt(() => action('pause'));
$('seek').onchange = event => attempt(() => action('seek', { position: Number(event.target.value) }));
$('volume').oninput = event => { video.volume = Number(event.target.value); };
$('fullscreen').onclick = () => attempt(() => video.requestFullscreen ? video.requestFullscreen() : video.webkitEnterFullscreen?.());
video.addEventListener('loadedmetadata', synchronize);
video.addEventListener('canplay', synchronize);
video.addEventListener('error', () => notice('视频无法播放，请检查格式、地址是否有效，或改用本地模式。', true));
video.addEventListener('ended', () => { if (state?.canControl && !state.paused) attempt(() => action('pause')); });
$('source-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  $('load').disabled = true; notice('正在解析视频…');
  try { await api('/api/media', { mode: 'online', url: $('source').value, revision: state.revision }); notice('视频已选好，点击播放即可开始。'); }
  finally { $('load').disabled = !state?.canControl; }
}); };
$('clear').onclick = () => attempt(() => api('/api/media', { mode: 'clear', revision: state.revision }));

function item(parent, title, detail) {
  const row = document.createElement('div'); row.className = 'item';
  const name = document.createElement('strong'); name.textContent = title; row.append(name);
  const text = document.createElement('small'); text.textContent = detail; row.append(text); parent.append(row); return row;
}
function button(row, text, onClick, disabled = false) { const node = document.createElement('button'); node.textContent = text; node.disabled = disabled; node.onclick = () => attempt(onClick); row.append(node); }
async function refreshLibrary() {
  const result = await api('/api/library'); $('library').replaceChildren();
  if (!result.items.length) $('library').textContent = '还没有视频。挂载本地文件，或先完成一个下载任务。';
  for (const media of result.items) button(item($('library'), media.title, media.kind === 'hls' ? '本地 HLS' : '本地视频'), '选为当前视频', async () => { await api('/api/media', { mode: 'local', id: media.id, revision: state.revision }); notice('已选择本地视频'); }, !state?.canControl);
}
async function refreshDownloads() {
  const result = await api('/api/downloads'); $('jobs').replaceChildren();
  $('storage').textContent = `下载缓存 ${bytes(result.usedBytes)} / ${bytes(result.quota)}`;
  const labels = { queued: '排队中', running: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };
  for (const job of result.jobs.slice().reverse()) {
    const row = item($('jobs'), job.title, `${labels[job.status]} · ${job.completed}/${job.total || '?'} · ${bytes(job.bytes)}${job.error ? ' · ' + job.error : ''}`);
    button(row, ['running', 'queued'].includes(job.status) ? '取消' : '删除', async () => { if (job.status === 'done' && !confirm('删除这个已下载的视频？')) return; await api(`/api/downloads/${job.id}/remove`, {}); await refreshDownloads(); });
  }
}
$('refresh-library').onclick = () => attempt(refreshLibrary);
$('download-form').onsubmit = event => { event.preventDefault(); attempt(async () => { await api('/api/downloads', { url: $('download-source').value }); notice('已加入下载队列'); await refreshDownloads(); }); };
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => {
  activeTab = tab.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node === tab));
  for (const name of ['online', 'local', 'download']) $(`${name}-panel`).hidden = name !== activeTab;
  if (activeTab === 'local') attempt(refreshLibrary);
  if (activeTab === 'download') attempt(refreshDownloads);
}; });
$('logout').onclick = () => attempt(async () => { await api('/api/logout', {}); events?.close(); location.replace('/'); });
setInterval(() => {
  if (!state) return;
  synchronize();
  $('time').textContent = `${time(video.currentTime)} / ${time(Number.isFinite(video.duration) ? video.duration : 0)}`;
  if (Number.isFinite(video.duration)) { $('seek').max = String(video.duration); if (document.activeElement !== $('seek')) $('seek').value = String(video.currentTime); }
}, 1000);
setInterval(() => { if (state?.user.admin && activeTab === 'download') attempt(refreshDownloads); }, 4000);

attempt(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const ticket = fragment.get('ticket');
  if (ticket) {
    // Remove credentials before any further requests; never store tickets in history.
    history.replaceState(null, '', '/');
    const result = await api('/api/session', { ticket }); room = result.room;
    const source = fragment.get('source'); if (source) $('source').value = source;
    history.replaceState(null, '', `/room/${room}`);
  }
  if (!room) return;
  receive(await api('/api/state')); notice('已加入影院。点击「开启本机播放」准备观看。');
  events = new EventSource(`/api/events?room=${encodeURIComponent(room)}`);
  events.onmessage = event => { receive(JSON.parse(event.data)); };
  events.onerror = () => { video.pause(); enabled = false; $('join').hidden = false; $('connection').textContent = '连接中断'; notice('连接中断，恢复后请重新开启本机播放；登录过期时从 Fiora 重新进入。', true); };
});
