// Local player preferences never send room playback commands.
export function qualityLabel(item, labels = []) {
  const supplied = labels.find(label => String(label.representationId ?? label.id) === String(item.id));
  if (supplied?.label) return supplied.label;
  const height = Number(item.height); const parts = String(item.frameRate ?? item.framerate ?? '').split('/'); const rate = Number(parts[0]) / (Number(parts[1]) || 1);
  if (height > 0) return `${height}P${rate >= 50 ? ` ${Math.round(rate)}帧` : ''}`;
  const bandwidth = Number(item.bandwidth ?? item.bitrate);
  return bandwidth > 0 ? `${(bandwidth / 1000000).toFixed(1)} Mbps` : '原画';
}

export function sameOriginTrack(value, origin) {
  try { const url = new URL(value, origin); return url.origin === origin && /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function createPlayer({ video, document: doc = document, subtitles, notify }) {
  const element = id => doc.getElementById(id);
  const shell = element('player-shell');
  const menuSignatures = new Map();
  let generation = 0; let media; let hls; let dash; let externalTrack; let subtitleRequest;
  let quality = 'auto'; let subtitle = 'off'; let backendSubtitles = []; let subtitleState = ''; let ready = false; let error = false; let hideTimer;
  let qualityItems = []; let subtitleItems = []; let changingSubtitle = false; let pendingSubtitle = 'off';

  function loading(text = '') {
    element('player-loading').hidden = !text; element('loading-text').textContent = text;
    shell.setAttribute('aria-busy', String(Boolean(text)));
  }
  function reveal() {
    shell.classList.remove('controls-idle'); clearTimeout(hideTimer);
    if (!video.paused && !video.ended && !doc.activeElement?.closest('.player-controls') && !shell.querySelector('.player-menu:not([hidden])')) hideTimer = setTimeout(() => shell.classList.add('controls-idle'), 2800);
  }
  function closeMenus() {
    for (const name of ['quality', 'subtitle']) { element(`${name}-menu`).hidden = true; element(`${name}-button`).setAttribute('aria-expanded', 'false'); }
    reveal();
  }
  function menu(name, choices, selected, choose, message = '') {
    const signature = JSON.stringify([choices.map(({ id, label }) => [id, label]), selected, message]);
    if (menuSignatures.get(name) === signature) return; menuSignatures.set(name, signature);
    const box = element(`${name}-options`); box.replaceChildren();
    choices.forEach(item => {
      const button = doc.createElement('button'); button.type = 'button'; button.role = 'menuitemradio'; button.textContent = item.label;
      button.setAttribute('aria-checked', String(item.id === selected));
      button.onclick = () => { choose(item.id); closeMenus(); element(`${name}-button`).focus(); };
      box.append(button);
    });
    element(`${name}-message`).textContent = message; element(`${name}-message`).hidden = !message;
  }
  function renderQuality() {
    let current = ''; qualityItems = [];
    try {
      if (dash) {
        qualityItems = dash.getRepresentationsByType('video').map(item => ({ id: String(item.id), label: qualityLabel(item, media?.qualities), height: item.height, bandwidth: item.bandwidth }));
        const item = dash.getCurrentRepresentationForType('video'); if (item) current = qualityLabel(item, media?.qualities);
      } else if (hls) {
        qualityItems = hls.levels.map((item, index) => ({ id: String(index), label: qualityLabel(item), height: item.height, bandwidth: item.bitrate }));
        if (hls.levels[hls.currentLevel]) current = qualityLabel(hls.levels[hls.currentLevel]);
      }
    } catch { /* Metadata is not available until the manifest has initialized. */ }
    qualityItems.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    const duplicateLabels = new Map(); qualityItems.forEach(item => duplicateLabels.set(item.label, (duplicateLabels.get(item.label) || 0) + 1));
    qualityItems = qualityItems.map(item => ({ ...item, label: duplicateLabels.get(item.label) > 1 && item.bandwidth ? `${item.label} · ${(item.bandwidth / 1000000).toFixed(1)} Mbps` : item.label }));
    if (quality !== 'auto' && qualityItems.length && !qualityItems.some(item => item.id === quality)) quality = 'auto';
    const selected = qualityItems.find(item => item.id === quality);
    element('quality-button').textContent = selected?.label || (qualityItems.length ? `自动${current ? ` · ${current}` : ''}` : video.videoHeight ? `${video.videoHeight}P` : '清晰度');
    menu('quality', qualityItems.length ? [{ id: 'auto', label: '自动 · 随网络调整' }, ...qualityItems] : [], quality, chooseQuality,
      !media ? '选择影片后可设置' : !qualityItems.length ? ready ? '当前片源仅提供原画' : '正在读取片源清晰度…' : qualityItems.length === 1 ? '当前片源仅提供以上清晰度' : '仅影响你的画面');
  }
  function chooseQuality(id) {
    if (id !== 'auto' && !qualityItems.some(item => item.id === id)) return;
    try {
      if (dash) { dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: id === 'auto' } } } }); if (id !== 'auto') dash.setRepresentationForTypeById('video', id); }
      if (hls) hls.nextLevel = id === 'auto' ? -1 : Number(id);
      quality = id; renderQuality();
    } catch { notify('暂时无法切换清晰度，请稍后重试。'); }
  }
  function renderSubtitles() {
    subtitleItems = [];
    if (hls) subtitleItems.push(...hls.subtitleTracks.map((item, index) => ({ id: `hls:${index}`, label: item.name || item.lang || `字幕 ${index + 1}`, index, kind: 'hls' })));
    if (dash) {
      try { subtitleItems.push(...dash.getTracksFor('text').map((item, index) => ({ id: `dash:${index}`, label: item.labels?.[0]?.text || item.lang || `字幕 ${index + 1}`, index, kind: 'dash' }))); } catch { /* Manifest loading. */ }
    }
    if (!hls && !dash) Array.from(video.textTracks).forEach((track, index) => {
      if (track !== externalTrack?.track && ['subtitles', 'captions'].includes(track.kind)) subtitleItems.push({ id: `native:${index}`, label: track.label || track.language || `字幕 ${index + 1}`, track, kind: 'native' });
    });
    subtitleItems.push(...backendSubtitles.map(item => ({ ...item, id: `external:${item.id}`, kind: 'external' })));
    const selected = subtitleItems.find(item => item.id === subtitle);
    element('subtitle-button').textContent = selected ? selected.label : '字幕';
    element('subtitle-button').classList.toggle('selected', Boolean(selected));
    menu('subtitle', [{ id: 'off', label: '关闭字幕' }, ...subtitleItems], selected ? subtitle : 'off', chooseSubtitle,
      subtitleState || (!media ? '选择影片后可设置' : !subtitleItems.length && ready ? '片源未提供可选字幕；画面内字幕无法关闭' : !subtitleItems.length ? '正在读取字幕…' : '仅影响你的字幕'));
  }
  function disableSubtitles() {
    if (hls) { hls.subtitleTrack = -1; hls.subtitleDisplay = false; }
    if (dash) { try { dash.enableText(false); } catch { /* Player not ready. */ } }
    for (const track of Array.from(video.textTracks)) track.mode = 'disabled';
  }
  function chooseSubtitle(id) {
    const item = subtitleItems.find(candidate => candidate.id === id);
    if (id !== 'off' && !item) return;
    changingSubtitle = true; subtitle = id; pendingSubtitle = 'off'; disableSubtitles(); externalTrack?.remove(); externalTrack = null;
    if (item?.kind === 'hls') { hls.subtitleDisplay = true; hls.subtitleTrack = item.index; }
    if (item?.kind === 'dash') { dash.enableText(true); dash.setTextTrack(item.index); }
    if (item?.kind === 'native') item.track.mode = 'showing';
    if (item?.kind === 'external') {
      const track = doc.createElement('track'); const token = generation;
      track.kind = 'subtitles'; track.label = item.label; track.srclang = item.language || 'und'; track.src = item.url;
      track.onload = () => { if (token === generation && externalTrack === track) { track.track.mode = 'showing'; subtitleState = ''; renderSubtitles(); } };
      track.onerror = () => { if (token === generation && externalTrack === track) { subtitleState = '字幕暂时无法加载，可选择其他字幕'; subtitle = 'off'; track.remove(); externalTrack = null; renderSubtitles(); } };
      externalTrack = track; video.append(track); track.track.mode = 'showing'; subtitleState = '正在加载字幕…';
    } else subtitleState = '';
    changingSubtitle = false; renderSubtitles();
  }
  async function loadSubtitles(token, version) {
    if (!(media?.provider === 'bilibili' || /^\/api\/bilibili\/(manifest|track)\?/.test(media?.url || ''))) return;
    const controller = new AbortController(); subtitleRequest = controller; subtitleState = '正在查找字幕…'; renderSubtitles();
    try {
      const result = await subtitles(version, controller.signal);
      if (token !== generation) return;
      backendSubtitles = (result.subtitles || []).map(item => ({ ...item, label: item.label || item.language || '字幕', url: sameOriginTrack(item.url, location.origin) })).filter(item => item.url);
      subtitleState = result.message || ''; renderSubtitles(); restoreSubtitle();
    } catch (failure) {
      if (token !== generation || controller.signal.aborted) return;
      subtitleState = '字幕暂时不可用，视频可继续播放'; renderSubtitles();
    }
  }
  function begin(next, version, { preserve = false } = {}) {
    generation += 1; subtitleRequest?.abort(); hls = null; dash = null; ready = false; error = false;
    media = next; qualityItems = []; backendSubtitles = []; subtitleState = ''; subtitleItems = [];
    pendingSubtitle = preserve ? subtitle : 'off';
    if (!preserve) { quality = 'auto'; subtitle = 'off'; }
    externalTrack?.remove(); externalTrack = null; closeMenus(); loading(next ? '正在加载影片…' : '');
    renderQuality(); renderSubtitles(); void loadSubtitles(generation, version);
    return generation;
  }
  function restoreSubtitle() {
    if (pendingSubtitle !== 'off' && subtitleItems.some(item => item.id === pendingSubtitle)) chooseSubtitle(pendingSubtitle);
    else if (subtitle === 'off') disableSubtitles();
  }
  function attachDash(player, names) {
    dash = player; const token = generation;
    for (const name of [names.STREAM_INITIALIZED, names.REPRESENTATION_SWITCH, names.QUALITY_CHANGE_RENDERED, names.TEXT_TRACKS_ADDED].filter(Boolean)) player.on(name, () => {
      if (token !== generation || dash !== player) return;
      renderQuality(); renderSubtitles();
    });
    player.on(names.STREAM_INITIALIZED, () => { if (token === generation && dash === player) { if (quality !== 'auto') chooseQuality(quality); restoreSubtitle(); } });
    if (names.TEXT_TRACKS_ADDED) player.on(names.TEXT_TRACKS_ADDED, () => { if (token === generation && dash === player) restoreSubtitle(); });
  }
  function attachHls(player, names) {
    hls = player; const token = generation;
    for (const name of [names.MANIFEST_PARSED, names.LEVEL_SWITCHED, names.SUBTITLE_TRACKS_UPDATED].filter(Boolean)) player.on(name, () => {
      if (token !== generation || hls !== player) return;
      renderQuality(); renderSubtitles();
    });
    player.on(names.MANIFEST_PARSED, () => { if (token === generation && hls === player) { if (quality !== 'auto') chooseQuality(quality); restoreSubtitle(); } });
  }
  function fail(text = '影片加载失败') { error = true; loading(''); element('player-error').hidden = false; element('player-error-text').textContent = text; reveal(); }
  for (const name of ['quality', 'subtitle']) {
    element(`${name}-button`).onclick = () => { const open = element(`${name}-menu`).hidden; closeMenus(); element(`${name}-menu`).hidden = !open; element(`${name}-button`).setAttribute('aria-expanded', String(open)); if (open) element(`${name}-options`).querySelector('button')?.focus(); reveal(); };
    element(`${name}-menu`).onkeydown = event => {
      const buttons = Array.from(element(`${name}-options`).querySelectorAll('button')); const index = buttons.indexOf(doc.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); closeMenus(); element(`${name}-button`).focus(); }
    };
  }
  doc.addEventListener('click', event => { if (!event.target.closest('.player-setting')) closeMenus(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenus(); if (shell.classList.contains('web-fullscreen')) toggleFullscreen(); } });
  function updateFullscreen() {
    const full = doc.fullscreenElement === shell || doc.webkitFullscreenElement === shell || shell.classList.contains('web-fullscreen');
    element('fullscreen').setAttribute('aria-label', full ? '退出全屏' : '全屏'); element('fullscreen').setAttribute('aria-pressed', String(full)); reveal();
  }
  async function toggleFullscreen() {
    try {
      if (doc.fullscreenElement) await doc.exitFullscreen();
      else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen();
      else if (shell.classList.contains('web-fullscreen')) { shell.classList.remove('web-fullscreen'); doc.body.classList.remove('player-fullscreen'); }
      else if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (shell.webkitRequestFullscreen) shell.webkitRequestFullscreen();
      else { shell.classList.add('web-fullscreen'); doc.body.classList.add('player-fullscreen'); }
    } catch { shell.classList.toggle('web-fullscreen'); doc.body.classList.toggle('player-fullscreen', shell.classList.contains('web-fullscreen')); }
    updateFullscreen();
  }
  element('fullscreen').onclick = toggleFullscreen;
  doc.addEventListener('fullscreenchange', updateFullscreen); doc.addEventListener('webkitfullscreenchange', updateFullscreen);
  for (const name of ['pointermove', 'pointerdown', 'focusin']) shell.addEventListener(name, reveal);
  for (const name of ['loadstart', 'waiting', 'seeking']) video.addEventListener(name, () => { if (media && !error) loading(ready ? '正在缓冲…' : '正在加载影片…'); reveal(); });
  for (const name of ['loadeddata', 'canplay', 'playing', 'seeked']) video.addEventListener(name, () => { ready = true; loading(''); renderQuality(); renderSubtitles(); reveal(); });
  for (const name of ['pause', 'ended']) video.addEventListener(name, () => { loading(''); reveal(); });
  video.addEventListener('loadedmetadata', () => { renderQuality(); renderSubtitles(); });
  video.textTracks.addEventListener('addtrack', event => { if (!changingSubtitle) { if (subtitle === 'off') event.track.mode = 'disabled'; renderSubtitles(); } });
  return { begin(next, version, options) { element('player-error').hidden = true; return begin(next, version, options); }, attachDash, attachHls, fail, loading, reveal };
}
