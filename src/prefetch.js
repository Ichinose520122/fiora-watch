// Entries use the exact URL and HTTP Range that the player's next GET will use.
export function hlsSegments(text, base) {
  if (!text.includes('#EXT-X-ENDLIST') || text.includes('#EXT-X-STREAM-INF')) return [];
  const segments = [];
  let time = 0, duration = 0, bytes, lastEnd, lastUrl, urlLength = 0, gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-GAP') gap = true;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      bytes = /^(\d+)(?:@(\d+))?$/.exec(line.slice(17));
      if (!bytes) return [];
    } else if (line && !line.startsWith('#')) {
      if (!(duration > 0 && Number.isFinite(duration)) || segments.length >= 8192) return [];
      const url = new URL(line, base).href;
      urlLength += url.length;
      if (urlLength > 1024 * 1024) return [];
      let range = '';
      if (bytes) {
        const start = bytes[2] === undefined ? (lastUrl === url ? lastEnd + 1 : NaN) : Number(bytes[2]);
        lastEnd = start + Number(bytes[1]) - 1;
        if (!Number.isSafeInteger(lastEnd) || lastEnd < start) return [];
        range = 'bytes=' + start + '-' + lastEnd;
      } else lastEnd = undefined;
      if (!gap) segments.push({ time, url, range });
      gap = false;
      time += duration; duration = 0; lastUrl = url; bytes = undefined;
    }
  }
  return segments;
}

// dash.js requests either the exact sidx box or a prefix containing it.
// Skip hierarchical indexes and malformed offsets rather than guessing a range.
export function dashSegments(buffer, offset, url) {
  for (let box = 0; box + 8 <= buffer.length;) {
    const size = buffer.readUInt32BE(box);
    if (size < 8 || box + size > buffer.length) return [];
    if (buffer.toString('ascii', box + 4, box + 8) !== 'sidx') { box += size; continue; }
    const data = buffer.subarray(box, box + size);
    const wide = data[8] === 1;
    if (data[8] > 1 || size < (wide ? 40 : 32)) return [];
    const scale = data.readUInt32BE(16);
    let pos = wide ? 40 : 32;
    const count = data.readUInt16BE(pos - 2);
    let time = Number(wide ? data.readBigUInt64BE(20) : data.readUInt32BE(20)) / scale;
    let start = offset + box + size + Number(wide ? data.readBigUInt64BE(28) : data.readUInt32BE(24));
    if (!scale || count > 8192 || pos + count * 12 > size) return [];
    const segments = [];
    for (let i = 0; i < count; i++, pos += 12) {
      const length = data.readUInt32BE(pos), duration = data.readUInt32BE(pos + 4);
      if (!length || length >= 0x80000000 || !duration || !Number.isSafeInteger(start + length)) return [];
      segments.push({ time, url, range: 'bytes=' + start + '-' + (start + length - 1) });
      start += length; time += duration / scale;
    }
    return segments;
  }
  return [];
}

export function mp4Ahead(url, range, contentRange) {
  const received = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
  if (!received || range !== 'bytes=' + received[1] + '-' + received[2]) return [];
  const size = Number(received[2]) - Number(received[1]) + 1, total = Number(received[3]);
  if (!Number.isSafeInteger(total) || Number(received[2]) >= total || size < 32768 || size > 4 * 1024 * 1024) return [];
  const tasks = [];
  for (let start = Number(received[2]) + 1; start < total && tasks.length < 4; start += size) {
    tasks.push({ url, range: 'bytes=' + start + '-' + Math.min(total - 1, start + size - 1) });
  }
  return tasks;
}

export class RelayPrefetch {
  indexes = new Map();
  plans = new Map();
  constructor(busy) { this.busy = busy; }

  remember(media, lane, segments) {
    if (!segments.length) return;
    // Bound retained indexes for dormant rooms and superseded representations.
    for (const [key, index] of this.indexes) if (index.media === media && index.lane === lane) this.indexes.delete(key);
    if (this.indexes.size >= 24) this.indexes.delete(this.indexes.keys().next().value);
    const singleTrack = media.kind === 'dash';
    const offsets = new Map(segments.map((s, i) => [singleTrack ? s.range : JSON.stringify([s.url, s.range]), i]));
    this.indexes.set(offsets, { media, lane, segments, singleTrack });
  }

  ahead(media, url, range, position) {
    const key = JSON.stringify([url, range || '']);
    for (const [offsets, index] of this.indexes) {
      if (index.media !== media || (index.singleTrack && index.lane !== url)) continue;
      const i = offsets.get(index.singleTrack ? range : key);
      if (i === undefined) continue;
      const tasks = [];
      for (let n = i + 1; n < index.segments.length && tasks.length < 256; n++) {
        const segment = index.segments[n];
        if (segment.time >= position + 300) break;
        if (segment.time >= position) tasks.push(segment);
      }
      return { lane: index.lane, tasks };
    }
  }

  queue(room, lane, tasks, valid, warm) {
    if (this.closed || !tasks.length || !valid()) return;
    const key = JSON.stringify([room.id, lane]);
    if (this.plans.size >= 24 && !this.plans.has(key)) return;
    this.plans.set(key, { room, tasks, valid, warm });
    this.wake();
  }

  interrupt() { this.controller?.abort(); }
  cancel(room) {
    for (const [key, plan] of this.plans) if (!room || plan.room === room) this.plans.delete(key);
    if (!room || this.activeRoom === room) this.interrupt();
  }
  close() { this.closed = true; clearTimeout(this.timer); this.cancel(); this.indexes.clear(); }

  wake() {
    if (this.closed || this.timer || this.controller || this.busy() || !this.plans.size) return;
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, 150);
    this.timer.unref();
  }
  async run() {
    if (this.closed || this.busy()) return;
    const entry = this.plans.entries().next().value;
    if (!entry) return;
    const [key, plan] = entry;
    // Rotate after one segment so the audio track and other rooms get a turn.
    this.plans.delete(key);
    if (!plan.valid()) { this.wake(); return; }
    this.plans.set(key, plan);
    const controller = new AbortController();
    this.controller = controller; this.activeRoom = plan.room;
    try {
      const ok = await plan.warm(plan.tasks[0], AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      if (!controller.signal.aborted) {
        if (ok) plan.tasks.shift(); else plan.tasks.length = 0;
      }
    } catch { if (!controller.signal.aborted) plan.tasks.length = 0; }
    finally {
      if (this.plans.get(key) === plan && !plan.tasks.length) this.plans.delete(key);
      this.controller = null; this.activeRoom = null; this.wake();
    }
  }
}
