const $ = id => document.getElementById(id);
const room = /^\/room\/([a-f0-9]+)\/manage$/.exec(location.pathname)?.[1];
let state; let activeTab = 'online'; let busy = false; let noticeTimer;
const bytes = value => `${(value / 1024 ** 3).toFixed(2)} GB`;
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(40000), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
async function refreshState() { state = await api('/api/state'); $('identity').textContent = state.user.name; $('download-tab').hidden = !state.user.admin; $('load').disabled = busy || !state.canControl; $('clear').disabled = !state.canControl; $('current-title').textContent = state.media?.title || '未选择'; }
async function select(media) { await refreshState(); await api('/api/media', { ...media, revision: state.revision }); await refreshState(); notice('已加载到放映室'); }
$('source-form').onsubmit = event => { event.preventDefault(); attempt(async () => { busy = true; $('load').disabled = true; $('load').textContent = '解析中…'; try { await select({ mode: 'online', url: $('source').value }); sessionStorage.removeItem(`watch-source:${room}`); } finally { busy = false; $('load').textContent = '加载到放映室'; $('load').disabled = !state?.canControl; } }); };
$('clear').onclick = () => attempt(() => select({ mode: 'clear' }));
function item(parent, title, detail) { const row = document.createElement('div'); row.className = 'item'; const name = document.createElement('strong'); name.textContent = title; const text = document.createElement('small'); text.textContent = detail; row.append(name, text); parent.append(row); return row; }
function button(row, text, onClick, disabled = false) { const node = document.createElement('button'); node.textContent = text; node.disabled = disabled; node.onclick = () => attempt(onClick); row.append(node); }
async function library() { const result = await api('/api/library'); $('library').replaceChildren(); if (!result.items.length) $('library').textContent = '媒体库还没有影片'; for (const media of result.items) button(item($('library'), media.title, media.kind === 'hls' ? 'HLS' : '本地视频'), '加载到放映室', () => select({ mode: 'local', id: media.id }), !state?.canControl); }
let loadingJobs = false;
async function downloads() {
  if (loadingJobs) return; loadingJobs = true;
  try {
    const result = await api('/api/downloads'); $('jobs').replaceChildren(); $('storage').textContent = `缓存 ${bytes(result.usedBytes)} / ${bytes(result.quota)}`;
    const labels = { queued: '排队中', running: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };
    for (const job of result.jobs.slice().reverse()) button(item($('jobs'), job.title, `${labels[job.status]} · ${job.completed}/${job.total || '?'} · ${bytes(job.bytes)}${job.error ? ' · ' + job.error : ''}`), ['running', 'queued'].includes(job.status) ? '取消' : '删除', async () => { if (job.status === 'done' && !confirm('删除这个已下载的视频？')) return; await api(`/api/downloads/${job.id}/remove`, {}); await downloads(); });
  } finally { loadingJobs = false; }
}
$('refresh-library').onclick = () => attempt(library);
$('download-form').onsubmit = event => { event.preventDefault(); attempt(async () => { await api('/api/downloads', { url: $('download-source').value }); notice('已加入下载队列'); await downloads(); }); };
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => { activeTab = tab.dataset.tab; document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node === tab)); for (const name of ['online', 'local', 'download']) $(`${name}-panel`).hidden = name !== activeTab; if (activeTab === 'local') attempt(library); if (activeTab === 'download') attempt(downloads); }; });
setInterval(() => { if (state?.user.admin && activeTab === 'download') attempt(downloads); }, 4000);
attempt(async () => { if (!room) return; $('home').href = $('back').href = `/room/${room}`; const seed = new URLSearchParams(location.hash.slice(1)).get('source'); history.replaceState(null, '', location.pathname); if (seed) sessionStorage.setItem(`watch-source:${room}`, seed); $('source').value = sessionStorage.getItem(`watch-source:${room}`) || ''; await refreshState(); });
