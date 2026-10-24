const STORAGE_KEY = 'watch:danmaku';
const MAX_SEEN = 4096;
const MAX_QUEUE = 12;
const MAX_WAIT = 8000;
const decode = value => String(value || '').replace(/&(?:lt|gt|amp|quot|#39);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" })[entity]);
const short = (value, limit) => { const characters = Array.from(decode(value).replace(/\s+/g, ' ').trim()); return characters.slice(0, limit).join('') + (characters.length > limit ? '…' : ''); };

/** Feed successful /api/chat snapshots, including deleted messages. clear() clears
 * the screen only; retaining seen IDs prevents history replay after a source swap.
 */
export function createDanmaku({ container, button, video }) {
  const doc = container.ownerDocument; const view = doc.defaultView;
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const seen = new Set(); const active = new Map();
  let queue = []; let seeded = false; let baselinePending = false; let destroyed = false; let explicitPreference = false;
  let enabled = !reduced?.matches;
  try {
    const saved = view.localStorage.getItem(STORAGE_KEY);
    if (saved === '1' || saved === '0') { enabled = saved === '1'; explicitPreference = true; }
  } catch { /* Storage may be blocked in private browsing. */ }
  Object.assign(container.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '1' });
  container.setAttribute('aria-hidden', 'true');

  function renderButton() {
    button.type = 'button'; button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? '弹幕开' : '弹幕关';
    button.title = enabled ? '关闭聊天弹幕（仅本机）' : '显示聊天弹幕（仅本机）';
  }
  function playable() {
    return !destroyed && enabled && !doc.hidden && !video.paused && !video.ended && !video.seeking && !video.error && Boolean(video.currentSrc || video.getAttribute('src'));
  }
  function remove(id) {
    const entry = active.get(id); if (!entry) return;
    active.delete(id); entry.animation?.cancel(); view.clearTimeout(entry.timer); entry.node.remove();
  }
  function clear() { queue = []; for (const id of active.keys()) remove(id); }
  // Polling can be suspended in a background tab. Seed the next live snapshot so
  // messages from that gap cannot replay when watching resumes.
  function inactive() { baselinePending = true; clear(); }
  function remember(id) {
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  }
  function drain() {
    if (!playable()) { clear(); return; }
    const width = container.clientWidth; const height = container.clientHeight;
    if (!width || !height) { clear(); return; }
    const fontSize = Math.max(13, Math.min(20, Math.round(height / 22)));
    const rowHeight = Math.ceil(fontSize * 1.5 + 8);
    const lanes = Math.max(1, Math.min(6, Math.floor(height * 0.58 / rowHeight)));
    queue = queue.filter(message => Date.now() - message.receivedAt <= MAX_WAIT);
    for (let lane = 0; lane < lanes && queue.length; lane++) {
      // Keep a whole lane exclusive until its previous message has left the screen.
      if ([...active.values()].some(entry => entry.lane === lane)) continue;
      const message = queue.shift(); const node = doc.createElement('span');
      node.textContent = message.text;
      Object.assign(node.style, { position: 'absolute', top: `${12 + lane * rowHeight}px`, left: '0', whiteSpace: 'nowrap',
        font: `600 ${fontSize}px/1.5 system-ui,sans-serif`, color: message.self ? '#82dfd3' : '#fff',
        textShadow: '0 1px 3px #000, 1px 0 2px #000, -1px 0 2px #000', padding: '1px 6px',
        borderRadius: '6px', background: message.self ? 'rgba(14, 21, 20, 0.42)' : 'transparent', border: message.self ? '1px solid #82dfd388' : '1px solid transparent', willChange: 'transform' });
      container.append(node);
      const entry = { node, lane }; active.set(message.id, entry);
      const finished = () => { remove(message.id); drain(); };
      if (reduced?.matches || typeof node.animate !== 'function') {
        Object.assign(node.style, { left: '12px', maxWidth: `${Math.max(0, width - 24)}px`, overflow: 'hidden', textOverflow: 'ellipsis', background: '#0006' });
        entry.timer = view.setTimeout(finished, 3000);
      } else {
        const textWidth = node.getBoundingClientRect().width;
        entry.animation = node.animate([{ transform: `translateX(${width}px)` }, { transform: `translateX(${-textWidth}px)` }], {
          duration: Math.max(6000, Math.min(16000, (width + textWidth) / 120 * 1000)), easing: 'linear', fill: 'forwards',
        });
        entry.animation.onfinish = finished;
      }
    }
  }
  function ingest(messages, currentUserId) {
    if (destroyed || !Array.isArray(messages)) return;
    const fresh = []; const initial = !seeded || baselinePending; seeded = true;
    if (playable()) baselinePending = false;
    // The bridge returns its newest 50 messages in chronological order.
    for (const message of messages.slice(-50)) {
      if (typeof message?.id !== 'string' || !message.id || message.id.length > 128) continue;
      if (message.deleted) {
        remember(message.id); remove(message.id); queue = queue.filter(item => item.id !== message.id); continue;
      }
      if (seen.has(message.id)) continue;
      remember(message.id);
      if (initial || !playable()) continue;
      const content = short(message.content, 120); if (!content) continue;
      fresh.push({ id: message.id, text: `${short(message.user?.name || '已注销用户', 24)}：${content}`,
        self: message.user?.id === currentUserId, receivedAt: Date.now() });
    }
    if (!playable()) { clear(); return; }
    queue = [...queue, ...fresh].slice(-MAX_QUEUE); drain();
  }
  const toggle = () => {
    enabled = !enabled; explicitPreference = true;
    try { view.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch { /* Keep the current page usable. */ }
    inactive(); renderButton();
  };
  const motionChanged = () => { inactive(); if (!explicitPreference) { enabled = !reduced.matches; renderButton(); } };
  const videoEvents = ['pause', 'ended', 'emptied', 'loadstart', 'seeking', 'error'];
  button.addEventListener('click', toggle);
  for (const name of videoEvents) video.addEventListener(name, inactive);
  doc.addEventListener('visibilitychange', inactive);
  doc.addEventListener('fullscreenchange', clear); doc.addEventListener('webkitfullscreenchange', clear);
  view.addEventListener('resize', clear); view.addEventListener('pagehide', inactive);
  reduced?.addEventListener?.('change', motionChanged);
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(clear) : null;
  observer?.observe(container); renderButton();
  return { ingest, clear, destroy() {
    if (destroyed) return; destroyed = true; clear(); seen.clear(); observer?.disconnect();
    button.removeEventListener('click', toggle);
    for (const name of videoEvents) video.removeEventListener(name, inactive);
    doc.removeEventListener('visibilitychange', inactive);
    doc.removeEventListener('fullscreenchange', clear); doc.removeEventListener('webkitfullscreenchange', clear);
    view.removeEventListener('resize', clear); view.removeEventListener('pagehide', inactive);
    reduced?.removeEventListener?.('change', motionChanged);
  } };
}
