import { createDiscovery } from './discovery.js';

const $ = id => document.getElementById(id);
const room = /^\/room\/([a-f0-9]+)\/manage$/.exec(location.pathname)?.[1];
let state; let activeTab = 'online'; let busy = false; let noticeTimer; let downloading = false;
let libraryItems = []; const selectedLibrary = new Set(); let libraryBusy = false;
const bytes = value => { const number = Math.max(0, Number(value) || 0); const unit = number >= 1024 ** 3 ? 'GB' : number >= 1024 ** 2 ? 'MB' : number >= 1024 ? 'KB' : 'B'; return `${(number / ({ GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024, B: 1 })[unit]).toFixed(unit === 'B' ? 0 : 1)} ${unit}`; };
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (!error && text) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
async function api(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: signal || AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
const discovery = createDiscovery({
  api: (...args) => api(...args), getState: () => state, select, download, downloadBatch,
  isDownloading: () => downloading,
});

function refreshControls() {
  discovery.refresh();
  $('add-download').disabled = downloading;
  document.querySelectorAll('[data-library-play]').forEach(button => { button.disabled = busy || !state?.canControl; });
}

async function refreshState() {
  state = await api('/api/state');
  $('identity').textContent = state.user.name;
  $('download-tab').hidden = $('bilibili-tab').hidden = !state.user.admin;
  if ($('settings-tab')) $('settings-tab').hidden = !state.user.admin;
  refreshControls();
}

async function select(media) {
  if (busy || !state?.canControl) return;
  busy = true;
  refreshControls();
  try {
    await refreshState();
    const result = await api('/api/media', { ...media, revision: state.revision });
    await refreshState();
    if (media.mode === 'online') sessionStorage.removeItem(`watch-source:${room}`);
    return result;
  } finally {
    busy = false;
    refreshControls();
  }
}

async function download(url) {
  if (downloading || !state?.user.admin) return;
  downloading = true;
  refreshControls();
  try {
    await api('/api/downloads', { url });
    notice('已加入下载队列');
    if (activeTab === 'download') await downloads();
  } finally {
    downloading = false;
    refreshControls();
  }
}

async function downloadBatch(urls) {
  if (downloading || !state?.user.admin) return;
  downloading = true;
  refreshControls();
  try {
    const result = await api('/api/downloads/batch', { urls });
    notice('已添加 ' + result.added + ' 集' + (result.skipped ? '，' + result.skipped + ' 集已在队列或已完成' : ''));
  } finally {
    downloading = false;
    refreshControls();
  }
}
function button(row, text, onClick, disabled = false) { const node = document.createElement('button'); node.textContent = text; node.disabled = disabled; node.onclick = () => attempt(onClick); row.append(node); return node; }
async function library() {
  const result = await api('/api/library'); libraryItems = result.items;
  const available = new Set(libraryItems.filter(media => media.removable).map(media => media.id));
  for (const id of selectedLibrary) if (!available.has(id)) selectedLibrary.delete(id);
  renderLibrary();
}
function filteredLibrary() {
  const query = ($('library-filter')?.value || '').trim().toLocaleLowerCase();
  return libraryItems.filter(media => !query || [media.title, media.seriesTitle, media.episodeTitle, media.group].join(' ').toLocaleLowerCase().includes(query));
}
function libraryControls() {
  const admin = !!state?.user.admin;
  if ($('library-toolbar')) $('library-toolbar').hidden = !admin;
  if ($('library-selection-count')) $('library-selection-count').textContent = `已选 ${selectedLibrary.size} 项`;
  if ($('library-remove-selected')) $('library-remove-selected').disabled = !admin || libraryBusy || !selectedLibrary.size;
  if ($('library-select-all')) $('library-select-all').disabled = !admin || libraryBusy || !filteredLibrary().some(media => media.removable);
  if ($('library-clear-selection')) $('library-clear-selection').disabled = libraryBusy || !selectedLibrary.size;
}
function renderLibrary() {
  $('library').replaceChildren(); const visible = filteredLibrary();
  if (!visible.length) $('library').textContent = libraryItems.length ? '没有匹配的媒体' : '媒体库还没有影片';
  const groups = new Map();
  for (const media of visible) { const key = media.seriesTitle || '其他媒体'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(media); }
  for (const [title, entries] of groups) {
    const section = document.createElement('section'); section.className = 'library-group';
    const heading = document.createElement('div'); heading.className = 'library-group-heading';
    const name = document.createElement('h3'); name.textContent = `${title} · ${entries.length}`; heading.append(name);
    if (state?.user.admin && entries.some(media => media.removable)) button(heading, '勾选本组', () => { for (const media of entries) if (media.removable) selectedLibrary.add(media.id); renderLibrary(); }, libraryBusy).className = 'quiet library-group-select';
    section.append(heading);
    for (const media of entries) {
      const row = document.createElement('div'); row.className = 'item library-item';
      if (state?.user.admin) {
        const choice = document.createElement('input'); choice.type = 'checkbox'; choice.className = 'library-choice'; choice.checked = selectedLibrary.has(media.id);
        choice.disabled = libraryBusy || !media.removable; choice.setAttribute('aria-label', `选择 ${media.title}`);
        if (!media.removable) choice.title = media.removeReason || '此媒体不能删除';
        choice.onchange = () => { if (choice.checked) selectedLibrary.add(media.id); else selectedLibrary.delete(media.id); libraryControls(); };
        row.append(choice);
      }
      const info = document.createElement('div'); info.className = 'library-meta'; const title = document.createElement('strong'); title.textContent = media.title;
      const detail = document.createElement('small'); detail.textContent = [media.group, media.episodeTitle, media.kind === 'hls' ? 'HLS' : '视频', state?.user.admin && !media.removable ? media.removeReason : ''].filter(Boolean).join(' · ');
      info.append(title, detail); row.append(info);
      const actions = document.createElement('div'); actions.className = 'library-actions';
      button(actions, '加载到放映室', async () => {
        const result = await select({ mode: 'local', id: media.id });
        if (result) notice(result.warning || '已加载到放映室', Boolean(result.warning));
      }, busy || !state?.canControl).dataset.libraryPlay = 'true';
      if (state?.user.admin) button(actions, '删除', () => removeLibrary([media.id]), libraryBusy || !media.removable).className = 'quiet danger';
      row.append(actions); section.append(row);
    }
    $('library').append(section);
  }
  libraryControls();
}
async function removeLibrary(ids) {
  if (libraryBusy || !state?.user.admin || !ids.length || !confirm(`删除选中的 ${ids.length} 个媒体及下载记录？`)) return;
  libraryBusy = true; renderLibrary();
  try {
    const result = await api('/api/library/remove', { ids });
    for (const id of result.ids) selectedLibrary.delete(id);
    await library(); notice(`已删除 ${result.removed} 个媒体`);
  } catch (error) { await library(); throw error; }
  finally { libraryBusy = false; renderLibrary(); }
}
if ($('library-filter')) $('library-filter').oninput = renderLibrary;
if ($('library-select-all')) $('library-select-all').onclick = () => { for (const media of filteredLibrary()) if (media.removable) selectedLibrary.add(media.id); renderLibrary(); };
if ($('library-clear-selection')) $('library-clear-selection').onclick = () => { selectedLibrary.clear(); renderLibrary(); };
if ($('library-remove-selected')) $('library-remove-selected').onclick = () => attempt(() => removeLibrary([...selectedLibrary]));
function eta(seconds) {
  const rounded = Math.ceil(seconds); if (rounded < 60) return `${rounded} 秒`;
  if (rounded < 3600) return `${Math.ceil(rounded / 60)} 分钟`;
  return `${Math.floor(rounded / 3600)} 小时 ${Math.ceil(rounded % 3600 / 60)} 分钟`;
}
function jobMetric(parent, label, value, className = '') {
  const metric = document.createElement('div'); metric.className = `job-metric ${className}`.trim();
  const caption = document.createElement('small'); caption.textContent = label;
  const content = document.createElement('strong'); content.textContent = value; metric.append(caption, content); parent.append(metric);
}
let loadingJobs = false;
async function downloads() {
  if (loadingJobs) return; loadingJobs = true;
  try {
    const expanded = new Set([...$('jobs').querySelectorAll('details[open]')].map(node => node.dataset.job));
    const result = await api('/api/downloads'); $('jobs').replaceChildren(); $('storage').textContent = `缓存 ${bytes(result.usedBytes)} / ${bytes(result.quota)}`;
    const labels = { queued: '排队中', running: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };
    const stages = { queued: '等待开始', resolving: '正在准备', playlist: '读取分段', downloading: '传输视频', cancelling: '正在取消', finalizing: '整理到媒体库', done: '可在媒体库播放', failed: '下载失败', cancelled: '任务已取消' };
    const counts = Object.fromEntries(Object.keys(labels).map(status => [status, result.jobs.filter(job => job.status === status).length]));
    $('queue-summary').textContent = `排队 ${counts.queued} · 进行中 ${counts.running} · 已完成 ${counts.done} · 失败 ${counts.failed} · 已取消 ${counts.cancelled}`;
    if (!result.jobs.length) $('jobs').textContent = '暂无下载任务';
    const queue = result.jobs.filter(job => job.status === 'queued');
    for (const job of result.jobs.slice().reverse()) {
      const active = ['running', 'queued'].includes(job.status);
      const ratio = job.status === 'done' ? 1 : job.kind === 'hls' && job.total ? job.completed / job.total : job.expectedBytes ? job.bytes / job.expectedBytes : null;
      const percent = ratio === null ? '未知' : `${Math.min(job.status === 'done' ? 100 : 99.9, Math.max(0, ratio * 100)).toFixed(1)}%`;
      const row = document.createElement('article'); row.className = 'item download-job'; $('jobs').append(row);
      const header = document.createElement('div'); header.className = 'job-header'; const name = document.createElement('strong'); name.textContent = job.title || job.source;
      const status = document.createElement('span'); status.className = `job-status status-${job.status}`; status.textContent = labels[job.status] || job.status; header.append(name, status); row.append(header);
      const stage = document.createElement('small'); stage.className = 'job-stage'; stage.textContent = [job.group, job.episodeTitle || (job.episodeNumber ? `第 ${job.episodeNumber} 集` : ''), stages[job.status === 'running' ? job.stage : job.status] || '处理中', job.status === 'queued' ? `队列第 ${queue.indexOf(job) + 1} 位` : ''].filter(Boolean).join(' · '); row.append(stage);
      const metrics = document.createElement('div'); metrics.className = 'job-metrics';
      jobMetric(metrics, '进度', percent, 'job-percent');
      jobMetric(metrics, '已下载 / 总量', `${bytes(job.bytes)} / ${job.expectedBytes ? bytes(job.expectedBytes) : '未知'}`, 'job-size');
      if (job.status === 'running' && job.stage === 'downloading') {
        const speed = Math.max(0, Number(job.speedBytesPerSecond) || 0); jobMetric(metrics, '实时速度', `${bytes(speed)}/s`, 'job-speed');
        if (speed > 0 && job.expectedBytes > job.bytes) jobMetric(metrics, '预计剩余', eta((job.expectedBytes - job.bytes) / speed), 'job-eta');
      }
      if (job.kind === 'hls') jobMetric(metrics, '分段', `${job.completed || 0} / ${job.total || '未知'}`, 'job-segments');
      row.append(metrics);
      if (ratio !== null || job.status === 'running') { const progress = document.createElement('progress'); progress.className = 'job-progress'; progress.max = 1; if (ratio !== null) progress.value = Math.max(0, Math.min(1, ratio)); progress.setAttribute('aria-label', `${job.title} 下载进度`); row.append(progress); }
      if (job.error) { const error = document.createElement('p'); error.className = 'download-error'; error.textContent = job.error; row.append(error); }
      const metadata = document.createElement('details'); metadata.dataset.job = job.id; metadata.open = expanded.has(job.id);
      const summary = document.createElement('summary'); summary.textContent = '任务详情'; metadata.append(summary);
      const info = document.createElement('p'); info.textContent = `任务 ${job.id} · ${job.kind === 'hls' ? 'HLS' : job.kind === 'mp4' ? 'MP4' : '待解析'}${job.seriesTitle ? ` · ${job.seriesTitle}` : ''}`; metadata.append(info);
      const dates = document.createElement('p'); dates.textContent = [['添加', job.createdAt], ['开始', job.startedAt], ['结束', job.finishedAt]].filter(([, value]) => value).map(([label, value]) => `${label} ${new Date(value).toLocaleString('zh-CN')}`).join(' · '); metadata.append(dates);
      try { const source = new URL(job.source); if (['http:', 'https:'].includes(source.protocol)) { const link = document.createElement('a'); link.href = source.href; link.textContent = '查看原始片源'; link.target = '_blank'; link.rel = 'noreferrer noopener'; metadata.append(link); } } catch { /* Old records can lack a source. */ }
      row.append(metadata);
      const actions = document.createElement('div'); actions.className = 'job-actions'; row.append(actions);
      button(actions, active ? '取消下载' : '删除记录与文件', async () => { if (job.status === 'done' && !confirm('删除这个已下载的视频及任务记录？')) return; await api(`/api/downloads/${job.id}/remove`, {}); await downloads(); });
      if (['failed', 'cancelled'].includes(job.status)) button(actions, '重新排队', () => download(job.source));
    }
  } finally { loadingJobs = false; }
}
$('refresh-library').onclick = () => attempt(library);
$('download-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  const source = $('download-source').value.trim(); const url = new URL(source);
  if (url.origin === 'https://ani.girigirilove.com' && /^\/(?:GV\d+|playGV\d+-\d+-\d+|detail\/\d+|play\/\d+)\/?$/.test(url.pathname)) {
    document.querySelector('[data-tab="online"]').click(); await discovery.inspect(source); notice('已读取完整剧集，请选择线路并勾选要下载的集数。');
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
const cacheProviders = ['bilibili', 'girigiri', 'online'];
let youtubeBusy = false;
function youtubeHeaderCookies(header) {
  if (/[\r\n\t]/.test(header) || header.length > 65536) throw new Error('请只复制一行 Cookie 请求头');
  return header.replace(/^cookie:\s*/i, '').split(';').map(pair => {
    const match = /^([\w-]+)=([\x21-\x3a\x3c-\x7e]*)$/.exec(pair.trim());
    if (!match) throw new Error('请复制 Cookie 请求头的完整值');
    return ['www.youtube.com', 'FALSE', '/', 'TRUE', '0', match[1], match[2]].join('\t');
  }).join('\n');
}
async function youtubeAccount(action) {
  if (youtubeBusy || !state?.user.admin) return;
  youtubeBusy = true;
  $('youtube-bind').disabled = $('youtube-remove').disabled = true;
  try {
    let result;
    if (action === 'bind') {
      const file = $('youtube-cookies').files[0];
      const header = $('youtube-cookie-header').value.trim();
      if (Boolean(file) === Boolean(header)) throw new Error('请选择一种方式：粘贴 Cookie 或导入 cookies.txt');
      if (file && file.size > 65536) throw new Error('请选择小于 64 KiB 的 cookies.txt');
      const cookies = header ? youtubeHeaderCookies(header) : (await file.text()).split(/\r?\n/).filter(line => /^(?:#HttpOnly_)?\.?(?:www\.)?youtube\.com\t/.test(line)).join('\n');
      result = await api('/api/youtube/account', { cookies });
    } else if (action === 'remove') result = await api('/api/youtube/account/logout', {});
    else result = await api('/api/youtube/account');
    $('youtube-status').textContent = result.saved ? '已保存登录会话' : '未绑定（匿名播放）';
    $('youtube-remove').hidden = !result.saved;
  } finally {
    if (action === 'bind') $('youtube-cookies').value = $('youtube-cookie-header').value = '';
    youtubeBusy = false;
    $('youtube-bind').disabled = $('youtube-remove').disabled = false;
  }
}
$('youtube-account-form').onsubmit = event => { event.preventDefault(); attempt(() => youtubeAccount('bind')); };
$('youtube-remove').onclick = () => attempt(() => youtubeAccount('remove'));
async function playbackSettings(save = false) {
  if (settingsBusy || !state?.user.admin) return; settingsBusy = true;
  const delivery = $('playback-delivery') || $('bilibili-delivery');
  $('save-playback-settings').disabled = $('relay-prefetch').disabled = delivery.disabled = true;
  const cacheFields = cacheProviders.flatMap(provider => ['enabled', 'capacity', 'retention'].map(field => $(`cache-${provider}-${field}`)));
  cacheFields.forEach(field => { field.disabled = true; });
  $('playback-settings-status').textContent = save ? '保存中…' : '读取中…';
  try {
    const relayCache = Object.fromEntries(cacheProviders.map(provider => [provider, {
      enabled: $(`cache-${provider}-enabled`).checked,
      maxGiB: Number($(`cache-${provider}-capacity`).value),
      ttlHours: Number($(`cache-${provider}-retention`).value),
    }]));
    const result = await api('/api/settings/playback', save ? { delivery: delivery.value, prefetch: $('relay-prefetch').checked, relayCache } : undefined);
    $('relay-prefetch').checked = result.prefetch !== false;
    delivery.value = (result.delivery ?? result.bilibiliDelivery) === 'proxy' ? 'proxy' : 'direct';
    for (const provider of cacheProviders) {
      const settings = result.relayCache?.[provider];
      if (settings) {
        $(`cache-${provider}-enabled`).checked = settings.enabled;
        $(`cache-${provider}-capacity`).value = settings.maxGiB;
        $(`cache-${provider}-retention`).value = settings.ttlHours;
      }
      const usage = result.cacheUsage?.[provider];
      $(`cache-${provider}-usage`).textContent = usage ? `已缓存 ${bytes(usage.bytes)} · ${usage.entries} 项` : '';
    }
    $('playback-settings-status').textContent = save ? '已保存。缓存设置已应用，播放方式在下次选片生效。' : '';
  } catch (error) { $('playback-settings-status').textContent = error.message || '设置暂不可用'; throw error; }
  finally { settingsBusy = false; $('save-playback-settings').disabled = $('relay-prefetch').disabled = delivery.disabled = false; cacheFields.forEach(field => { field.disabled = false; }); }
}
$('playback-settings-form').onsubmit = event => { event.preventDefault(); attempt(() => playbackSettings(true)); };
document.addEventListener('visibilitychange', () => { if (document.hidden) stopQrPolling(); else queueQrPoll(); });
window.addEventListener('pagehide', () => { pageLeaving = true; stopQrPolling(); });
window.addEventListener('pageshow', () => { pageLeaving = false; queueQrPoll(); });
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => {
  if (['bilibili', 'download', 'settings'].includes(tab.dataset.tab) && !state?.user.admin) return;
  stopQrPolling(); activeTab = tab.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node === tab));
  for (const name of ['online', 'local', 'download', 'bilibili', 'settings']) if ($(`${name}-panel`)) $(`${name}-panel`).hidden = name !== activeTab;
  if (activeTab === 'local') attempt(library);
  if (activeTab === 'download') attempt(downloads);
  if (activeTab === 'bilibili') { attempt(() => loadAccount()); queueQrPoll(); }
  if (activeTab === 'settings') { attempt(() => playbackSettings()); attempt(() => youtubeAccount()); }
}; });
setInterval(() => { if (!document.hidden && state?.user.admin && activeTab === 'download') attempt(downloads); }, 2000);
attempt(async () => {
  if (!room) return; $('home').href = $('back').href = `/room/${room}`;
  const seed = new URLSearchParams(location.hash.slice(1)).get('source'); history.replaceState(null, '', location.pathname); if (seed) sessionStorage.setItem(`watch-source:${room}`, seed);
  discovery.setSource(seed || sessionStorage.getItem(`watch-source:${room}`) || '');
  await refreshState();
  discovery.showMedia(state.media);
});
