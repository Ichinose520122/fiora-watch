// Download only the engine required by the selected source, once per page.
const pending = new Map();
export function loadMediaEngine(kind, video) {
  // Preserve HLS quality selection where MediaSource is available.
  if (kind === 'hls' && !window.MediaSource && !window.ManagedMediaSource && video.canPlayType('application/vnd.apple.mpegurl')) return Promise.resolve();
  const item = { dash: ['dashjs', './vendor/dash.all.min.js'], hls: ['Hls', './vendor/hls.min.js'] }[kind];
  if (!item || window[item[0]]) return Promise.resolve();
  if (!pending.has(kind)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = new URL(item[1], import.meta.url).href;
      const timer = setTimeout(() => finish(new Error('播放组件加载超时，请重试')), 15000);
      function finish(error) {
        clearTimeout(timer); script.onload = null; script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve();
      }
      script.onload = () => finish(window[item[0]] ? null : new Error('播放组件未就绪，请重试'));
      script.onerror = () => finish(new Error('播放组件加载失败，请重试'));
      document.head.append(script);
    });
    pending.set(kind, promise);
    promise.catch(() => { if (pending.get(kind) === promise) pending.delete(kind); });
  }
  return pending.get(kind);
}
