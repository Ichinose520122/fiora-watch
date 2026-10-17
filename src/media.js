import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestPublic, fetchText, allowedUrl } from './network.js';
import { resolveMedia, parsePlaylist } from './resolver.js';
import { isBilibiliUrl } from './bilibili.js';

export function safeFile(root, relative) {
  const base = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(base, relative));
  if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) throw new Error('文件不存在');
  return file;
}

export class MediaLibrary {
  constructor(config, store, notify = () => {}, dependencies = {}) {
    this.config = config; this.store = store; this.notify = notify;
    this.resolve = dependencies.resolve || resolveMedia;
    this.request = dependencies.request || requestPublic;
    this.read = dependencies.read || fetchText;
    this.root = path.join(config.dataDir, 'media');
    this.tmp = path.join(config.dataDir, 'partial');
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.tmp, { recursive: true });
    fs.mkdirSync(config.libraryDir, { recursive: true });
    // Only our UUID-named staging directories can be cleaned after a crash.
    for (const entry of fs.readdirSync(this.tmp)) {
      if (/^[a-f0-9-]{36}$/.test(entry)) fs.rmSync(path.join(this.tmp, entry), { recursive: true, force: true });
    }
  }
  list() {
    const items = [];
    // User-mounted media is read-only, discovered recursively without following symlinks.
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > 8 || items.length >= 2000) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + '/', depth + 1);
        else if (/\.(mp4|webm)$/i.test(entry.name)) items.push({ id: `local:${relative}`, title: relative, kind: 'file', url: `/media/local/${relative.split('/').map(encodeURIComponent).join('/')}` });
      }
    };
    walk(this.config.libraryDir);
    for (const job of this.store.data.jobs) {
      if (job.status === 'done') items.push({ id: `download:${job.id}`, title: job.title, cover: job.cover || '', seriesTitle: job.seriesTitle || '', source: job.source, kind: job.kind === 'hls' ? 'hls' : 'file', url: `/media/download/${job.id}/${job.kind === 'hls' ? 'index.m3u8' : 'video.mp4'}` });
    }
    return items;
  }
  usedBytes() {
    let bytes = 0;
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else bytes += fs.statSync(file).size;
    } };
    walk(this.root); walk(this.tmp); return bytes;
  }
  enqueue(source, actor) {
    return this.enqueueBatch([source], actor, { reuseCompleted: false }).jobs[0];
  }
  enqueueBatch(sources, actor, { reuseCompleted = true } = {}) {
    if (!Array.isArray(sources) || !sources.length || sources.length > 100) throw new Error('每批请选择 1–100 集');
    // Validate the complete request before mutating persisted state or starting work.
    const normalized = sources.map(source => {
      if (typeof source !== 'string' || !source.trim() || source.length > 4096) throw new Error('视频地址格式错误');
      if (isBilibiliUrl(source.trim())) throw new Error('B站视频请使用在线模式，暂不支持提前下载');
      const url = allowedUrl(source.trim(), this.config.hosts); url.hash = '';
      if (url.hostname === 'ani.girigirilove.com' && /^\/playGV\d+-\d+-\d+\/?$/.test(url.pathname)) { url.pathname = url.pathname.replace(/\/?$/, '/'); url.search = ''; }
      return url.href;
    });
    const unique = [...new Set(normalized)]; const jobs = []; const additions = [];
    for (const source of unique) {
      const existing = this.store.data.jobs.find(job => job.source === source && (['queued', 'running'].includes(job.status) || reuseCompleted && job.status === 'done'));
      if (existing) { jobs.push(existing); continue; }
      const episode = /\/playGV\d+-(\d+)-(\d+)\//.exec(new URL(source).pathname);
      const job = { id: randomUUID(), source, by: actor, title: episode ? `第 ${episode[2]} 集 · 等待解析` : '等待解析',
        ...(episode ? { group: `线路 ${episode[1]}`, episodeNumber: Number(episode[2]) } : {}),
        status: 'queued', stage: 'queued', bytes: 0, completed: 0, total: 0, progress: 0, speedBytesPerSecond: 0, createdAt: Date.now(), updatedAt: Date.now() };
      additions.push(job); jobs.push(job);
    }
    if (this.store.data.jobs.filter(job => ['queued', 'running'].includes(job.status)).length + additions.length > 200) throw new Error('下载队列已满（最多 200 集），请等待当前任务完成');
    if (this.store.data.jobs.length + additions.length > 1000) throw new Error('下载记录已达上限，请删除旧任务');
    if (additions.length) { this.store.data.jobs.push(...additions); this.store.save(); this.notify(); void this.run(); }
    return { jobs, added: additions.length, skipped: normalized.length - additions.length };
  }
  update(job, values = {}, force = false) {
    const now = Date.now(); Object.assign(job, values, { updatedAt: now });
    if (job.status === 'running') {
      job.speedBytesPerSecond = Math.round(job.bytes * 1000 / Math.max(1, now - (job.transferStartedAt || now)));
      job.progress = job.kind === 'hls' ? (job.total ? job.completed / job.total : 0) : (job.expectedBytes ? job.bytes / job.expectedBytes : 0);
      job.progress = Math.min(0.999, Math.max(0, job.progress));
    }
    if (force || now - (this.lastProgressSave || 0) >= 1000) { this.lastProgressSave = now; this.store.save(); this.notify(); }
  }
  cancel(id) {
    const job = this.store.data.jobs.find(item => item.id === id);
    if (!job) throw new Error('下载任务不存在');
    if (job.status === 'running') { this.update(job, { stage: 'cancelling', cancelRequestedAt: Date.now() }, true); this.abort?.abort(new Error('下载已取消')); return; }
    if (job.status === 'queued') { this.update(job, { status: 'cancelled', stage: 'cancelled', finishedAt: Date.now(), speedBytesPerSecond: 0 }, true); return; }
    if (Object.values(this.store.data.rooms).some(room => room.media?.id === `download:${id}`)) throw new Error('此视频仍被影院选中，请先切换或清空视频');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务编号无效');
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    this.store.data.jobs = this.store.data.jobs.filter(item => item !== job); this.store.save();
  }
  async copy(url, destination, job, budget, signal) {
    const { response } = await this.request(url, this.config.hosts, signal);
    const length = Number(response.headers?.['content-length']);
    const expected = Number.isSafeInteger(length) && length > 0 ? length : 0;
    let received = 0;
    if (job.kind === 'mp4') job.expectedBytes = expected;
    if (expected && (job.bytes + expected > this.config.maxDownloadBytes || budget + job.bytes + expected > this.config.cacheBytes)) {
      response.destroy(); throw new Error('下载超过单文件限制或缓存容量，请清理空间');
    }
    let handle;
    try {
      handle = await fsp.open(destination, 'wx');
      for await (const chunk of response) {
        if (signal.aborted) throw signal.reason;
        received += chunk.length; job.bytes += chunk.length;
        if (job.bytes > this.config.maxDownloadBytes || budget + job.bytes > this.config.cacheBytes) throw new Error('下载超过单文件限制或缓存容量，请清理空间');
        await handle.writeFile(chunk);
        this.update(job);
      }
      if (expected && received !== expected) throw new Error('来源提前中断，下载字节数与文件大小不符');
    } finally { response.destroy(); await handle?.close(); }
  }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      let job;
      while ((job = this.store.data.jobs.find(item => item.status === 'queued'))) {
        this.abort = new AbortController();
        const timeout = setTimeout(() => this.abort?.abort(new Error('下载超过两小时限制')), 2 * 3600000);
        const directory = path.join(this.tmp, job.id);
        try {
          const budget = this.usedBytes();
          if (budget >= this.config.cacheBytes) throw new Error('缓存已满，请删除旧下载');
          this.update(job, { status: 'running', stage: 'resolving', startedAt: Date.now(), error: '' }, true);
          const media = await this.resolve(job.source, this.config.hosts);
          if (this.abort.signal.aborted) throw this.abort.signal.reason;
          if (media.bilibili || media.kind === 'dash') throw new Error('B站视频请使用在线模式，暂不支持提前下载');
          this.update(job, { title: media.title, kind: media.kind, cover: media.cover || '', seriesTitle: media.seriesTitle || '',
            episodeTitle: media.episodeTitle || '', group: media.group || job.group || '', episodeNumber: media.episodeNumber || job.episodeNumber }, true);
          fs.mkdirSync(directory);
          const signal = this.abort.signal;
          if (media.kind === 'hls') {
            this.update(job, { stage: 'playlist' }, true);
            let url = media.url; let playlist;
            for (let depth = 0; depth < 4; depth += 1) {
              const result = await this.read(url, this.config.hosts, signal);
              playlist = parsePlaylist(result.text, result.url, this.config.hosts);
              if (!playlist.variant) break;
              url = playlist.variant;
            }
            if (!playlist?.urls) throw new Error('HLS 清单嵌套过深');
            job.total = playlist.urls.length;
            this.update(job, { stage: 'downloading', transferStartedAt: Date.now() }, true);
            for (const [index, segment] of playlist.urls.entries()) {
              job.currentSegment = index + 1;
              await this.copy(segment, path.join(directory, `${index}.ts`), job, budget, signal);
              this.update(job, { completed: index + 1 });
            }
            fs.writeFileSync(path.join(directory, 'index.m3u8'), playlist.local);
          } else {
            job.total = 1;
            this.update(job, { stage: 'downloading', transferStartedAt: Date.now() }, true);
            await this.copy(media.url, path.join(directory, 'video.mp4'), job, budget, signal);
            job.completed = 1;
          }
          if (signal.aborted) throw signal.reason;
          this.update(job, { stage: 'finalizing' }, true);
          fs.renameSync(directory, path.join(this.root, job.id));
          Object.assign(job, { status: 'done', stage: 'done', progress: 1, expectedBytes: job.bytes });
        } catch (error) {
          job.status = this.abort.signal.aborted && this.abort.signal.reason?.message !== '下载超过两小时限制' ? 'cancelled' : 'failed';
          job.stage = job.status;
          job.error = String(error.message || error).slice(0, 240);
          fs.rmSync(directory, { recursive: true, force: true });
        } finally { clearTimeout(timeout); this.update(job, { finishedAt: Date.now(), speedBytesPerSecond: 0 }, true); }
      }
    } finally { this.abort = null; this.running = false; }
  }
}
