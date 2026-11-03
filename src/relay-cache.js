import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';

export const RELAY_CACHE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const RELAY_CACHE_MAX_ENTRIES = 4096;
const PROVIDERS = ['bilibili', 'girigiri'];
const OWN_FILE = /^relay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:tmp|cache)$/;

function validRange(response, size) {
  if (response.statusCode !== 206) return true;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(response.headers?.['content-range']));
  if (!match) return false;
  const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start && end - start + 1 === size &&
    (match[3] === '*' || (Number.isSafeInteger(total) && total > end));
}

// This is an expendable, process-local index. Restarting discards only this
// module's generated files; URLs, authorization tokens and keys are never named
// on disk. The caller supplies an already-authorized, range-aware cache key.
export class RelayCache {
  constructor({ directory, settings, now = Date.now }) {
    this.directory = directory; this.settings = settings; this.now = now;
    this.entries = new Map(); this.reservations = new Map(); this.closed = false; this.access = 0;
    this.serial = Promise.resolve();
    this.ready = this.initialize();
    this.timer = setInterval(() => { this.prune().catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  async initialize() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const item of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (item.isFile() && OWN_FILE.test(item.name)) await fs.unlink(path.join(this.directory, item.name));
      }
      this.available = true;
    } catch { this.available = false; }
  }
  policy(provider) {
    const value = this.settings()?.[provider] || {};
    return { enabled: value.enabled === true, maxBytes: Math.max(0, Number(value.maxBytes) || 0), ttlMs: Math.max(0, Number(value.ttlMs) || 0) };
  }
  locked(action) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {}); return result;
  }
  usage(provider) {
    let bytes = 0; let entries = 0; let reservedBytes = 0;
    for (const entry of this.entries.values()) if (entry.provider === provider) { bytes += entry.size; entries++; }
    for (const entry of this.reservations.values()) if (entry.provider === provider) reservedBytes += entry.size;
    return { bytes, entries, reservedBytes };
  }
  stats() { return Object.fromEntries(PROVIDERS.map(provider => [provider, this.usage(provider)])); }
  slots(provider) { return this.usage(provider).entries + [...this.reservations.values()].filter(entry => entry.provider === provider).length; }
  async remove(id, entry) {
    // Pin open readers: unlinking an open file on Unix retains its disk usage
    // until the last reader closes, so it must continue counting toward quota.
    if (this.entries.get(id) !== entry || entry.readers) return;
    // Keep accounting until unlink succeeds; a full/unavailable disk must not
    // permit subsequent admissions to exceed the configured physical quota.
    try { await fs.unlink(entry.file); } catch (error) { if (error.code !== 'ENOENT') return; }
    this.entries.delete(id);
  }
  async pruneLocked() {
    for (const provider of PROVIDERS) {
      const policy = this.policy(provider);
      for (const [id, entry] of this.entries) {
        if (entry.provider === provider && (!policy.enabled || !policy.ttlMs || this.now() - entry.created >= policy.ttlMs)) await this.remove(id, entry);
      }
      for (const reservation of [...this.reservations.values()]) {
        if (reservation.provider === provider && (!policy.enabled || !policy.ttlMs || this.usage(provider).bytes + this.usage(provider).reservedBytes > policy.maxBytes)) await reservation.stop();
      }
      const oldest = [...this.entries].filter(([, entry]) => entry.provider === provider).sort((a, b) => a[1].used - b[1].used);
      for (const [id, entry] of oldest) {
        if (this.usage(provider).bytes + this.usage(provider).reservedBytes <= policy.maxBytes) break;
        await this.remove(id, entry);
      }
    }
  }
  async prune() { await this.ready; return this.locked(() => this.pruneLocked()); }
  async open(provider, key, loadUpstream, { signal, cacheable = () => true } = {}) {
    await this.ready;
    signal?.throwIfAborted();
    const id = JSON.stringify([provider, key]);
    if (!this.closed && this.available && PROVIDERS.includes(provider)) {
      const hit = await this.locked(async () => {
        await this.pruneLocked();
        const entry = this.entries.get(id);
        const current = this.policy(provider);
        if (!entry || !current.enabled || !current.ttlMs || entry.size > current.maxBytes || this.now() - entry.created >= current.ttlMs) return null;
        // Opening before returning permits a missing cache file to fall back to upstream.
        let handle;
        try { handle = await fs.open(entry.file, 'r'); } catch { this.entries.delete(id); return null; }
        entry.used = ++this.access; entry.readers = (entry.readers || 0) + 1;
        const response = handle.createReadStream({ signal });
        response.once('close', () => { entry.readers--; });
        response.headers = { ...entry.headers }; response.statusCode = entry.statusCode;
        return { response, url: entry.url, cached: true };
      });
      if (hit) return hit;
    }
    const upstream = await loadUpstream();
    const source = upstream.response;
    const sizeHeader = source.headers?.['content-length'];
    const size = /^\d+$/.test(String(sizeHeader)) ? Number(sizeHeader) : NaN;
    const policy = this.policy(provider);
    if (this.closed || !this.available || !PROVIDERS.includes(provider) || !policy.enabled || !policy.ttlMs ||
        ![200, 206].includes(source.statusCode) || !Number.isSafeInteger(size) || size <= 0 ||
        size > RELAY_CACHE_MAX_ENTRY_BYTES || size > policy.maxBytes || !validRange(source, size) || !cacheable(upstream)) return upstream;
    if (signal?.aborted) { source.destroy(); signal.throwIfAborted(); }
    // The upstream can fail while disk admission/opening is awaiting I/O.
    // Retain its failure until the forwarding stream has installed listeners.
    let preparationError;
    const preparationFailure = error => { preparationError = error; };
    source.on('error', preparationFailure);
    const writer = { provider, size, active: true, pending: Promise.resolve() };
    const stem = `relay-${randomUUID()}`;
    writer.file = path.join(this.directory, `${stem}.tmp`);
    writer.stop = () => {
      writer.active = false;
      if (!writer.cleanup) writer.cleanup = (async () => {
        await writer.pending.catch(() => {});
        await writer.handle?.close().catch(() => {});
        try { await fs.unlink(writer.file); } catch (error) {
          // An undeletable temporary file keeps its reservation until restart.
          // ENOTDIR also means the temporary file cannot exist: a parent
          // component is a regular file, so there are no disk bytes to reserve.
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return;
        }
        if (this.reservations.get(id) === writer) this.reservations.delete(id);
      })();
      return writer.cleanup;
    };
    const admitted = await this.locked(async () => {
      await this.pruneLocked();
      const current = this.policy(provider);
      if (this.closed || this.reservations.has(id) || this.entries.has(id) || !current.enabled || !current.ttlMs || size > current.maxBytes) return false;
      for (const [oldId, entry] of [...this.entries].filter(([, entry]) => entry.provider === provider).sort((a, b) => a[1].used - b[1].used)) {
        if (this.usage(provider).bytes + this.usage(provider).reservedBytes + size <= current.maxBytes && this.slots(provider) < RELAY_CACHE_MAX_ENTRIES) break;
        await this.remove(oldId, entry);
      }
      if (this.usage(provider).bytes + this.usage(provider).reservedBytes + size > current.maxBytes || this.slots(provider) >= RELAY_CACHE_MAX_ENTRIES) return false;
      this.reservations.set(id, writer);
      try { writer.handle = await fs.open(writer.file, 'wx', 0o600); }
      catch { await writer.stop(); return false; }
      return true;
    });
    if (!admitted) {
      source.removeListener('error', preparationFailure);
      if (preparationError) throw preparationError;
      return upstream;
    }
    // A concurrent prune/close can cancel the reservation before streaming starts.
    if (!writer.active || this.closed || signal?.aborted || preparationError || (source.destroyed && !source.readableEnded)) {
      await writer.stop(); source.removeListener('error', preparationFailure);
      if (signal?.aborted) { source.destroy(); signal.throwIfAborted(); }
      if (preparationError) throw preparationError;
      if (source.destroyed && !source.readableEnded) throw new Error('Upstream response aborted');
      return upstream;
    }
    let received = 0; let complete = false; let finalByte;
    const response = new Transform({
      transform: (chunk, encoding, callback) => {
        received += chunk.length;
        writer.pending = (async () => {
          if (writer.active && received <= size) {
            try {
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await writer.handle.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error('Cache write made no progress');
                offset += bytesWritten;
              }
            } catch { writer.active = false; }
          } else writer.active = false;
        })();
        writer.pending.then(async () => {
          if (!writer.active) await writer.stop();
          if (finalByte) { response.push(finalByte); finalByte = undefined; }
          // Hold one byte until EOF and commit. Otherwise the HTTP client can
          // receive Content-Length bytes, close normally, and abort the writer
          // before the asynchronous flush has committed a complete cache file.
          if (writer.active && received === size) {
            finalByte = Buffer.from(chunk.subarray(chunk.length - 1));
            callback(null, chunk.subarray(0, chunk.length - 1)); return;
          }
          callback(null, chunk);
        }, callback);
      },
      flush: callback => {
        (async () => {
          if (writer.active && received === size && !signal?.aborted) {
            await writer.handle.close();
            await this.locked(async () => {
              const current = this.policy(provider);
              if (!writer.active || this.closed || !current.enabled || !current.ttlMs || this.reservations.get(id) !== writer) return;
              const file = path.join(this.directory, `${stem}.cache`);
              await fs.rename(writer.file, file);
              this.entries.set(id, { provider, size, file, url: upstream.url, statusCode: source.statusCode, headers: { ...source.headers }, created: this.now(), used: ++this.access, readers: 0 });
              this.reservations.delete(id); complete = true;
            });
          }
        })().catch(() => {}).finally(async () => {
          if (!complete) await writer.stop();
          if (!response.destroyed && finalByte) { response.push(finalByte); finalByte = undefined; }
          callback();
        });
      },
      destroy: (error, callback) => {
        source.unpipe(response); source.destroy();
        signal?.removeEventListener('abort', abort);
        source.removeListener('error', sourceError); source.removeListener('aborted', sourceAborted); source.removeListener('close', sourceClosed);
        (complete ? Promise.resolve() : writer.stop()).then(() => callback(error), () => callback(error));
      },
    });
    response.headers = { ...source.headers }; response.statusCode = source.statusCode;
    const sourceError = error => response.destroy(error);
    const sourceAborted = () => response.destroy(new Error('Upstream response aborted'));
    const sourceClosed = () => { if (!source.readableEnded) sourceAborted(); };
    const abort = () => response.destroy(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    source.on('error', sourceError); source.on('aborted', sourceAborted); source.on('close', sourceClosed);
    source.removeListener('error', preparationFailure);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else source.pipe(response);
    return { ...upstream, response };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); await this.ready;
    await this.locked(async () => { for (const writer of [...this.reservations.values()]) await writer.stop(); });
  }
}
