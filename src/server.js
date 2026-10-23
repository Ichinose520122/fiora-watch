import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTicket, randomId } from './auth.js';
import { Store, control } from './store.js';
import { MediaLibrary, safeFile } from './media.js';
import { resolveMedia } from './resolver.js';
import { loadConfig } from './config.js';
import { createChatBridge } from './chat.js';
import { createCatalog } from './catalog.js';
import { isBilibiliUrl, listBilibiliEpisodes, resolveBilibili, buildBilibiliManifest, requestBilibiliTrack, authenticatedBilibiliReader, mediaUrl } from './bilibili.js';
import { listBilibiliSubtitles, fetchBilibiliSubtitle } from './bilibili-subtitles.js';
import { BilibiliAccount } from './bilibili-account.js';
import QRCode from 'qrcode';
import { pipeline } from 'node:stream/promises';
import { publicAssets } from './assets.js';
import { MediaRelay } from './relay.js';
import { registerLibraryRoutes } from './library-api.js';

export const SESSION_MS = 180 * 60000;

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config, dependencies = {}) {
  const app = express();
  const store = dependencies.store || new Store(config.dataDir);
  const sessions = new Map(); const streams = new Set(); const limits = new Map();
  const library = dependencies.library || new MediaLibrary(config, store);
  const account = dependencies.account || new BilibiliAccount(config);
  const readBilibili = authenticatedBilibiliReader(account);
  const resolveBili = input => resolveBilibili(input, config.hosts, readBilibili);
  const resolve = dependencies.resolve || ((input, hosts) => isBilibiliUrl(input) ? resolveBili(input) : resolveMedia(input, hosts));
  const chat = dependencies.chat || createChatBridge(config);
  const catalog = dependencies.catalog || createCatalog(config.hosts);
  const requestTrack = dependencies.requestTrack || requestBilibiliTrack;
  const listSubtitles = dependencies.listSubtitles || (media => listBilibiliSubtitles({ ...media.bilibili, source: media.source }, readBilibili));
  const fetchSubtitle = dependencies.fetchSubtitle || fetchBilibiliSubtitle;
  let subtitleCache = new WeakMap();
  const relay = new MediaRelay(config.hosts, dependencies.requestMedia);
  const relayStreams = new Set();
  const playbackSettings = () => {
    const delivery = (store.data.settings?.delivery ?? store.data.settings?.bilibiliDelivery) === 'proxy' ? 'proxy' : 'direct';
    return { delivery, bilibiliDelivery: delivery };
  };
  const refreshing = new Map();
  const invitationUpdates = new Map();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https: blob:; connect-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: '128kb' }));
  const cookieId = req => /(?:^|;\s*)watch_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const sameOrigin = (req, res, next) => {
    if (req.headers.origin !== config.audience || req.headers['x-watch-request'] !== '1') return res.status(403).json({ error: '请求来源无效' });
    next();
  };
  const throttle = (key, maximum) => {
    const now = Date.now(); let item = limits.get(key);
    if (!item || item.since < now - 60000) { item = { since: now, count: 0 }; limits.set(key, item); }
    if (++item.count > maximum) throw new Error('操作过于频繁，请稍后重试');
  };
  app.post('/api/session', sameOrigin, (req, res) => {
    throttle(`login:${req.socket.remoteAddress}`, 60);
    const payload = verifyTicket(req.body?.ticket, config);
    store.consumeTicket(payload);
    let id = cookieId(req); let session = sessions.get(id);
    if (!session || session.user.id !== payload.sub) {
      if (sessions.size >= 2000) throw new Error('影院会话数量已达上限');
      id = randomId(); session = { user: {}, grants: {} }; sessions.set(id, session);
    }
    session.user = { id: payload.sub, name: payload.name, avatar: typeof payload.avatar === 'string' ? payload.avatar : '', admin: payload.admin };
    session.grants[payload.room] = { canControl: payload.canControl, expires: Date.now() + SESSION_MS,
      chatGrant: typeof payload.chatGrant === 'string' && payload.chatGrant.length <= 4096 ? payload.chatGrant : '' };
    store.room(payload.room);
    res.cookie('watch_session', id, { httpOnly: true, sameSite: 'strict', secure: config.audience.startsWith('https:'), maxAge: SESSION_MS, path: '/' });
    res.json({ room: payload.room });
  });
  const authenticate = (req, res, next) => {
    const session = sessions.get(cookieId(req));
    if (!session || !Object.values(session.grants).some(grant => grant.expires > Date.now())) return res.status(401).json({ error: '影院登录已过期，请从 Fiora 重新进入' });
    req.session = session; next();
  };
  app.use('/api', authenticate);
  app.use('/api', (req, res, next) => req.method === 'POST' ? sameOrigin(req, res, next) : next());
  const admin = (req, res, next) => req.session.user.admin ? next() : res.status(403).json({ error: '只有站点管理员可以使用此功能' });
  app.get('/api/settings/playback', admin, (_req, res) => res.json(playbackSettings()));
  app.post('/api/settings/playback', admin, (req, res) => {
    const delivery = req.body?.delivery ?? req.body?.bilibiliDelivery;
    if (!['proxy', 'direct'].includes(delivery)) throw new Error('请选择直连或服务器中继');
    store.data.settings = { ...store.data.settings, delivery, bilibiliDelivery: delivery };
    store.save(); res.json(playbackSettings());
  });
  app.get('/api/bilibili/account', admin, async (_req, res) => res.json(await account.publicStatus()));
  app.post('/api/bilibili/account/refresh', admin, async (req, res) => {
    throttle(`bili-refresh:${req.session.user.id}`, 6);
    res.json(await account.publicStatus({ refresh: true }));
  });
  app.post('/api/bilibili/account/login', admin, async (req, res) => {
    throttle(`bili-login:${req.session.user.id}`, 6);
    const result = await account.start(cookieId(req));
    res.json({ id: result.id, expiresAt: result.expiresAt, qrImage: await QRCode.toDataURL(result.qrUrl, { width: 256, margin: 2, errorCorrectionLevel: 'M' }) });
  });
  app.post('/api/bilibili/account/poll', admin, async (req, res) => {
    throttle(`bili-poll:${req.session.user.id}`, 30);
    const result = await account.poll(cookieId(req), req.body?.id);
    subtitleCache = new WeakMap(); res.json(result);
  });
  app.post('/api/bilibili/account/logout', admin, async (_req, res) => {
    await account.remove(); subtitleCache = new WeakMap(); res.json(await account.publicStatus());
  });
  const roomAccess = (req, res, next) => {
    const roomId = req.headers['x-watch-room'] || req.query.room;
    if (typeof roomId !== 'string' || !/^(?:[a-f0-9]{24}|[a-f0-9]{48})$/.test(roomId)) return res.status(400).json({ error: '房间编号无效' });
    const grant = req.session.grants[roomId];
    if (!grant || grant.expires <= Date.now()) return res.status(403).json({ error: '没有此影院权限，请从对应聊天重新进入' });
    req.grant = grant; req.room = store.room(roomId); next();
  };
  const trackPath = (room, index, delivery) => `/api/bilibili/track?room=${room.id}&version=${room.mediaVersion}&track=${index}${delivery ? `&delivery=${delivery}` : ''}`;
  const publicMedia = room => {
    if (!room.media) return null;
    const { bilibili, ...media } = room.media;
    if (bilibili) {
      const base = media.kind === 'dash' ? `/api/bilibili/manifest?room=${room.id}&version=${room.mediaVersion}` : trackPath(room, 0);
      media.provider = 'bilibili';
      media.playbackMode = media.playbackMode === 'direct' ? 'direct' : 'proxy';
      media.url = base + (media.playbackMode === 'direct' ? '&delivery=direct' : '');
      if (media.playbackMode === 'direct' && media.kind === 'mp4') media.url = mediaUrl(bilibili.tracks[0].url);
      if (media.playbackMode === 'direct') media.fallbackUrl = base + '&delivery=proxy';
      const labels = { 6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P 60帧', 80: '1080P', 112: '1080P 高码率', 116: '1080P 60帧', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' };
      media.qualities = bilibili.tracks.filter(track => track.type === 'video').map(track => ({ id: track.id, representationId: track.id, label: labels[track.quality] || `${Math.min(track.width, track.height)}P`, width: track.width, height: track.height, frameRate: track.frameRate }));
    } else if (['hls', 'mp4'].includes(media.kind) && /^https?:\/\//i.test(media.url)) {
      media.playbackMode = media.playbackMode === 'proxy' ? 'proxy' : 'direct';
      if (media.playbackMode === 'proxy') { if (media.source === media.url) delete media.source; media.url = relay.path(room); }
      else media.fallbackUrl = relay.path(room);
    }
    return media;
  };
  const snapshot = (room, session, grant) => ({ ...room, media: publicMedia(room), serverTime: Date.now(), user: session.user, canControl: grant.canControl, fioraUrl: config.issuer });
  const publish = room => {
    for (const stream of streams) if (stream.room.id === room.id) stream.res.write(`data: ${JSON.stringify(snapshot(room, stream.session, stream.grant))}\n\n`);
  };
  app.get('/api/state', roomAccess, (req, res) => res.json(snapshot(req.room, req.session, req.grant)));
  app.get('/api/catalog/search', roomAccess, async (req, res) => {
    throttle(`catalog:${req.session.user.id}`, 30);
    res.json(await catalog.search(req.query.q, req.query.page || 1));
  });
  app.get('/api/catalog/episodes', roomAccess, async (req, res) => {
    throttle(`catalog:${req.session.user.id}`, 30);
    res.json(isBilibiliUrl(req.query.url) ? await listBilibiliEpisodes(req.query.url, config.hosts, readBilibili) : await catalog.episodes(req.query.url));
  });
  app.get('/api/media/relay', roomAccess, async (req, res, next) => {
    const media = req.room.media;
    if (!media || media.bilibili || !['hls', 'mp4'].includes(media.kind) || !/^https?:\/\//i.test(media.url) ||
        String(req.room.mediaVersion) !== req.query.version || typeof req.query.resource !== 'string' ||
        (req.query.resource !== 'root' && !relay.validToken(req.query.resource))) return res.sendStatus(404);
    const resource = relay.resource(req.room, req.query.resource);
    if (!resource) return res.sendStatus(404);
    if (relayStreams.size >= 256 || [...relayStreams].filter(active => active.room === req.room.id).length >= 24) return res.status(503).json({ error: '中继请求过多，请稍后重试' });
    const controller = new AbortController();
    const selection = { id: req.room.id, mediaVersion: req.room.mediaVersion, media };
    const active = { room: req.room.id, session: req.session, grant: req.grant, controller }; relayStreams.add(active);
    const expiry = setTimeout(() => controller.abort(), Math.max(1, req.grant.expires - Date.now()));
    const abort = () => controller.abort(); res.on('close', abort);
    try {
      const upstream = await relay.open(resource, req.headers.range, controller.signal);
      const response = upstream.response;
      if (req.room.media !== media || req.grant.expires <= Date.now()) { response.destroy(); return res.sendStatus(409); }
      res.set({ 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store, no-transform' });
      if (response.statusCode === 416) {
        res.status(416).set('Content-Length', '0');
        if (response.headers['content-range']) res.set('Content-Range', response.headers['content-range']);
        response.destroy(); return res.end();
      }
      if (relay.isManifest(resource, upstream)) {
        const manifest = await relay.manifest(selection, upstream, controller.signal);
        if (req.room.media !== media || req.grant.expires <= Date.now()) return res.sendStatus(409);
        return res.type('application/vnd.apple.mpegurl').send(manifest);
      }
      const contentType = String(response.headers['content-type'] || '');
      res.status(response.statusCode).type(/^(?:video\/|audio\/|application\/(?:octet-stream|mp4)(?:;|$))/i.test(contentType) ? contentType : media.kind === 'mp4' ? 'video/mp4' : 'application/octet-stream');
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) if (response.headers[name]) res.set(name, response.headers[name]);
      if (req.method === 'HEAD') { response.destroy(); return res.end(); }
      await pipeline(response, res);
    } catch (error) { if (!res.headersSent && !res.destroyed) next(error); else res.destroy(); }
    finally { relayStreams.delete(active); clearTimeout(expiry); res.off('close', abort); controller.abort(); }
  });
  const bilibiliAccess = (req, res, next) => {
    if (!req.room.media?.bilibili || String(req.room.mediaVersion) !== req.query.version) return res.status(404).json({ error: '影片已切换，请刷新播放页' });
    next();
  };
  app.get('/api/bilibili/manifest', roomAccess, bilibiliAccess, (req, res) => {
    const delivery = req.room.media.playbackMode === 'direct' && req.query.delivery === 'direct' ? 'direct' : undefined;
    res.type('application/dash+xml').send(buildBilibiliManifest(req.room.media, (_track, index) => trackPath(req.room, index), { direct: delivery === 'direct' }));
  });
  async function subtitlesFor(media) {
    let cached = subtitleCache.get(media);
    if (!cached || cached.expires <= Date.now()) {
      cached = { expires: Date.now() + 60000, tracks: new Map(), pending: Promise.resolve().then(() => listSubtitles(media)) };
      subtitleCache.set(media, cached);
      cached.pending.catch(() => { if (subtitleCache.get(media) === cached) subtitleCache.delete(media); });
    }
    return { cached, result: await cached.pending };
  }
  app.get('/api/bilibili/subtitles', roomAccess, bilibiliAccess, async (req, res) => {
    throttle(`subtitles:${req.session.user.id}`, 60);
    const media = req.room.media; const { result } = await subtitlesFor(media);
    if (req.room.media !== media || req.grant.expires <= Date.now()) return res.sendStatus(409);
    res.json({ status: result.status, message: result.message, subtitles: result.subtitles.map(track => ({ id: track.id, label: track.label, language: track.language,
      url: `/api/bilibili/subtitle?room=${req.room.id}&version=${req.room.mediaVersion}&id=${encodeURIComponent(track.id)}` })) });
  });
  app.get('/api/bilibili/subtitle', roomAccess, bilibiliAccess, async (req, res) => {
    if (typeof req.query.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(req.query.id)) return res.sendStatus(404);
    throttle(`subtitle-file:${req.session.user.id}`, 60);
    const media = req.room.media; const { cached, result } = await subtitlesFor(media);
    const track = result.subtitles.find(item => item.id === req.query.id);
    if (!track) return res.sendStatus(404);
    if (!cached.tracks.has(track.id)) {
      const pending = Promise.resolve().then(() => fetchSubtitle(track)); cached.tracks.set(track.id, pending);
      pending.catch(() => cached.tracks.delete(track.id));
    }
    const text = await cached.tracks.get(track.id);
    if (req.room.media !== media || req.grant.expires <= Date.now()) return res.sendStatus(409);
    res.type('text/vtt').send(text);
  });
  app.get('/api/bilibili/track', roomAccess, bilibiliAccess, async (req, res, next) => {
    if (typeof req.query.track !== 'string' || !/^\d{1,2}$/.test(req.query.track)) return res.sendStatus(404);
    const index = Number(req.query.track); const media = req.room.media;
    if (!media.bilibili.tracks[index]) return res.sendStatus(404);
    if (media.playbackMode === 'direct' && req.query.delivery === 'direct') {
      // Signed CDN links are disclosed only to an authorized viewer in explicit direct mode.
      // Browser CORS / source restrictions may require the player's proxy fallback.
      return res.redirect(302, mediaUrl(media.bilibili.tracks[index].url));
    }
    const controller = new AbortController();
    const expiry = setTimeout(() => controller.abort(), Math.max(1, req.grant.expires - Date.now()));
    res.on('close', () => controller.abort());
    try {
      let upstream;
      try { upstream = await requestTrack(media.bilibili.tracks[index], req.headers.range, controller.signal); }
      catch (error) {
        // Refresh expired CDN links, retaining exactly the same DASH representations.
        if (!/HTTP (403|410)/.test(error.message)) throw error;
        const key = `${req.room.id}:${req.query.version}`;
        if (!refreshing.has(key)) refreshing.set(key, resolveBili(media.source).finally(() => refreshing.delete(key)));
        const renewed = await refreshing.get(key);
        if (req.room.media !== media) return res.sendStatus(409);
        const replacements = media.bilibili.tracks.map(old => renewed.bilibili.tracks.find(track => track.id === old.id && track.codecs === old.codecs && track.bandwidth === old.bandwidth && track.initialization === old.initialization && track.indexRange === old.indexRange));
        if (replacements.some(track => !track)) throw new Error('B站片源已改变，请重新选择当前分P');
        media.bilibili.tracks = replacements; store.save();
        upstream = await requestTrack(media.bilibili.tracks[index], req.headers.range, controller.signal);
      }
      if (req.grant.expires <= Date.now() || req.room.media !== media) { upstream.response.destroy(); return res.sendStatus(403); }
      const response = upstream.response;
      res.status(response.statusCode).type(media.bilibili.tracks[index].mimeType);
      // Keep range responses streaming through reverse proxies without buffering
      // or transforming the byte representation used by DASH SegmentBase.
      res.set({ 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store, no-transform' });
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers[name]) res.set(name, response.headers[name]);
      if (response.statusCode === 416 || req.method === 'HEAD') { response.destroy(); if (response.statusCode === 416) res.set('Content-Length', '0'); return res.end(); }
      await pipeline(response, res);
    } catch (error) { if (!res.headersSent && !res.destroyed) next(error); else res.destroy(); }
    finally { clearTimeout(expiry); }
  });
  app.get('/api/chat', roomAccess, async (req, res) => {
    throttle(`read:${req.session.user.id}`, 120);
    try { res.json(await chat(req.grant, { action: 'read' })); }
    catch (error) {
      if ([401, 403].includes(error.status)) req.grant.expires = 0;
      throw error;
    }
  });
  app.post('/api/chat', roomAccess, async (req, res) => {
    throttle(`comment:${req.session.user.id}`, 30);
    if (typeof req.body?.content !== 'string' || req.body.content.length > 2048 || !req.body.content.trim() ||
        !/^[a-f0-9-]{36}$/.test(req.body.requestId)) throw new Error('评论或发送编号无效');
    res.json(await chat(req.grant, { action: 'send', content: req.body.content, requestId: req.body.requestId }));
  });
  app.get('/api/events', roomAccess, (req, res) => {
    if (streams.size >= 100) throw new Error('影院连接数量已达上限');
    res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' }); res.flushHeaders();
    const stream = { res, room: req.room, session: req.session, grant: req.grant }; streams.add(stream);
    res.write(`data: ${JSON.stringify(snapshot(req.room, req.session, req.grant))}\n\n`);
    req.on('close', () => streams.delete(stream));
  });
  app.post('/api/control', roomAccess, (req, res) => {
    if (!req.grant.canControl) return res.status(403).json({ error: '只有私聊参与者、群主或管理员可以控制播放' });
    throttle(req.session.user.id, 120);
    control(req.room, req.body); store.save(); publish(req.room); res.json({ ok: true });
  });
  app.post('/api/media', roomAccess, async (req, res) => {
    if (!req.grant.canControl) return res.status(403).json({ error: '没有切换视频的权限' });
    throttle(`media:${req.session.user.id}`, 15);
    const revision = req.body.revision;
    let media = null;
    if (req.body.mode === 'online') media = await resolve(req.body.url, config.hosts);
    else if (req.body.mode === 'local') {
      media = library.list().find(item => item.id === req.body.id);
      if (!media) throw new Error('本地视频不存在');
    } else if (req.body.mode !== 'clear') throw new Error('播放模式无效');
    if (req.grant.expires <= Date.now() || revision !== req.room.revision) throw new Error('房间状态已改变，请刷新后重新选择');
    if (media && req.body.mode === 'online') media.playbackMode = playbackSettings().delivery;
    for (const active of relayStreams) if (active.room === req.room.id) active.controller.abort();
    Object.assign(req.room, { media, mediaVersion: req.room.revision + 1, paused: !media, position: 0, updatedAt: Date.now(), revision: req.room.revision + 1 });
    store.save(); publish(req.room);
    // Serialize cover/title changes so a slow earlier choice cannot overwrite a newer card.
    const selected = media;
    const previous = invitationUpdates.get(req.room.id) || Promise.resolve();
    const update = previous.catch(() => {}).then(async () => {
      if (req.room.media !== selected) return;
      await chat(req.grant, { action: 'media', title: (selected?.seriesTitle || selected?.title || '一起看').slice(0, 180),
        cover: selected?.cover || '', source: selected?.source?.startsWith('https://') ? selected.source : '' });
    });
    invitationUpdates.set(req.room.id, update);
    let warning;
    try { await update; } catch { warning = '影片已加载，Fiora 邀请卡片暂未更新'; }
    finally { if (invitationUpdates.get(req.room.id) === update) invitationUpdates.delete(req.room.id); }
    res.json({ ok: true, ...(warning ? { warning } : {}) });
  });
  registerLibraryRoutes(app, { library, requireAdmin: admin });
  app.get('/api/downloads', admin, (_req, res) => res.json({ jobs: library.jobs?.() || store.data.jobs, usedBytes: library.usedBytes(), quota: config.cacheBytes }));
  app.post('/api/downloads', admin, (req, res) => { throttle(`download:${req.session.user.id}`, 10); res.json(library.enqueue(req.body.url, req.session.user.id)); });
  app.post('/api/downloads/batch', admin, (req, res) => { throttle(`download-batch:${req.session.user.id}`, 6); res.json(library.enqueueBatch(req.body.urls, req.session.user.id)); });
  app.post('/api/downloads/:id/remove', admin, (req, res) => { library.cancel(req.params.id); res.json({ ok: true }); });
  app.post('/api/logout', (req, res) => {
    account.cancel(cookieId(req));
    const session = req.session; sessions.delete(cookieId(req));
    for (const active of relayStreams) if (active.session === session) active.controller.abort();
    for (const stream of streams) if (stream.session === session) { stream.res.end(); streams.delete(stream); }
    res.clearCookie('watch_session', { path: '/' }); res.json({ ok: true });
  });
  app.use('/media', authenticate, (req, res) => {
    try {
      const relative = decodeURIComponent(req.path);
      let file;
      if (relative.startsWith('/local/') && /\.(mp4|webm)$/i.test(relative)) file = safeFile(config.libraryDir, relative.slice(7));
      else if (/^\/download\/[a-f0-9-]{36}\/(?:index\.m3u8|video\.mp4|\d+\.ts)$/.test(relative)) file = safeFile(library.root, relative.slice(10));
      else return res.sendStatus(404);
      // Express implements byte ranges for seeking, including 206 and 416 responses.
      return res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, error => { if (error && !res.headersSent) res.sendStatus(error.status === 416 ? 416 : 404); });
    } catch { return res.sendStatus(404); }
  });
  const assets = publicAssets(path.resolve(here, '..'));
  app.use(assets);
  app.get(['/', '/index.html', '/room/:id'], (_req, res) => res.type('html').send(assets.html('index.html')));
  app.get(['/manage.html', '/room/:id/manage'], (_req, res) => res.type('html').send(assets.html('manage.html')));
  app.use(express.static(path.resolve(here, '../public'), { etag: false }));
  app.use((error, _req, res, _next) => { if (!res.headersSent) res.status([401, 403, 409, 503].includes(error.status) ? error.status : 400).json({ error: String(error.message || '请求失败').slice(0, 240) }); });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const active of relayStreams) if (active.grant.expires <= now) active.controller.abort();
    for (const stream of streams) {
      if (stream.grant.expires <= now) { stream.res.end(); streams.delete(stream); }
      else stream.res.write(`data: ${JSON.stringify(snapshot(stream.room, stream.session, stream.grant))}\n\n`);
    }
    for (const [id, session] of sessions) if (!Object.values(session.grants).some(grant => grant.expires > now)) { account.cancel(id); sessions.delete(id); }
    for (const [key, value] of limits) if (value.since < now - 60000) limits.delete(key);
  }, 5000);
  timer.unref();
  return { app, store, library, close: () => { clearInterval(timer); library.abort?.abort(); for (const stream of streams) stream.res.end(); for (const active of relayStreams) active.controller.abort(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const instance = createApp(config);
  const server = instance.app.listen(config.port, config.host, () => console.log(`Fiora Watch listening on port ${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { instance.close(); server.close(); });
}
