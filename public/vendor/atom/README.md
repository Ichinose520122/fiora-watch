# Atom compatibility snapshot

Runtime: Atom-Player v1.5.0 by Astrov0, https://player.atomu.cc.
Retrieved from the public scripts loaded by girigiri on 2026-10-17/18:

- https://pl.girigirilove.com/addons/aplyer/js/atom/APlayer.min.js
- https://pl.girigirilove.com/addons/aplyer/js/lottie_svg.min.js

Original Atom SHA-256: `d49af3cf4aac25a4b1c5e8367b0f678c064749dc20307ad189d8a97ca8201774`.
Lottie SVG SHA-256: `c9cf6870d0cc66451d2d653063ddbf6f16b3f579425d7b6122c48987211385ed`.
The original author header is retained. A complete source distribution and Atom
redistribution license have not been located; this local compatibility snapshot
does not assert an open-source license. Review that status before redistribution.

`APlayer.watch.js` adds narrow Watch integration hooks to the original bundle:

- `watchControl(action, position)` routes play, pause and desktop/mobile seeking
  through the room API. Seeking does not automatically start a paused room.
- Internal load/error/end/destroy pauses use the native video without generating
  room commands. Watch owns HLS/DASH loading, quality and external subtitle menus.
- `watchFullscreen` / `watchIsFullscreen` keep the whole Watch shell (including
  subtitle menus, chat danmaku and join/error overlays) in fullscreen.
- Watch owns the control-hide timer so a focused menu stays operable while the
  entire progress bar disappears when fullscreen playback is idle.
- Local playback history is disabled when Watch controls are present; room state
  is the sole playback position. Atom's standalone danmaku plugin and its mobile
  settings initialization are skipped, so no unused remote workers are loaded.

No girigiri initialization/analytics script is executed. Local `atom-adapter.js`
creates the player, and `danmaku.js` displays escaped live chat messages. The
adapter locks local playback rate at 1 to maintain the shared room clock.
The unused Web Audio enhancement plugin is skipped too, avoiding silent audio
when an external progressive MP4 cannot be used as a CORS-enabled audio source.
