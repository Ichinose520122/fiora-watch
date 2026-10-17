/* global Hls, dashjs */
import { createPlayer } from './player.js';
import { mountAtomPlayer } from './atom-adapter.js';
import { createDanmaku } from './danmaku.js';
const $ = id => document.getElementById(id);
let room = /^\/room\/([a-f0-9]+)$/.exec(location.pathname)?.[1];
let state; let receivedAt = 0; let currentMedia = ''; let mediaVersion = -1; let hls; let dash; let enabled = false; let events; let applying = false; let controlBusy = false; let episodeBusy = false; let episodeSignature = '';
let chatBusy = false; let sending = false; let lastMessages = ''; let pendingSend; let scrollAfterSend = false; let noticeTimer;
let sourceGeneration = 0; let fallbackUsed = false; let activeSource = ''; let activeDelivery = ''; let playAttempt = 0; let locallySeeking = false;
let seekTimer;
const atomShell = mountAtomPlayer({ requestControl: requestPlayerControl });
const video = atomShell.video;
const danmaku = createDanmaku({ container: $('danmaku-layer'), button: $('danmaku-toggle'), video });
const player = createPlayer({ video, atom: atomShell.atom, notify: text => notice(text, true), subtitles: async (version, signal) => {
  const response = await fetch(`/api/bilibili/subtitles?room=${encodeURIComponent(room)}&version=${encodeURIComponent(version)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { 'X-Watch-Request': '1', 'X-Watch-Room': room || '' } });
  if (!response.ok) throw new Error('字幕暂时不可用');
  return response.json();
} });
atomShell.setFullscreen(player.toggleFullscreen);
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (text && !error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
const time = value => { const seconds = Math.max(0, Math.floor(value || 0)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(url === '/api/media' ? 45000 : 15000), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { video.pause(); enabled = false; }
    throw Object.assign(new Error(result.error || '请求失败'), { status: response.status });
  }
  return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
function target() { return state ? state.position + (state.paused ? 0 : Math.max(0, (state.serverTime - state.updatedAt) / 1000 + (performance.now() - receivedAt) / 1000)) : 0; }
function playbackStatus() {
  const mode = activeDelivery === 'direct' ? '用户端直连' : activeDelivery === 'proxy' ? '服务器中转' : '';
  $('playback-status').textContent = [!state?.media ? '等待选择影片' : state.canControl ? '与你同步' : '跟随房间播放', mode].filter(Boolean).join(' · ');
  $('delivery-status').textContent = mode; $('delivery-status').hidden = !mode;
}
function synchronize() {
  if (!state?.media || video.readyState < 1 || !enabled || applying || locallySeeking) return;
  const goal = Math.min(target(), Number.isFinite(video.duration) ? video.duration : Infinity);
  if (Math.abs(video.currentTime - goal) > 1.2) video.currentTime = goal;
  if (state.paused) { video.pause(); return; }
  if (video.paused && !video.ended) {
    applying = true; const attempt = ++playAttempt; const generation = sourceGeneration;
    video.play().catch(error => { if (generation === sourceGeneration && attempt === playAttempt && error.name !== 'AbortError') { enabled = false; $('join').hidden = false; } }).finally(() => { if (attempt === playAttempt) applying = false; });
  }
}
function loadMedia(source, { preserve = false } = {}) {
  const generation = ++sourceGeneration; activeSource = source; playAttempt += 1; applying = false;
  clearTimeout(seekTimer); locallySeeking = false; danmaku.clear(); atomShell.reset();
  activeDelivery = !source ? '' : fallbackUsed && source === state?.media?.fallbackUrl ? 'proxy' : state?.media?.playbackMode || ''; playbackStatus();
  video.onerror = null; $('seek').value = String(Math.max(0, target()));
  hls?.destroy(); hls = null; dash?.reset(); dash = null; video.pause(); video.removeAttribute('src');
  player.begin(state?.media, mediaVersion, { preserve }); video.load(); $('empty').hidden = !!source;
  if (!source) return;
  const failed = () => {
    if (generation !== sourceGeneration || source !== activeSource) return;
    const fallback = state?.media?.fallbackUrl;
    if (!fallbackUsed && state?.media?.playbackMode === 'direct' && fallback && fallback !== source && new URL(fallback, location.origin).origin === location.origin) {
      fallbackUsed = true; loadMedia(fallback, { preserve: true }); notice('直连受来源限制，已改用服务器加载'); return;
    }
    player.fail('影片暂时无法加载，请重试或更换片源。'); notice('影片暂时无法加载，请重试或更换片源。', true);
  };
  if (state.media.kind === 'dash') {
    if (typeof dashjs === 'undefined') { player.fail('播放器未就绪，请刷新后重试。'); return; }
    const instance = dashjs.MediaPlayer().create(); dash = instance;
    instance.updateSettings({ streaming: { buffer: { bufferTimeDefault: 30 } } });
    player.attachDash(instance, dashjs.MediaPlayer.events);
    instance.on(dashjs.MediaPlayer.events.ERROR, event => { if (event.error) failed(); });
    instance.initialize(video, source, false);
  } else if (state.media.kind === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const instance = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 }); hls = instance;
    player.attachHls(instance, Hls.Events); instance.loadSource(source); instance.attachMedia(video);
    instance.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) failed(); });
  } else video.src = source;
  video.onerror = () => { if (video.error) failed(); };
}
function receive(next) {
  if (state && next.revision < state.revision) return;
  state = next; receivedAt = performance.now();
  $('identity').textContent = next.user.name; $('logout').hidden = false;
  $('connection').textContent = next.paused ? '已暂停' : '同步播放中';
  $('title').textContent = next.media?.title || '今晚看什么？';
  playbackStatus();
  $('back-to-fiora').href = next.fioraUrl;
  $('toggle').textContent = next.paused ? '▶' : 'Ⅱ'; $('toggle').setAttribute('aria-label', next.paused ? '播放' : '暂停');
  $('toggle').disabled = $('seek').disabled = !next.canControl || !next.media;
  $('join').hidden = enabled || !next.media;
  atomShell.update(next);
  renderEpisodes();
  const source = next.media?.url || '';
  if (source !== currentMedia || (next.mediaVersion || 0) !== mediaVersion) {
    currentMedia = source; mediaVersion = next.mediaVersion || 0; fallbackUsed = false; notice(''); video.poster = next.media?.cover || '';
    locallySeeking = false; loadMedia(source);
  }
  synchronize();
}
async function action(action, extra = {}) {
  if (controlBusy || !state?.canControl || !state.media || episodeBusy) return;
  controlBusy = true;
  try { await api('/api/control', { action, revision: state.revision, ...extra }); receive(await api('/api/state')); }
  catch (error) { receive(await api('/api/state')); throw error; }
  finally { controlBusy = false; }
}
function unlock() {
  enabled = true; $('join').hidden = true; const generation = sourceGeneration;
  return video.play().then(() => { if (generation === sourceGeneration) synchronize(); }).catch(error => { if (generation === sourceGeneration && error.name !== 'AbortError') { enabled = false; $('join').hidden = false; } });
}
function togglePlayback() {
  if (!state?.media || controlBusy || episodeBusy) return;
  if (!state.canControl) { if (!enabled) void unlock(); return; }
  const command = state.paused ? 'play' : 'pause';
  if (command === 'play' && !enabled) {
    void unlock();
  }
  attempt(() => action(command));
}
function requestPlayerControl(command, position) {
  if (!state?.media || !activeSource || episodeBusy) return;
  if (command === 'play' && !enabled) void unlock();
  if (!state.canControl) return;
  if (command === 'seek') {
    if (!Number.isFinite(position) || video.readyState < 1) return;
    const generation = sourceGeneration;
    const value = Math.max(0, Math.min(position, Number.isFinite(video.duration) ? video.duration : position));
    clearTimeout(seekTimer); locallySeeking = true;
    const commit = () => {
      if (generation !== sourceGeneration) return;
      if (controlBusy) { seekTimer = setTimeout(commit, 100); return; }
      attempt(async () => { try { await action('seek', { position: value }); } finally { locallySeeking = false; synchronize(); } });
    };
    seekTimer = setTimeout(commit, 100);
    return;
  }
  if (command === 'play' && state.paused || command === 'pause' && !state.paused) attempt(() => action(command));
}
$('join').onclick = () => state?.canControl && state.paused ? togglePlayback() : unlock();
$('toggle').onclick = togglePlayback;
if (!atomShell.active) video.addEventListener('click', togglePlayback);
function adjacentEpisode(direction) {
  const episodes = state?.media?.episodes || []; const index = state?.media?.episodeIndex || 0;
  const next = index + direction;
  return episodes[next] && episodes[next].group === episodes[index]?.group ? next : -1;
}
$('previous-episode').onclick = () => attempt(() => selectEpisode(adjacentEpisode(-1)));
$('next-episode').onclick = () => attempt(() => selectEpisode(adjacentEpisode(1)));
function renderEpisodes() {
  const episodes = state?.media?.episodes || []; const index = state?.media?.episodeIndex || 0;
  $('episode-panel').hidden = !episodes.length;
  $('episode-panel').setAttribute('aria-busy', String(episodeBusy));
  const groupCount = new Set(episodes.map(episode => episode.group || '')).size;
  const groupEpisodes = episodes.filter(episode => episode.group === episodes[index]?.group).length;
  $('episode-count').textContent = groupCount > 1 ? `${groupEpisodes} 集 · ${groupCount} 条线路` : `${episodes.length}`;
  $('previous-episode').disabled = episodeBusy || !state?.canControl || adjacentEpisode(-1) < 0;
  $('next-episode').disabled = episodeBusy || !state?.canControl || adjacentEpisode(1) < 0;
  const signature = JSON.stringify([episodes, index, state?.canControl, episodeBusy]);
  if (signature === episodeSignature) return; episodeSignature = signature;
  $('episodes').replaceChildren();
  let previousGroup;
  episodes.forEach((episode, position) => {
    if (episode.group && episode.group !== previousGroup) { const heading = document.createElement('div'); heading.className = 'episode-group'; heading.textContent = episode.group; $('episodes').append(heading); previousGroup = episode.group; }
    const button = document.createElement('button'); button.textContent = episode.title || `第 ${position + 1} 集`;
    button.className = position === index ? 'episode active' : 'episode'; button.title = episode.group ? `${episode.group} · ${button.textContent}` : button.textContent;
    button.setAttribute('aria-current', position === index ? 'true' : 'false');
    button.disabled = episodeBusy || !state.canControl || position === index;
    button.onclick = () => attempt(() => selectEpisode(position)); $('episodes').append(button);
  });
}
async function selectEpisode(index) {
  const episode = state?.media?.episodes?.[index];
  if (!episode || !state.canControl || episodeBusy || controlBusy || index === state.media.episodeIndex) return;
  episodeBusy = true; renderEpisodes();
  try { const result = await api('/api/media', { mode: 'online', url: episode.url, revision: state.revision }); receive(await api('/api/state')); if (result.warning) notice(result.warning, true); }
  catch (error) { receive(await api('/api/state')); throw error; }
  finally { episodeBusy = false; renderEpisodes(); }
}
$('seek').oninput = () => { locallySeeking = true; };
$('seek').onchange = event => { const position = Number(event.target.value); attempt(async () => { try { await action('seek', { position }); } finally { locallySeeking = false; synchronize(); } }); };
$('seek').onblur = () => { locallySeeking = false; synchronize(); };
$('volume').oninput = event => { video.volume = Number(event.target.value); };
$('retry-player').onclick = () => { if (state?.media) { notice(''); loadMedia(fallbackUsed ? state.media.fallbackUrl : currentMedia, { preserve: true }); } };
video.addEventListener('loadedmetadata', synchronize); video.addEventListener('canplay', synchronize);
video.addEventListener('ended', () => { if (state?.canControl && !state.paused) attempt(() => action('pause')); });
const decodeText = value => String(value || '').replace(/&(?:lt|gt|amp|quot|#39);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" })[entity]);
function renderMessages(messages) {
  const signature = JSON.stringify(messages); if (signature === lastMessages && !scrollAfterSend) return;
  const list = $('messages'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
  const oldScroll = list.scrollTop; lastMessages = signature; list.replaceChildren();
  if (!messages.length) { const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = '这一刻，想说些什么？'; list.append(empty); }
  for (const message of messages) {
    const row = document.createElement('div'); row.className = `chat-message${message.user.id === state.user.id ? ' self' : ''}${message.deleted ? ' deleted' : ''}`;
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = Array.from(message.user.name)[0] || '·';
    const main = document.createElement('div'); main.className = 'message-main';
    const byline = document.createElement('div'); byline.className = 'message-byline'; byline.textContent = message.user.name;
    const stamp = document.createElement('time'); stamp.textContent = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); byline.append(stamp);
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.deleted ? '消息已撤回' : decodeText(message.content);
    main.append(byline, bubble); row.append(avatar, main); list.append(row);
  }
  list.scrollTop = nearBottom || scrollAfterSend ? list.scrollHeight : oldScroll; scrollAfterSend = false;
}
async function refreshChat() {
  if (!state || chatBusy) return;
  chatBusy = true;
  try {
    const result = await api('/api/chat'); danmaku.ingest(result.messages, state.user.id); renderMessages(result.messages);
    $('chat-status').textContent = '已同步'; $('chat-error').hidden = true;
    $('comment').disabled = false; $('send-comment').disabled = sending;
  } catch (error) {
    $('chat-status').textContent = '未连接'; $('chat-error').hidden = false; $('chat-error').textContent = error.message;
    if ([401, 403, 409].includes(error.status)) { $('comment').disabled = true; $('send-comment').disabled = true; }
  } finally { chatBusy = false; }
}
$('comment-form').onsubmit = async event => {
  event.preventDefault(); const text = $('comment').value.trim(); if (!text || sending || !state) return;
  if (!pendingSend || pendingSend.text !== text) pendingSend = { text, id: crypto.randomUUID() };
  sending = true; $('send-comment').disabled = true;
  try {
    await api('/api/chat', { content: text, requestId: pendingSend.id });
    pendingSend = null; if ($('comment').value.trim() === text) $('comment').value = '';
    scrollAfterSend = true; await refreshChat();
  } catch (error) { $('chat-error').textContent = error.message; $('chat-error').hidden = false; }
  finally { sending = false; $('send-comment').disabled = $('comment').disabled; }
};
$('comment').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('comment-form').requestSubmit(); } };
$('logout').onclick = () => attempt(async () => { await api('/api/logout', {}); events?.close(); location.replace('/'); });
setInterval(() => {
  if (!state) return; synchronize();
  $('time').textContent = `${time(video.currentTime)} / ${time(Number.isFinite(video.duration) ? video.duration : 0)}`;
  if (Number.isFinite(video.duration)) { $('seek').max = String(video.duration); if (document.activeElement !== $('seek')) $('seek').value = String(video.currentTime); }
}, 1000);
setInterval(refreshChat, 2000);
attempt(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1)); const ticket = fragment.get('ticket');
  if (ticket) {
    history.replaceState(null, '', '/'); const result = await api('/api/session', { ticket }); room = result.room;
    const source = fragment.get('source'); if (source) sessionStorage.setItem(`watch-source:${room}`, source);
    history.replaceState(null, '', `/room/${room}`);
  }
  if (!room) { notice('从 Fiora 的影院邀请进入。'); $('chat-status').textContent = '未登录'; return; }
  $('home').href = `/room/${room}`;
  const seed = sessionStorage.getItem(`watch-source:${room}`);
  const management = `/room/${room}/manage${seed ? '#source=' + encodeURIComponent(seed) : ''}`; $('manage').href = management; $('choose-source').href = management;
  receive(await api('/api/state')); void refreshChat();
  if (!atomShell.active) notice('Atom 播放器未能加载，暂用基础播放器；刷新页面可重试。', true);
  events = new EventSource(`/api/events?room=${encodeURIComponent(room)}`);
  events.onmessage = event => receive(JSON.parse(event.data));
  events.onerror = () => { video.pause(); enabled = false; $('join').hidden = !state?.media; $('connection').textContent = '重新连接中'; };
});
