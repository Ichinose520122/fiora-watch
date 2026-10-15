import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestPublic, fetchText } from './network.js';
import { resolveMedia, parsePlaylist } from './resolver.js';

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
      if (job.status === 'done') items.push({ id: `download:${job.id}`, title: job.title, kind: job.kind === 'hls' ? 'hls' : 'file', url: `/media/download/${job.id}/${job.kind === 'hls' ? 'index.m3u8' : 'video.mp4'}` });
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
    if (typeof source !== 'string' || source.length > 4096) throw new Error('视频地址格式错误');
    if (this.store.data.jobs.filter(job => ['queued', 'running'].includes(job.status)).length >= 10) throw new Error('下载队列已满');
    if (this.store.data.jobs.length >= 1000) throw new Error('下载记录已达上限，请删除旧任务');
    const job = { id: randomUUID(), source, by: actor, title: '等待解析', status: 'queued', bytes: 0, completed: 0, total: 0, createdAt: Date.now() };
    this.store.data.jobs.push(job); this.store.save();
    void this.run(); return job;
  }
  cancel(id) {
    const job = this.store.data.jobs.find(item => item.id === id);
    if (!job) throw new Error('下载任务不存在');
    if (job.status === 'running') { this.abort?.abort(new Error('下载已取消')); return; }
    if (job.status === 'queued') { job.status = 'cancelled'; this.store.save(); return; }
    if (Object.values(this.store.data.rooms).some(room => room.media?.id === `download:${id}`)) throw new Error('此视频仍被影院选中，请先切换或清空视频');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务编号无效');
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    this.store.data.jobs = this.store.data.jobs.filter(item => item !== job); this.store.save();
  }
  async copy(url, destination, job, budget, signal) {
    const { response } = await this.request(url, this.config.hosts, signal);
    const handle = await fsp.open(destination, 'wx');
    try {
      for await (const chunk of response) {
        job.bytes += chunk.length;
        if (job.bytes > this.config.maxDownloadBytes || budget + job.bytes > this.config.cacheBytes) throw new Error('下载超过单文件限制或缓存容量，请清理空间');
        await handle.writeFile(chunk);
      }
    } finally { response.destroy(); await handle.close(); }
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
          job.status = 'running'; this.store.save();
          const media = await this.resolve(job.source, this.config.hosts);
          Object.assign(job, { title: media.title, kind: media.kind });
          fs.mkdirSync(directory);
          const signal = this.abort.signal;
          if (media.kind === 'hls') {
            let url = media.url; let playlist;
            for (let depth = 0; depth < 4; depth += 1) {
              const result = await this.read(url, this.config.hosts, signal);
              playlist = parsePlaylist(result.text, result.url, this.config.hosts);
              if (!playlist.variant) break;
              url = playlist.variant;
            }
            if (!playlist?.urls) throw new Error('HLS 清单嵌套过深');
            job.total = playlist.urls.length;
            for (const [index, segment] of playlist.urls.entries()) {
              await this.copy(segment, path.join(directory, `${index}.ts`), job, budget, signal);
              job.completed = index + 1; this.store.save(); this.notify();
            }
            fs.writeFileSync(path.join(directory, 'index.m3u8'), playlist.local);
          } else {
            job.total = 1;
            await this.copy(media.url, path.join(directory, 'video.mp4'), job, budget, signal);
            job.completed = 1;
          }
          if (signal.aborted) throw signal.reason;
          fs.renameSync(directory, path.join(this.root, job.id));
          job.status = 'done';
        } catch (error) {
          job.status = this.abort.signal.aborted ? 'cancelled' : 'failed';
          job.error = String(error.message || error).slice(0, 240);
          fs.rmSync(directory, { recursive: true, force: true });
        } finally { clearTimeout(timeout); this.store.save(); this.notify(); }
      }
    } finally { this.abort = null; this.running = false; }
  }
}
