const $ = id => document.getElementById(id);
const room = /^\/room\/([a-f0-9]+)\/manage$/.exec(location.pathname)?.[1];
let state; let activeTab = 'online'; let busy = false; let noticeTimer; let catalog; let selectedIndex = 0;
let catalogLoading = false; let searchLoading = false; let searchPage = 0; let searchQuery = ''; let downloading = false;
let selectedDownloads = new Set(); let currentGroup = '';
const bytes = value => { const number = Math.max(0, Number(value) || 0); const unit = number >= 1024 ** 3 ? 'GB' : number >= 1024 ** 2 ? 'MB' : number >= 1024 ? 'KB' : 'B'; return `${(number / ({ GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024, B: 1 })[unit]).toFixed(unit === 'B' ? 0 : 1)} ${unit}`; };
const episodeGroup = episode => String(episode.groupId ?? episode.group ?? 'default');
const catalogDownloadable = () => !!catalog?.episodes?.length && !catalog.episodes.some(episode => { try { return /(^|\.)bilibili\.com$|^b23\.tv$/.test(new URL(episode.url).hostname); } catch { return true; } });
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (!error && text) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
async function api(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: signal || AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
function refreshControls() {
  $('load').disabled = busy || !state?.canControl;
  $('clear').disabled = busy || !state?.canControl || !state?.media;
  $('inspect').disabled = catalogLoading;
  $('play-episode').disabled = busy || catalogLoading || !state?.canControl || !catalog?.episodes?.[selectedIndex];
  $('download-episode').hidden = $('download-batch').hidden = $('batch-controls').hidden = !state?.user.admin || !catalogDownloadable();
  $('download-episode').disabled = downloading || catalogLoading || !catalog?.episodes?.[selectedIndex];
  $('download-batch').disabled = downloading || catalogLoading || !selectedDownloads.size || selectedDownloads.size > 100;
  $('download-batch').textContent = downloading ? '加入队列中…' : `批量下载勾选剧集${selectedDownloads.size ? `（${selectedDownloads.size}）` : ''}`;
  $('select-all-episodes').disabled = $('clear-episodes').disabled = downloading || catalogLoading;
  $('add-download').disabled = downloading || catalogLoading;
  $('batch-count').textContent = `已选 ${selectedDownloads.size} 集 · 每批最多 100 集`;
  document.querySelectorAll('[data-library-play]').forEach(button => { button.disabled = busy || !state?.canControl; });
}
async function refreshState() { state = await api('/api/state'); $('identity').textContent = state.user.name; $('download-tab').hidden = $('bilibili-tab').hidden = !state.user.admin; $('current-title').textContent = state.media?.title || '未选择'; refreshControls(); }
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
      if (state?.media?.episodes?.length) { selectedDownloads.clear(); currentGroup = ''; catalog = { title: state.media.seriesTitle || state.media.title, episodes: state.media.episodes }; selectedIndex = state.media.episodeIndex || 0; renderCatalog(); }
    } finally { $('load').textContent = '播放此地址'; }
  });
};
$('clear').onclick = () => attempt(() => select({ mode: 'clear' }));
function renderCatalog() {
  const episodes = catalog?.episodes || [];
  $('catalog-detail').hidden = !catalog;
  $('catalog-title').textContent = catalog?.title || '分集';
  $('catalog-description').textContent = catalog?.description || '';
  const groups = [...new Map(episodes.map(episode => [episodeGroup(episode), episode.group || '默认线路'])).entries()];
  if (!groups.some(([id]) => id === currentGroup)) currentGroup = episodeGroup(episodes[selectedIndex] || {});
  const count = episodes.filter(episode => episodeGroup(episode) === currentGroup).length;
  $('catalog-count').textContent = `${count} 集 · ${groups.length} 条线路`;
  $('catalog-group').replaceChildren(...groups.map(([id, name]) => { const option = document.createElement('option'); option.value = id; option.textContent = `${name}（${episodes.filter(episode => episodeGroup(episode) === id).length} 集）`; option.selected = id === currentGroup; return option; }));
  $('catalog-episodes').replaceChildren();
  let previousGroup;
  episodes.forEach((episode, index) => {
    if (episodeGroup(episode) !== currentGroup) return;
    if (episode.group && episode.group !== previousGroup) { const heading = document.createElement('div'); heading.className = 'episode-group'; heading.textContent = episode.group; $('catalog-episodes').append(heading); previousGroup = episode.group; }
    const node = document.createElement('button'); node.className = index === selectedIndex ? 'episode active' : 'episode';
    node.textContent = episode.title || `第 ${index + 1} 集`; node.title = episode.group ? `${episode.group} · ${node.textContent}` : node.textContent;
    node.setAttribute('aria-pressed', String(index === selectedIndex)); node.onclick = () => { selectedIndex = index; renderCatalog(); };
    if (state?.user.admin && catalogDownloadable()) {
      const wrapper = document.createElement('div'); wrapper.className = 'episode-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedDownloads.has(index); checkbox.disabled = downloading;
      checkbox.setAttribute('aria-label', `下载 ${episode.group || ''} ${episode.title || `第 ${index + 1} 集`}`);
      checkbox.onchange = () => { if (checkbox.checked) selectedDownloads.add(index); else selectedDownloads.delete(index); refreshControls(); };
      wrapper.append(checkbox, node); $('catalog-episodes').append(wrapper);
    } else $('catalog-episodes').append(node);
  });
  $('selected-episode').textContent = episodes[selectedIndex] ? `当前：${episodes[selectedIndex].group || ''} · ${episodes[selectedIndex].title}` : '暂无可用分集'; refreshControls();
}
$('catalog-group').onchange = () => { currentGroup = $('catalog-group').value; selectedDownloads.clear(); selectedIndex = catalog.episodes.findIndex(episode => episodeGroup(episode) === currentGroup); renderCatalog(); };
$('select-all-episodes').onclick = () => { selectedDownloads = new Set(catalog.episodes.flatMap((episode, index) => episodeGroup(episode) === currentGroup ? [index] : [])); renderCatalog(); if (selectedDownloads.size > 100) notice('此线路超过 100 集，请取消部分勾选后分批下载。', true); };
$('clear-episodes').onclick = () => { selectedDownloads.clear(); renderCatalog(); };
async function inspect(url) {
  if (catalogLoading) return;
  catalogLoading = true; catalog = null; selectedDownloads.clear(); currentGroup = ''; renderCatalog(); $('inspect').textContent = '读取中…';
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
$('download-batch').onclick = () => attempt(async () => {
  if (downloading || !state?.user.admin || !selectedDownloads.size || selectedDownloads.size > 100) return;
  const urls = [...selectedDownloads].sort((a, b) => a - b).map(index => catalog.episodes[index].url);
  downloading = true; refreshControls();
  try {
    const result = await api('/api/downloads/batch', { urls }); selectedDownloads.clear(); renderCatalog();
    notice(`已添加 ${result.added} 集${result.skipped ? `，${result.skipped} 集已在队列或已完成` : ''}`);
  } finally { downloading = false; refreshControls(); }
});
function appendSearch(items) {
  for (const entry of items) {
    const card = document.createElement('button'); card.className = 'catalog-card'; card.type = 'button';
    if (entry.cover && /^https?:\/\//.test(entry.cover)) {
      const cover = document.createElement('img'); cover.src = entry.cover; cover.alt = ''; cover.loading = 'lazy'; cover.referrerPolicy = 'no-referrer'; cover.onerror = () => { cover.remove(); card.classList.add('no-cover'); }; card.append(cover);
    } else card.classList.add('no-cover');
    const info = document.createElement('div'); info.className = 'catalog-info';
    const title = document.createElement('strong'); title.textContent = entry.title;
    const description = document.createElement('small'); description.textContent = `${entry.description || '查看完整剧集'}${state?.user.admin ? ' · 可批量下载' : ''}`; info.append(title, description); card.append(info);
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
    const expanded = new Set([...$('jobs').querySelectorAll('details[open]')].map(node => node.dataset.job));
    const result = await api('/api/downloads'); $('jobs').replaceChildren(); $('storage').textContent = `缓存 ${bytes(result.usedBytes)} / ${bytes(result.quota)}`;
    const labels = { queued: '排队中', running: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };
    const stages = { queued: '等待开始', resolving: '解析视频地址', playlist: '读取 HLS 清单', downloading: '传输视频', cancelling: '正在取消', finalizing: '整理到媒体库', done: '可在媒体库播放', failed: '下载失败', cancelled: '任务已取消' };
    const counts = Object.fromEntries(Object.keys(labels).map(status => [status, result.jobs.filter(job => job.status === status).length]));
    $('queue-summary').textContent = `排队 ${counts.queued} · 进行中 ${counts.running} · 已完成 ${counts.done} · 失败 ${counts.failed} · 已取消 ${counts.cancelled}`;
    if (!result.jobs.length) $('jobs').textContent = '还没有下载任务，搜索番剧后可勾选整季下载。';
    const queue = result.jobs.filter(job => job.status === 'queued');
    for (const job of result.jobs.slice().reverse()) {
      const active = ['running', 'queued'].includes(job.status);
      const ratio = job.status === 'done' ? 1 : job.kind === 'hls' && job.total ? job.completed / job.total : job.expectedBytes ? job.bytes / job.expectedBytes : null;
      const percent = ratio === null ? '大小待来源提供' : `${Math.min(job.status === 'done' ? 100 : 99.9, Math.max(0, ratio * 100)).toFixed(1)}%`;
      const detail = `${labels[job.status] || job.status} · ${stages[job.status === 'running' ? job.stage : job.status] || '处理中'}${job.status === 'queued' ? ` · 第 ${queue.indexOf(job) + 1} 位` : ''} · ${percent}`;
      const row = item($('jobs'), job.title || job.source, detail); row.classList.add('download-job');
      const transfer = document.createElement('small');
      transfer.textContent = `${job.group ? job.group + ' · ' : ''}${job.episodeTitle || (job.episodeNumber ? `第 ${job.episodeNumber} 集` : '')}${job.kind === 'hls' ? ` · 分段 ${job.completed}/${job.total || '?'}${job.currentSegment && job.status === 'running' ? `，正在传输第 ${job.currentSegment} 段` : ''}` : ''} · ${bytes(job.bytes)} / ${job.expectedBytes ? bytes(job.expectedBytes) : '总大小未知'}${job.status === 'running' && job.stage === 'downloading' ? ` · ${bytes(job.speedBytesPerSecond)}/s` : ''}`;
      row.append(transfer);
      if (ratio !== null || job.status === 'running') { const progress = document.createElement('progress'); progress.max = 1; if (ratio !== null) progress.value = Math.max(0, Math.min(1, ratio)); progress.setAttribute('aria-label', `${job.title} 下载进度`); row.append(progress); }
      if (job.error) { const error = document.createElement('p'); error.className = 'download-error'; error.textContent = job.error; row.append(error); }
      const metadata = document.createElement('details'); metadata.dataset.job = job.id; metadata.open = expanded.has(job.id);
      const summary = document.createElement('summary'); summary.textContent = '任务详情'; metadata.append(summary);
      const info = document.createElement('p'); info.textContent = `任务 ${job.id} · ${job.kind === 'hls' ? 'HLS' : job.kind === 'mp4' ? 'MP4' : '待解析'}${job.seriesTitle ? ` · ${job.seriesTitle}` : ''}`; metadata.append(info);
      const dates = document.createElement('p'); dates.textContent = [['添加', job.createdAt], ['开始', job.startedAt], ['结束', job.finishedAt]].filter(([, value]) => value).map(([label, value]) => `${label} ${new Date(value).toLocaleString('zh-CN')}`).join(' · '); metadata.append(dates);
      try { const source = new URL(job.source); if (['http:', 'https:'].includes(source.protocol)) { const link = document.createElement('a'); link.href = source.href; link.textContent = '查看原始片源'; link.target = '_blank'; link.rel = 'noreferrer noopener'; metadata.append(link); } } catch { /* Old records can lack a source. */ }
      row.append(metadata);
      button(row, active ? '取消下载' : '删除记录与文件', async () => { if (job.status === 'done' && !confirm('删除这个已下载的视频及任务记录？')) return; await api(`/api/downloads/${job.id}/remove`, {}); await downloads(); });
      if (['failed', 'cancelled'].includes(job.status)) button(row, '重新排队', () => download(job.source));
    }
  } finally { loadingJobs = false; }
}
$('refresh-library').onclick = () => attempt(library);
$('download-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  const source = $('download-source').value.trim(); const url = new URL(source);
  if (url.origin === 'https://ani.girigirilove.com' && /^\/(?:GV\d+|playGV\d+-\d+-\d+)\/?$/.test(url.pathname)) {
    document.querySelector('[data-tab="online"]').click(); await inspect(source); notice('已读取完整剧集，请选择线路并勾选要下载的集数。');
  } else await download(source);
}); };
let bilibiliAccount; let accountTask = ''; let accountVersion = 0;
let qrSession; let qrTimer; let qrController; let qrPolling = false; let qrGeneration = 0; let pageLeaving = false;
function accountTime(value) {
  if (!value) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(value);
}
function renderAccount() {
  const unavailable = !!(bilibiliAccount?.error || bilibiliAccount?.expired);
  const connected = !!bilibiliAccount?.connected && !unavailable;
  $('bilibili-name').textContent = connected ? bilibiliAccount.username || '已登录账号' : '尚未绑定账号';
  $('bilibili-status').textContent = accountTask === 'loading' && !bilibiliAccount ? '读取中…' : unavailable ? '请重新绑定' : connected ? '已连接' : '未连接';
  $('bilibili-status').classList.toggle('connected', connected);
  $('bilibili-vip').hidden = !connected || !bilibiliAccount.vip;
  $('bilibili-refresh').disabled = $('bilibili-login').disabled = $('bilibili-logout').disabled = $('bilibili-retry').disabled = !!accountTask;
  $('bilibili-refresh').textContent = ['refresh', 'loading'].includes(accountTask) ? '刷新中…' : '刷新状态';
  $('bilibili-login').textContent = accountTask === 'login' ? '获取二维码…' : unavailable ? '重新绑定' : connected ? '更换账号' : '扫码登录';
  $('bilibili-login').hidden = !!qrSession;
  $('bilibili-logout').hidden = !connected && !unavailable;
  $('bilibili-logout').textContent = accountTask === 'logout' ? '解除中…' : '解除绑定';
  const checked = accountTime(bilibiliAccount?.checkedAt);
  $('bilibili-checked').textContent = Number.isFinite(checked) && checked > 0 ? `更新于 ${new Date(checked).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('bilibili-qr').hidden = !qrSession;
  if (qrSession) {
    const live = ['waiting', 'scanned'].includes(qrSession.status);
    $('bilibili-qr-image').hidden = !live;
    $('bilibili-qr').classList.toggle('qr-inactive', !live);
    $('bilibili-qr-status').textContent = ({ waiting: '等待扫码', scanned: '已扫码，请在手机上确认', expired: '二维码已过期', error: '登录暂未完成，请重新扫码' })[qrSession.status] || '等待扫码';
    $('bilibili-retry').hidden = live;
  }
}
function stopQrPolling(clear = false) {
  clearTimeout(qrTimer); qrTimer = undefined; qrGeneration += 1;
  qrController?.abort(); qrController = undefined;
  if (clear) { qrSession = undefined; $('bilibili-qr-image').removeAttribute('src'); renderAccount(); }
}
function canPollQr() {
  return !pageLeaving && !document.hidden && activeTab === 'bilibili' && state?.user.admin && qrSession && ['waiting', 'scanned'].includes(qrSession.status);
}
function queueQrPoll() {
  clearTimeout(qrTimer);
  if (!canPollQr()) return;
  if (Date.now() >= qrSession.expiresAt) { qrSession.status = 'expired'; renderAccount(); return; }
  qrTimer = setTimeout(pollQr, 3000);
}
async function pollQr() {
  if (!canPollQr()) return;
  if (Date.now() >= qrSession.expiresAt) { qrSession.status = 'expired'; renderAccount(); return; }
  if (qrPolling) { queueQrPoll(); return; }
  const id = qrSession.id; const generation = qrGeneration; const controller = new AbortController();
  qrPolling = true; qrController = controller;
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const result = await api('/api/bilibili/account/poll', { id }, controller.signal);
    if (generation !== qrGeneration || !canPollQr() || qrSession.id !== id) return;
    if (result.status === 'connected') {
      accountVersion += 1; bilibiliAccount = result.account || { connected: true };
      stopQrPolling(true); renderAccount(); notice('登录成功，重新加载视频即可使用新清晰度。');
      if (!result.account) attempt(() => loadAccount());
      return;
    }
    if (!['waiting', 'scanned', 'expired'].includes(result.status)) throw new Error('登录状态暂不可用');
    qrSession.status = result.status; renderAccount();
  } catch (error) {
    if (generation === qrGeneration && qrSession?.id === id) {
      qrSession.status = 'error'; renderAccount();
      notice(controller.signal.aborted ? '查询登录状态超时，请重新扫码。' : error.message || '登录状态暂不可用，请重新扫码。', true);
    }
  } finally {
    clearTimeout(timeout); qrPolling = false;
    if (qrController === controller) qrController = undefined;
    if (generation === qrGeneration) queueQrPoll();
  }
}
async function loadAccount(refresh = false) {
  if (!state?.user.admin || accountTask || pageLeaving) return;
  const version = ++accountVersion; accountTask = refresh ? 'refresh' : 'loading'; renderAccount();
  try {
    const result = await api(`/api/bilibili/account${refresh ? '/refresh' : ''}`, refresh ? {} : undefined);
    if (version === accountVersion && !pageLeaving) {
      bilibiliAccount = result;
      if (result.error) notice('账号信息暂不可用，请重新绑定。', true);
      else if (result.expired) notice('账号登录已过期，请重新绑定。', true);
    }
  } finally { accountTask = ''; renderAccount(); }
}
async function loginAccount() {
  if (!state?.user.admin || accountTask || pageLeaving) return;
  stopQrPolling(true); accountVersion += 1; accountTask = 'login'; renderAccount();
  try {
    const result = await api('/api/bilibili/account/login', {});
    if (pageLeaving) return;
    const expiresAt = accountTime(result.expiresAt);
    if (!result.id || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.qrImage || '') || !Number.isFinite(expiresAt) || !expiresAt) throw new Error('二维码暂不可用，请重试');
    qrSession = { id: result.id, expiresAt, status: 'waiting' };
    $('bilibili-qr-image').src = result.qrImage; renderAccount(); queueQrPoll();
  } finally { accountTask = ''; renderAccount(); }
}
async function logoutAccount() {
  if (!state?.user.admin || accountTask || pageLeaving) return;
  stopQrPolling(true); accountVersion += 1; accountTask = 'logout'; renderAccount();
  try { bilibiliAccount = await api('/api/bilibili/account/logout', {}); notice('已解除绑定'); }
  finally { accountTask = ''; renderAccount(); }
}
$('bilibili-refresh').onclick = () => attempt(() => loadAccount(true));
$('bilibili-login').onclick = $('bilibili-retry').onclick = () => attempt(loginAccount);
$('bilibili-logout').onclick = () => attempt(logoutAccount);
let settingsBusy = false;
async function playbackSettings(save = false) {
  if (settingsBusy || !state?.user.admin) return; settingsBusy = true;
  $('save-playback-settings').disabled = $('bilibili-delivery').disabled = true;
  $('playback-settings-status').textContent = save ? '保存中…' : '读取中…';
  try {
    const result = await api('/api/settings/playback', save ? { bilibiliDelivery: $('bilibili-delivery').value } : undefined);
    $('bilibili-delivery').value = result.bilibiliDelivery === 'proxy' ? 'proxy' : 'direct';
    $('playback-settings-status').textContent = save ? '已保存，下次选片生效。' : '';
  } catch (error) { $('playback-settings-status').textContent = error.message || '设置暂不可用'; throw error; }
  finally { settingsBusy = false; $('save-playback-settings').disabled = $('bilibili-delivery').disabled = false; }
}
$('playback-settings-form').onsubmit = event => { event.preventDefault(); attempt(() => playbackSettings(true)); };
document.addEventListener('visibilitychange', () => { if (document.hidden) stopQrPolling(); else queueQrPoll(); });
window.addEventListener('pagehide', () => { pageLeaving = true; stopQrPolling(); });
window.addEventListener('pageshow', () => { pageLeaving = false; queueQrPoll(); });
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => {
  if (['bilibili', 'download'].includes(tab.dataset.tab) && !state?.user.admin) return;
  stopQrPolling(); activeTab = tab.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node === tab));
  for (const name of ['online', 'local', 'download', 'bilibili']) $(`${name}-panel`).hidden = name !== activeTab;
  if (activeTab === 'local') attempt(library);
  if (activeTab === 'download') attempt(downloads);
  if (activeTab === 'bilibili') { attempt(() => loadAccount()); attempt(() => playbackSettings()); queueQrPoll(); }
}; });
setInterval(() => { if (!document.hidden && state?.user.admin && activeTab === 'download') attempt(downloads); }, 2000);
attempt(async () => {
  if (!room) return; $('home').href = $('back').href = `/room/${room}`;
  const seed = new URLSearchParams(location.hash.slice(1)).get('source'); history.replaceState(null, '', location.pathname); if (seed) sessionStorage.setItem(`watch-source:${room}`, seed);
  $('source').value = sessionStorage.getItem(`watch-source:${room}`) || ''; await refreshState();
  if (state.media?.episodes?.length) { selectedDownloads.clear(); currentGroup = ''; catalog = { title: state.media.seriesTitle || state.media.title, episodes: state.media.episodes }; selectedIndex = state.media.episodeIndex || 0; renderCatalog(); }
});
