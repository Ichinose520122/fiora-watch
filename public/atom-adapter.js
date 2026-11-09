// Atom supplies video gestures and seeking. Watch owns the shared toolbar and room state.
export function mountAtomPlayer({ requestControl, document: doc = document }) {
  const shell = doc.getElementById('player-shell');
  const original = doc.getElementById('video');
  const mount = doc.createElement('div'); mount.id = 'atom-mount';
  const screen = original.parentElement;
  let atom; let fullscreenRequest;
  const isFullscreen = () => doc.fullscreenElement === shell || doc.webkitFullscreenElement === shell || shell.classList.contains('web-fullscreen');
  try {
    if (!window.aplayer || !window.lottie) throw new Error('Atom runtime unavailable');
    screen.prepend(mount);
    atom = new window.aplayer({
      id: 'FioraWatch', container: '#atom-mount', lang: 'zh-CN', dark: true,
      color: '#5bb3a7', video: { url: '', type: 'watch', key: '', volume: 1, moreAttr: { playsinline: '', preload: 'auto' } },
      control: { button: { volume: false, fullScreen: false, back: false } },
      watchControl: requestControl,
      watchFullscreen: () => fullscreenRequest?.(), watchIsFullscreen: isFullscreen,
    });
    const video = atom.player.template.$video;
    original.remove(); video.id = 'video';
    // Individual speed changes break a shared room's clock (including mobile long press).
    const rate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    Object.defineProperty(video, 'playbackRate', { configurable: true, get() { return rate.get.call(this); }, set() { rate.set.call(this, 1); } });
    // Room synchronization seeks the native video even while playback is paused.
    // Atom's animation loop only updates its timeline while playing.
    const updateTimeline = () => atom.emit('timeUpdate', video.currentTime, video.duration);
    video.addEventListener('timeupdate', updateTimeline);
    video.addEventListener('seeked', updateTimeline);
    atom.on('destroy', () => {
      video.removeEventListener('timeupdate', updateTimeline);
      video.removeEventListener('seeked', updateTimeline);
    });
    shell.classList.add('uses-atom');
    const updateFullscreen = () => atom.emit('fullScreen', Boolean(isFullscreen()));
    doc.addEventListener('fullscreenchange', updateFullscreen);
    doc.addEventListener('webkitfullscreenchange', updateFullscreen);
    // Touch gestures and desktop controls are both routed through watchControl.
    // Programmatic DASH/HLS actions use the native video and never issue room commands.
    return {
      video, active: true,
      setFullscreen(handler) { fullscreenRequest = async () => { await handler(); updateFullscreen(); }; },
      reset() { atom.player.error = false; atom.loading = false; atom.player.hover = true; },
      update(state) {
        shell.classList.toggle('room-readonly', !state?.canControl);
      },
    };
  } catch (error) {
    try { atom?.destroy(); } catch { /* Keep native fallback usable after partial initialization. */ }
    mount.remove(); shell.classList.remove('uses-atom');
    if (!original.isConnected) screen.prepend(original);
    console.warn('Atom initialization failed; using Watch controls.', error);
    return { video: original, active: false, setFullscreen() {}, reset() {}, update() {} };
  }
}
