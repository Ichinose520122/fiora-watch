/* global Hls, dashjs */
import { createPlayer } from './player.js';
import { mountAtomPlayer } from './atom-adapter.js';
import { createDanmaku } from './danmaku.js';
import { loadMediaEngine } from './media-engine.js';
import { createDiscovery } from './discovery.js';
const $ = id => document.getElementById(id);
let room = /^\/room\/([a-f0-9]+)$/.exec(location.pathname)?.[1];
let state; let receivedAt = 0; let currentMedia = ''; let mediaVersion = -1; let hls; let dash; let enabled = true; let events; let applying = false; let controlBusy = false; let episodeBusy = false; let episodeSignature = '';
let chatBusy = false; let sending = false; let lastMessages = ''; let pendingSend; let scrollAfterSend = false; let noticeTimer;
let sourceGeneration = 0; let fallbackUsed = false; let activeSource = ''; let playAttempt = 0; let locallySeeking = false;
let seekTimer; let seekSequence = 0; let seekDragging = false;
let autoplayBlocked = false; let autoMuted = false; let startupTimer; let armStartup;
let pendingSeek = false; let queuedPlayback; let inflightPlayback; let drainingPlayback = false;
let prerollTimer;
const discovery = createDiscovery({ api, getState: () => state, select: selectMedia });
const atomShell = mountAtomPlayer({ requestControl: requestPlayerControl });
const video = atomShell.video;
const danmaku = createDanmaku({ container: $('danmaku-layer'), button: $('danmaku-toggle'), video });
const player = createPlayer({ video, notify: text => notice(text, true), subtitles: async (version, signal) => {
  const response = await fetch(`/api/bilibili/subtitles?room=${encodeURIComponent(room)}&version=${encodeURIComponent(version)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { 'X-Watch-Request': '1', 'X-Watch-Room': room || '' } });
  if (!response.ok) throw new Error('字幕暂时不可用');
  return response.json();
} });
atomShell.setFullscreen(player.toggleFullscreen);
function notice(text, error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); if (text && !error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500); }
const time = value => { const seconds = Math.max(0, Math.floor(value || 0)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };
async function api(url, body) {
  const timeout = url === '/api/media' || url.startsWith('/api/catalog/') ? 45000 : 15000;
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { video.pause(); enabled = false; }
    throw Object.assign(new Error(result.error || '请求失败'), { status: response.status });
  }
  return result;
}
function attempt(task) { return Promise.resolve().then(task).catch(error => notice(error.message, true)); }
function target() { return state ? state.position + (state.paused ? 0 : Math.max(0, (state.serverTime - state.updatedAt) / 1000 + (performance.now() - receivedAt) / 1000)) : 0; }
function startDelay() {
  if (!state?.media || state.paused) return 0;
  return Math.max(0, state.updatedAt - state.serverTime - (performance.now() - receivedAt));
}
function playbackStatus() {
  $('playback-status').textContent = !state?.media ? '等待选择影片' : startDelay() > 0 ? '正在预缓冲…' : state.canControl ? '房间同步播放' : '跟随房间播放';
}
function replayPending() { return [queuedPlayback, inflightPlayback].some(intent => intent?.version === mediaVersion && intent.restart); }
function synchronize({ forceSeek = false } = {}) {
  clearTimeout(prerollTimer);
  if (!state?.media) return;
  const delay = startDelay();
  if (delay > 0) prerollTimer = setTimeout(synchronize, Math.ceil(delay));
  else if ($('connection').textContent === '预缓冲中') {
    $('connection').textContent = state.paused ? '已暂停' : '同步播放中';
    playbackStatus();
    updateJoin();
  }
  if (forceSeek) pendingSeek = true;
  // An older room snapshot must not seek a requested replay back to the ending.
  if (replayPending()) return;
  if (state.paused || delay > 0) video.pause();
  if (video.readyState < 1 || locallySeeking) return;
  const goal = Math.min(target(), Number.isFinite(video.duration) ? video.duration : Infinity);
  const drift = Math.abs(video.currentTime - goal);
  // A stalled decoder needs time to fill its buffer. Repeated clock corrections discard that work.
  const canCorrect = state.paused || (!video.paused && video.played?.length > 0 && !video.seeking && video.readyState >= 3);
  if (pendingSeek || (!applying && canCorrect && drift > 1.2)) {
    if (drift > 0.05) video.currentTime = goal;
    pendingSeek = false;
  }
  if (!applying && !state.paused && !delay && enabled && video.paused && !video.ended) void playLocal();
}
async function playLocal({ manual = false } = {}) {
  if (startDelay() > 0) return;
  applying = true; const attempt = ++playAttempt; const generation = sourceGeneration;
  const current = () => generation === sourceGeneration && attempt === playAttempt;
  try { await video.play(); }
  catch (error) {
    if (!current() || (state?.paused && !manual) || error.name !== 'NotAllowedError') return;
    // Autoplay policy may allow silent playback even when audible play is blocked.
    if (!video.muted) {
      video.muted = true; autoMuted = true; $('unmute').hidden = false;
      try { await video.play(); return; }
      catch (retryError) { if (!current() || retryError.name !== 'NotAllowedError') return; }
    }
    if (current()) { autoplayBlocked = true; enabled = false; $('join').hidden = false; }
  } finally {
    if (current()) { applying = false; if (state?.paused || !enabled) video.pause(); updateJoin(); }
  }
}
function loadMedia(source, { preserve = false } = {}) {
  clearTimeout(startupTimer); armStartup = undefined;
  const generation = ++sourceGeneration; activeSource = source; playAttempt += 1; applying = false;
  pendingSeek = Boolean(source); if (!preserve) queuedPlayback = undefined;
  clearTimeout(seekTimer); seekSequence += 1; seekDragging = false; locallySeeking = false; danmaku.clear(); atomShell.reset();
  playbackStatus();
  video.onerror = null; $('seek').value = String(Math.max(0, target()));
  hls?.destroy(); hls = null; dash?.reset(); dash = null; video.pause(); video.removeAttribute('src');
  player.begin(state?.media, mediaVersion, { preserve }); video.load(); $('empty').hidden = !!source;
  if (!source) return;
  const failed = () => {
    if (generation !== sourceGeneration || source !== activeSource) return;
    clearTimeout(startupTimer); armStartup = undefined;
    const fallback = state?.media?.fallbackUrl;
    if (!fallbackUsed && state?.media?.playbackMode === 'direct' && fallback && fallback !== source && new URL(fallback, location.origin).origin === location.origin) {
      fallbackUsed = true; loadMedia(fallback, { preserve: true }); notice('已自动调整播放方式，正在重新加载…'); return;
    }
    player.fail('影片暂时无法加载，请重试或更换片源。'); notice('影片暂时无法加载，请重试或更换片源。', true);
  };
  const kind = state.media.kind;
  void loadMediaEngine(kind, video).then(() => {
    if (generation !== sourceGeneration) return;
    if (kind === 'dash') {
      if (typeof dashjs === 'undefined') { player.fail('播放器未就绪，请刷新后重试。'); return; }
      const instance = dashjs.MediaPlayer().create(); dash = instance;
      instance.updateSettings({ streaming: { buffer: {
        bufferTimeDefault: 90, bufferTimeAtTopQuality: 90, bufferTimeAtTopQualityLongForm: 120, bufferToKeep: 30,
      } } });
      player.attachDash(instance, dashjs.MediaPlayer.events);
      instance.on(dashjs.MediaPlayer.events.ERROR, event => { if (event.error) failed(); });
      instance.initialize(video, source, false, target());
    } else if (kind === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const instance = new Hls({ maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 30 }); hls = instance;
      player.attachHls(instance, Hls.Events); instance.loadSource(source); instance.attachMedia(video);
      instance.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) failed(); });
    } else video.src = source;
    video.onerror = () => { if (video.error) failed(); };
    // Engine scripts have their own deadline. Start timing the CDN only after attachment.
    if (generation !== sourceGeneration) return;
    armStartup = () => {
      clearTimeout(startupTimer);
      startupTimer = setTimeout(() => {
        if (!autoplayBlocked && (video.readyState < 2 || (!state.paused && !video.ended && !video.played.length))) failed();
      }, (!fallbackUsed && state.media.fallbackUrl ? 15000 : 30000) + startDelay());
    };
    armStartup();
  }).catch(error => {
    if (generation === sourceGeneration) { player.fail(error.message || '播放组件加载失败，请重试。'); notice(error.message || '播放组件加载失败，请重试。', true); }
  });
}
function receive(next) {
  if (state && next.revision < state.revision) return;
  const timelineChanged = state && next.revision > state.revision && next.mediaVersion === state.mediaVersion &&
    (((next.paused || !state.paused) && next.position !== state.position) ||
      next.position < state.position || (state.ended && !next.ended));
  state = next; receivedAt = performance.now();
  if (!next.canControl || !next.media) queuedPlayback = undefined;
  if (!next.canControl && locallySeeking) {
    clearTimeout(seekTimer); seekSequence += 1; seekDragging = false; locallySeeking = false;
  }
  $('identity').textContent = next.user.name; $('logout').hidden = $('manage').hidden = false;
  $('connection').textContent = !next.media ? '等待选片' : next.paused ? '已暂停' : startDelay() > 0 ? '预缓冲中' : '同步播放中';
  $('choose-source').hidden = !next.canControl;
  $('empty-hint').textContent = next.canControl ? '在下方搜索影片或粘贴链接。' : '等待房间成员选择影片。';
  $('movie-meta').hidden = !next.media;
  $('title').textContent = next.media?.title || '尚未选择影片';
  playbackStatus();
  $('back-to-fiora').href = next.fioraUrl;
  $('toggle').textContent = next.paused ? '▶' : 'Ⅱ'; $('toggle').setAttribute('aria-label', next.paused ? '播放' : '暂停');
  $('toggle').disabled = $('seek').disabled = !next.canControl || !next.media;
  atomShell.update(next);
  renderEpisodes();
  discovery.refresh();
  const source = next.media?.url || '';
  if (source !== currentMedia || (next.mediaVersion || 0) !== mediaVersion) {
    currentMedia = source; mediaVersion = next.mediaVersion || 0; fallbackUsed = false; notice(''); video.poster = next.media?.cover || '';
    locallySeeking = false; loadMedia(source);
  }
  synchronize({ forceSeek: Boolean(timelineChanged) });
  updateJoin();
}
function updateJoin() {
  const waitingForGesture = !state?.canControl && video.paused && video.readyState < 2 && !applying;
  $('join').hidden = !state?.media || state.paused || startDelay() > 0 || (enabled && !waitingForGesture);
}
async function action(action, extra = {}) {
  if (controlBusy || !state?.canControl || !state.media || episodeBusy) return false;
  controlBusy = true;
  try { await api('/api/control', { action, revision: state.revision, mediaVersion, ...extra }); receive(await api('/api/state')); return true; }
  catch (error) { receive(await api('/api/state')); throw error; }
  finally { controlBusy = false; void drainPlayback(); }
}
function effectivePaused() {
  return queuedPlayback?.paused ?? (inflightPlayback?.version === mediaVersion ? inflightPlayback.paused : state?.paused);
}
async function drainPlayback() {
  if (drainingPlayback || controlBusy) return;
  drainingPlayback = true;
  try {
    while (queuedPlayback) {
      const intent = queuedPlayback; queuedPlayback = undefined;
      if (intent.version !== mediaVersion || !state?.canControl || !state.media || episodeBusy) continue;
      inflightPlayback = intent;
      if (intent.restart || intent.paused !== state.paused) await action(intent.paused ? 'pause' : 'play', intent.restart ? { restart: true } : {});
      inflightPlayback = undefined;
      synchronize();
    }
  } catch (error) { notice(error.message, true); }
  finally { inflightPlayback = undefined; drainingPlayback = false; synchronize(); if (queuedPlayback) void drainPlayback(); }
}
function queuePlayback(command) {
  if (!state?.media || episodeBusy) return;
  if (!state.canControl) {
    if (!state.paused && (video.paused || !enabled)) void unlock();
    else notice('当前房间由群主或管理员控制播放');
    return;
  }
  const finished = Boolean(state.ended || video.ended);
  const paused = command === 'toggle' ? finished && !replayPending() ? false : !effectivePaused() : command === 'pause';
  const restart = !paused && (finished || replayPending());
  queuedPlayback = { paused, restart, version: mediaVersion };
  if (restart && video.readyState >= 1) video.currentTime = 0;
  if (!paused) void unlock({ start: true });
  void drainPlayback();
}
function unlock({ start = false } = {}) {
  enabled = true; autoplayBlocked = false; $('join').hidden = true;
  armStartup?.();
  if (autoMuted) { video.muted = false; autoMuted = false; $('unmute').hidden = true; }
  if (state?.paused && !start) return Promise.resolve();
  return playLocal({ manual: start });
}
function togglePlayback() {
  queuePlayback('toggle');
}
function requestPlayerControl(command, position) {
  if (!state?.media || !activeSource || episodeBusy) return;
  if (['toggle', 'play', 'pause'].includes(command)) { queuePlayback(command); return; }
  if (!state.canControl) return;
  if (command === 'seek-start') {
    if (video.readyState < 1) return;
    clearTimeout(seekTimer); seekSequence += 1; seekDragging = true; locallySeeking = true;
    return;
  }
  if (command === 'seek-cancel') {
    if (seekDragging) { seekDragging = false; locallySeeking = false; synchronize(); }
    return;
  }
  if (command === 'seek') {
    if (!Number.isFinite(position) || video.readyState < 1) return;
    const generation = sourceGeneration; const sequence = ++seekSequence;
    const value = Math.max(0, Math.min(position, Number.isFinite(video.duration) ? video.duration : position));
    clearTimeout(seekTimer); seekDragging = false; locallySeeking = true;
    // Keep the released handle at the user's destination while the room confirms it.
    video.currentTime = value;
    const commit = () => {
      if (generation !== sourceGeneration || sequence !== seekSequence) return;
      if (controlBusy) { seekTimer = setTimeout(commit, 100); return; }
      attempt(async () => {
        let success = false;
        try { success = await action('seek', { position: value }); }
        finally {
          // An earlier response must never release a newer drag or seek.
          if (generation === sourceGeneration && sequence === seekSequence) {
            locallySeeking = false;
            // The local seek already started on release. Preserve its buffered frames on acknowledgement.
            if (success && state.position === value && Math.abs(video.currentTime - target()) <= 1.2) pendingSeek = false;
            synchronize();
          }
        }
      });
    };
    seekTimer = setTimeout(commit, 100);
    return;
  }
}
$('join').onclick = () => state?.canControl && state.paused ? togglePlayback() : unlock();
$('unmute').onclick = () => { video.muted = false; autoMuted = false; $('unmute').hidden = true; if (!state?.paused && video.paused) void unlock(); };
const volume = $('volume');
function updateVolume() {
  volume.value = String(video.muted ? 0 : video.volume);
  if (!video.muted) { autoMuted = false; $('unmute').hidden = true; }
}
video.addEventListener('volumechange', updateVolume);
volume.oninput = () => {
  video.volume = Number(volume.value);
  if (video.volume > 0) video.muted = false;
};
updateVolume();
$('toggle').onclick = togglePlayback;
if (!atomShell.active) video.addEventListener('click', togglePlayback);
function adjacentEpisode(direction) {
  const episodes = state?.media?.episodes || []; const index = state?.media?.episodeIndex || 0;
  const next = index + direction;
  return episodes[next] && episodes[next].group === episodes[index]?.group ? next : -1;
}
$('previous-episode').onclick = () => attempt(() => selectEpisode(adjacentEpisode(-1)));
$('next-episode').onclick = () => attempt(() => selectEpisode(adjacentEpisode(1)));
function showRoomPanel(panel) {
  $('cinema-layout').setAttribute('data-panel', panel);
  $('show-chat').setAttribute('aria-pressed', String(panel === 'chat'));
  $('show-episodes').setAttribute('aria-pressed', String(panel === 'episodes'));
}
$('show-chat').onclick = () => {
  showRoomPanel('chat');
  const list = $('messages');
  list.scrollTop = list.scrollHeight;
};
$('show-episodes').onclick = () => showRoomPanel('episodes');
function renderEpisodes() {
  const episodes = state?.media?.episodes || []; const index = state?.media?.episodeIndex || 0;
  $('episode-panel').hidden = $('room-panel-switch').hidden = !episodes.length;
  if (!episodes.length) showRoomPanel('chat');
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
async function selectMedia(media) {
  if (!state?.canControl || episodeBusy || controlBusy) return;
  episodeBusy = true; renderEpisodes();
  try {
    const result = await api('/api/media', { ...media, revision: state.revision });
    receive(await api('/api/state'));
    return result;
  } catch (error) {
    try { receive(await api('/api/state')); } catch { /* Report the selection error. */ }
    throw error;
  }
  finally { episodeBusy = false; renderEpisodes(); }
}
async function selectEpisode(index) {
  const episode = state?.media?.episodes?.[index];
  if (!episode || index === state.media.episodeIndex) return;
  const result = await selectMedia({ mode: 'online', url: episode.url });
  if (result?.warning) notice(result.warning, true);
}
$('seek').oninput = () => requestPlayerControl('seek-start');
$('seek').onchange = event => requestPlayerControl('seek', Number(event.target.value));
$('seek').onblur = () => requestPlayerControl('seek-cancel');
$('retry-player').onclick = () => { if (state?.media) { notice(''); loadMedia(fallbackUsed ? state.media.fallbackUrl : currentMedia, { preserve: true }); } };
video.addEventListener('loadedmetadata', synchronize); video.addEventListener('canplay', synchronize);
function renderTimeline() {
  const hasDuration = Number.isFinite(video.duration);
  $('time').textContent = `${time(video.currentTime)} / ${time(hasDuration ? video.duration : 0)}`;
  if (!hasDuration) return;
  const seek = $('seek');
  seek.max = String(video.duration);
  if (!locallySeeking && document.activeElement !== seek) seek.value = String(video.currentTime);
}
video.addEventListener('loadedmetadata', renderTimeline);
video.addEventListener('timeupdate', renderTimeline);
for (const event of ['loadeddata', 'canplay', 'playing']) video.addEventListener(event, () => {
  if (video.readyState >= 2 && (event === 'playing' || state?.paused)) { clearTimeout(startupTimer); armStartup = undefined; }
  updateJoin();
});
video.addEventListener('ended', () => {
  if (!video.ended || !state?.canControl || state.paused || replayPending()) return;
  // Capture both versions now; a delayed ending must never pause a newer replay.
  const extra = { position: video.duration, revision: state.revision, mediaVersion };
  attempt(() => action('ended', extra));
});
const decodeText = value => String(value || '').replace(/&(?:lt|gt|amp|quot|#39);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" })[entity]);
function renderMessages(messages) {
  const signature = JSON.stringify(messages); if (signature === lastMessages && !scrollAfterSend) return;
  const list = $('messages'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
  const oldScroll = list.scrollTop; lastMessages = signature; list.replaceChildren();
  if (!messages.length) { const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = '暂无聊天消息'; list.append(empty); }
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
setInterval(synchronize, 1000);
setInterval(refreshChat, 2000);
attempt(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1)); const ticket = fragment.get('ticket');
  let inviteSource;
  if (ticket) {
    history.replaceState(null, '', '/'); const result = await api('/api/session', { ticket }); room = result.room;
    inviteSource = fragment.get('source');
    history.replaceState(null, '', `/room/${room}`);
  }
  if (!room) { $('chat-status').textContent = '未登录'; return; }
  $('home').href = `/room/${room}`;
  $('manage').href = `/room/${room}/manage`;
  const discoveryPanel = $('online-panel');
  discoveryPanel.open = matchMedia('(width > 760px)').matches;
  $('choose-source').onclick = () => { discoveryPanel.open = true; };
  discovery.setSource(inviteSource || sessionStorage.getItem(`watch-source:${room}`) || '');
  receive(await api('/api/state')); void refreshChat();
  discoveryPanel.hidden = false;
  if (!atomShell.active) notice('已使用基础播放器，刷新可重试。', true);
  events = new EventSource(`/api/events?room=${encodeURIComponent(room)}`);
  let disconnectTimer;
  events.onopen = () => { $('connection').textContent = '正在同步'; };
  events.onmessage = event => {
    const next = JSON.parse(event.data);
    clearTimeout(disconnectTimer); disconnectTimer = undefined;
    enabled = !autoplayBlocked; receive(next);
  };
  events.onerror = () => {
    $('connection').textContent = '重新连接中';
    const pauseDisconnected = () => { video.pause(); enabled = false; $('join').hidden = !state?.media; };
    if (events.readyState === EventSource.CLOSED) { clearTimeout(disconnectTimer); pauseDisconnected(); }
    else if (disconnectTimer === undefined) disconnectTimer = setTimeout(pauseDisconnected, 15000);
  };
  if (inviteSource && state.canControl) {
    try {
      notice('正在读取邀请片源…');
      await discovery.openInvite(inviteSource);
      notice('');
      sessionStorage.removeItem(`watch-source:${room}`);
    } catch (error) {
      discoveryPanel.open = true;
      throw error;
    }
  }
});
