const $ = id => document.getElementById(id);
const room = /^\/room\/([a-f0-9]+)\/manage$/.exec(location.pathname)?.[1];
let state; let activeTab = 'online'; let busy = false; let noticeTimer; let catalog; let selectedIndex = 0;
let catalogLoading = false; let searchLoading = false; let searchPage = 0; let searchQuery = ''; let downloading = false;
const bytes = value => `${(value / 1024 ** 3).toFixed(2)} GB`;
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (!error && text) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
function refreshControls() {
  $('load').disabled = busy || !state?.canControl;
  $('clear').disabled = busy || !state?.canControl || !state?.media;
  $('inspect').disabled = catalogLoading;
  $('play-episode').disabled = busy || catalogLoading || !state?.canControl || !catalog?.episodes?.[selectedIndex];
  $('download-episode').hidden = !state?.user.admin;
  $('download-episode').disabled = downloading || catalogLoading || !catalog?.episodes?.[selectedIndex];
  document.querySelectorAll('[data-library-play]').forEach(button => { button.disabled = busy || !state?.canControl; });
}
async function refreshState() { state = await api('/api/state'); $('identity').textContent = state.user.name; $('download-tab').hidden = !state.user.admin; $('current-title').textContent = state.media?.title || '未选择'; refreshControls(); }
async function select(media) {
  if (busy || !state?.canControl) return;
  busy = true; refreshControls();
  try { await refreshState(); const result = await api('/api/media', { ...media, revision: state.revision }); await refreshState(); notice(result.warning || '已加载到放映室', !!result.warning); }
  finally { busy = false; refreshControls(); }
}
$('source-form').onsubmit = event => {
  event.preventDefault(); if (!$('source').reportValidity()) return;
  attempt(async () => {
    $('load').textContent = '解析中…';
    try {
      await select({ mode: 'online', url: $('source').value.trim() });
      sessionStorage.removeItem(`watch-source:${room}`);
      if (state?.media?.episodes?.length) { catalog = { title: state.media.title, episodes: state.media.episodes }; selectedIndex = state.media.episodeIndex || 0; renderCatalog(); }
    } finally { $('load').textContent = '播放此地址'; }
  });
};
$('clear').onclick = () => attempt(() => select({ mode: 'clear' }));
function renderCatalog() {
  const episodes = catalog?.episodes || [];
  $('catalog-detail').hidden = !catalog;
  $('catalog-title').textContent = catalog?.title || '分集';
  const groups = new Set(episodes.map(episode => episode.group || '')).size;
  const count = episodes.filter(episode => episode.group === episodes[selectedIndex]?.group).length;
  $('catalog-count').textContent = groups > 1 ? `${count} 集 · ${groups} 条线路` : `${episodes.length} 集`;
  $('catalog-episodes').replaceChildren();
  let previousGroup;
  episodes.forEach((episode, index) => {
    if (episode.group && episode.group !== previousGroup) { const heading = document.createElement('div'); heading.className = 'episode-group'; heading.textContent = episode.group; $('catalog-episodes').append(heading); previousGroup = episode.group; }
    const node = document.createElement('button'); node.className = index === selectedIndex ? 'episode active' : 'episode';
    node.textContent = episode.title || `第 ${index + 1} 集`; node.title = episode.group ? `${episode.group} · ${node.textContent}` : node.textContent;
    node.setAttribute('aria-pressed', String(index === selectedIndex)); node.onclick = () => { selectedIndex = index; renderCatalog(); };
    $('catalog-episodes').append(node);
  });
  $('selected-episode').textContent = episodes[selectedIndex]?.title || '暂无可用分集'; refreshControls();
}
async function inspect(url) {
  if (catalogLoading) return;
  catalogLoading = true; catalog = null; renderCatalog(); $('inspect').textContent = '读取中…';
  try {
    const result = await api(`/api/catalog/episodes?url=${encodeURIComponent(url)}`);
    catalog = result; selectedIndex = result.episodeIndex || 0; $('source').value = url; renderCatalog();
    if (!catalog.episodes?.length) notice('未找到分集，可以直接播放此地址。');
    else $('catalog-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally { catalogLoading = false; $('inspect').textContent = '读取分集'; refreshControls(); }
}
$('inspect').onclick = () => { if ($('source').reportValidity()) attempt(() => inspect($('source').value.trim())); };
$('play-episode').onclick = () => attempt(() => select({ mode: 'online', url: catalog.episodes[selectedIndex].url }));
async function download(url) {
  if (downloading || !state?.user.admin) return; downloading = true; refreshControls();
  try { await api('/api/downloads', { url }); notice('已加入下载队列'); if (activeTab === 'download') await downloads(); }
  finally { downloading = false; refreshControls(); }
}
$('download-episode').onclick = () => attempt(() => download(catalog.episodes[selectedIndex].url));
function appendSearch(items) {
  for (const entry of items) {
    const card = document.createElement('button'); card.className = 'catalog-card'; card.type = 'button';
    if (entry.cover && /^https?:\/\//.test(entry.cover)) {
      const cover = document.createElement('img'); cover.src = entry.cover; cover.alt = ''; cover.loading = 'lazy'; cover.referrerPolicy = 'no-referrer'; cover.onerror = () => { cover.remove(); card.classList.add('no-cover'); }; card.append(cover);
    } else card.classList.add('no-cover');
    const info = document.createElement('div'); info.className = 'catalog-info';
    const title = document.createElement('strong'); title.textContent = entry.title;
    const description = document.createElement('small'); description.textContent = entry.description || '查看剧集'; info.append(title, description); card.append(info);
    card.onclick = () => attempt(() => inspect(entry.url)); $('search-results').append(card);
  }
}
async function search(append = false) {
  if (searchLoading) return;
  const query = $('search').value.trim(); if (!query) return;
  const continuing = append && query === searchQuery; const page = continuing ? searchPage + 1 : 1;
  searchLoading = true; $('search-button').disabled = $('more-results').disabled = true; $('search-button').textContent = '搜索中…';
  if (!continuing) { $('search-results').replaceChildren(); $('more-results').hidden = true; }
  try {
    const result = await api(`/api/catalog/search?q=${encodeURIComponent(query)}&page=${page}`);
    searchQuery = query; searchPage = result.page || page; appendSearch(result.items || []); $('more-results').hidden = !result.hasMore;
    if (!result.items?.length && !continuing) $('search-results').textContent = '没有找到相关影片';
  } finally { searchLoading = false; $('search-button').disabled = $('more-results').disabled = false; $('search-button').textContent = '搜索影片'; }
}
$('search-form').onsubmit = event => { event.preventDefault(); attempt(() => search()); };
$('more-results').onclick = () => attempt(() => search(true));
function item(parent, title, detail) { const row = document.createElement('div'); row.className = 'item'; const name = document.createElement('strong'); name.textContent = title; const text = document.createElement('small'); text.textContent = detail; row.append(name, text); parent.append(row); return row; }
function button(row, text, onClick, disabled = false) { const node = document.createElement('button'); node.textContent = text; node.disabled = disabled; node.onclick = () => attempt(onClick); row.append(node); return node; }
async function library() {
  const result = await api('/api/library'); $('library').replaceChildren(); if (!result.items.length) $('library').textContent = '媒体库还没有影片';
  for (const media of result.items) button(item($('library'), media.title, media.kind === 'hls' ? 'HLS' : '本地视频'), '加载到放映室', () => select({ mode: 'local', id: media.id }), busy || !state?.canControl).dataset.libraryPlay = 'true';
}
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
$('download-form').onsubmit = event => { event.preventDefault(); attempt(() => download($('download-source').value.trim())); };
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => { activeTab = tab.dataset.tab; document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node === tab)); for (const name of ['online', 'local', 'download']) $(`${name}-panel`).hidden = name !== activeTab; if (activeTab === 'local') attempt(library); if (activeTab === 'download') attempt(downloads); }; });
setInterval(() => { if (state?.user.admin && activeTab === 'download') attempt(downloads); }, 4000);
attempt(async () => {
  if (!room) return; $('home').href = $('back').href = `/room/${room}`;
  const seed = new URLSearchParams(location.hash.slice(1)).get('source'); history.replaceState(null, '', location.pathname); if (seed) sessionStorage.setItem(`watch-source:${room}`, seed);
  $('source').value = sessionStorage.getItem(`watch-source:${room}`) || ''; await refreshState();
  if (state.media?.episodes?.length) { catalog = { title: state.media.title, episodes: state.media.episodes }; selectedIndex = state.media.episodeIndex || 0; renderCatalog(); }
});
