// Atom supplies the controls; Watch retains ownership of media engines and room state.
export function mountAtomPlayer({ requestControl, document: doc = document }) {
  const shell = doc.getElementById('player-shell');
  const original = doc.getElementById('video');
  const mount = doc.createElement('div'); mount.id = 'atom-mount';
  const screen = original.parentElement;
  const theater = doc.getElementById('theater');
  const movable = ['quality-button', 'subtitle-button'].map(id => doc.getElementById(id).parentElement);
  movable.push(doc.getElementById('danmaku-toggle'));
  if (theater) movable.push(theater);
  const previousParents = movable.map(node => [node, node.parentElement, node.nextSibling]);
  let atom; let fullscreenRequest;
  const isFullscreen = () => doc.fullscreenElement === shell || doc.webkitFullscreenElement === shell || shell.classList.contains('web-fullscreen');
  try {
    if (!window.aplayer || !window.lottie) throw new Error('Atom runtime unavailable');
    screen.prepend(mount);
    atom = new window.aplayer({
      id: 'FioraWatch', container: '#atom-mount', lang: 'zh-CN', dark: true,
      color: '#5bb3a7', video: { url: '', type: 'watch', key: '', volume: 1, moreAttr: { playsinline: '', preload: 'auto' } },
      control: { button: { volume: true, fullScreen: true, back: false } },
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
    const updateMuted = () => atom.emit('muted', video.muted);
    video.addEventListener('timeupdate', updateTimeline);
    video.addEventListener('seeked', updateTimeline);
    video.addEventListener('volumechange', updateMuted);
    atom.on('destroy', () => {
      video.removeEventListener('timeupdate', updateTimeline);
      video.removeEventListener('seeked', updateTimeline);
      video.removeEventListener('volumechange', updateMuted);
    });
    const controls = atom.player.template.$right;
    if (theater) controls.insertBefore(theater, controls.lastElementChild);
    for (const id of ['quality-button', 'subtitle-button']) controls.prepend(doc.getElementById(id).parentElement);
    controls.prepend(doc.getElementById('danmaku-toggle'));
    shell.classList.add('uses-atom');
    const updateFullscreen = () => atom.emit('fullScreen', Boolean(isFullscreen()));
    doc.addEventListener('fullscreenchange', updateFullscreen);
    doc.addEventListener('webkitfullscreenchange', updateFullscreen);
    // Touch gestures and desktop controls are both routed through watchControl.
    // Programmatic DASH/HLS actions use the native video and never issue room commands.
    return {
      atom, video, active: true,
      setFullscreen(handler) { fullscreenRequest = async () => { await handler(); updateFullscreen(); }; },
      reset() { atom.player.error = false; atom.loading = false; atom.player.hover = true; },
      update(state) {
        shell.classList.toggle('room-readonly', !state?.canControl);
        shell.classList.toggle('room-empty', !state?.media);
      },
    };
  } catch (error) {
    try { atom?.destroy(); } catch { /* Keep native fallback usable after partial initialization. */ }
    for (const [node, parent, next] of previousParents.reverse()) parent.insertBefore(node, next?.parentElement === parent ? next : null);
    mount.remove(); shell.classList.remove('uses-atom');
    if (!original.isConnected) screen.prepend(original);
    console.warn('Atom initialization failed; using Watch controls.', error);
    return { video: original, active: false, setFullscreen() {}, reset() {}, update() {} };
  }
}
