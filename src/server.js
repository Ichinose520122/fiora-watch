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
import { isBilibiliUrl, listBilibiliEpisodes, resolveBilibili, buildBilibiliManifest, requestBilibiliTrack } from './bilibili.js';
import { pipeline } from 'node:stream/promises';

export const SESSION_MS = 180 * 60000;

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config, dependencies = {}) {
  const app = express();
  const store = dependencies.store || new Store(config.dataDir);
  const sessions = new Map(); const streams = new Set(); const limits = new Map();
  const library = dependencies.library || new MediaLibrary(config, store);
  const resolve = dependencies.resolve || resolveMedia;
  const chat = dependencies.chat || createChatBridge(config);
  const catalog = dependencies.catalog || createCatalog(config.hosts);
  const requestTrack = dependencies.requestTrack || requestBilibiliTrack;
  const refreshing = new Map();
  const invitationUpdates = new Map();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src 'self' https: blob:; connect-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: '12kb' }));
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
  const roomAccess = (req, res, next) => {
    const roomId = req.headers['x-watch-room'] || req.query.room;
    if (typeof roomId !== 'string' || !/^(?:[a-f0-9]{24}|[a-f0-9]{48})$/.test(roomId)) return res.status(400).json({ error: '房间编号无效' });
    const grant = req.session.grants[roomId];
    if (!grant || grant.expires <= Date.now()) return res.status(403).json({ error: '没有此影院权限，请从对应聊天重新进入' });
    req.grant = grant; req.room = store.room(roomId); next();
  };
  const trackPath = (room, index) => `/api/bilibili/track?room=${room.id}&version=${room.mediaVersion}&track=${index}`;
  const publicMedia = room => {
    if (!room.media) return null;
    const { bilibili, ...media } = room.media;
    if (bilibili) media.url = media.kind === 'dash' ? `/api/bilibili/manifest?room=${room.id}&version=${room.mediaVersion}` : trackPath(room, 0);
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
    res.json(isBilibiliUrl(req.query.url) ? await listBilibiliEpisodes(req.query.url) : await catalog.episodes(req.query.url));
  });
  const bilibiliAccess = (req, res, next) => {
    if (!req.room.media?.bilibili || String(req.room.mediaVersion) !== req.query.version) return res.status(404).json({ error: '影片已切换，请刷新播放页' });
    next();
  };
  app.get('/api/bilibili/manifest', roomAccess, bilibiliAccess, (req, res) => {
    res.type('application/dash+xml').send(buildBilibiliManifest(req.room.media, (_track, index) => trackPath(req.room, index)));
  });
  app.get('/api/bilibili/track', roomAccess, bilibiliAccess, async (req, res, next) => {
    if (typeof req.query.track !== 'string' || !/^\d{1,2}$/.test(req.query.track)) return res.sendStatus(404);
    const index = Number(req.query.track); const media = req.room.media;
    if (!media.bilibili.tracks[index]) return res.sendStatus(404);
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
        if (!refreshing.has(key)) refreshing.set(key, resolveBilibili(media.source).finally(() => refreshing.delete(key)));
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
    Object.assign(req.room, { media, mediaVersion: req.room.revision + 1, paused: true, position: 0, updatedAt: Date.now(), revision: req.room.revision + 1 });
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
  app.get('/api/library', (_req, res) => res.json({ items: library.list() }));
  const admin = (req, res, next) => req.session.user.admin ? next() : res.status(403).json({ error: '只有站点管理员可以管理下载' });
  app.get('/api/downloads', admin, (_req, res) => res.json({ jobs: store.data.jobs, usedBytes: library.usedBytes(), quota: config.cacheBytes }));
  app.post('/api/downloads', admin, (req, res) => { throttle(`download:${req.session.user.id}`, 10); res.json(library.enqueue(req.body.url, req.session.user.id)); });
  app.post('/api/downloads/:id/remove', admin, (req, res) => { library.cancel(req.params.id); res.json({ ok: true }); });
  app.post('/api/logout', (req, res) => {
    const session = req.session; sessions.delete(cookieId(req));
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
  app.get('/vendor/hls.min.js', (_req, res) => res.sendFile(path.resolve(here, '../node_modules/hls.js/dist/hls.min.js')));
  app.get('/vendor/dash.all.min.js', (_req, res) => res.sendFile(path.resolve(here, '../node_modules/dashjs/dist/modern/umd/dash.all.min.js')));
  app.use(express.static(path.resolve(here, '../public'), { etag: false }));
  app.get('/room/:id', (_req, res) => res.sendFile(path.resolve(here, '../public/index.html')));
  app.get('/room/:id/manage', (_req, res) => res.sendFile(path.resolve(here, '../public/manage.html')));
  app.use((error, _req, res, _next) => { if (!res.headersSent) res.status([401, 403, 409, 503].includes(error.status) ? error.status : 400).json({ error: String(error.message || '请求失败').slice(0, 240) }); });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const stream of streams) {
      if (stream.grant.expires <= now) { stream.res.end(); streams.delete(stream); }
      else stream.res.write(`data: ${JSON.stringify(snapshot(stream.room, stream.session, stream.grant))}\n\n`);
    }
    for (const [id, session] of sessions) if (!Object.values(session.grants).some(grant => grant.expires > now)) sessions.delete(id);
    for (const [key, value] of limits) if (value.since < now - 60000) limits.delete(key);
  }, 5000);
  timer.unref();
  return { app, store, library, close: () => { clearInterval(timer); library.abort?.abort(); for (const stream of streams) stream.res.end(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const instance = createApp(config);
  const server = instance.app.listen(config.port, config.host, () => console.log(`Fiora Watch listening on port ${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { instance.close(); server.close(); });
}
