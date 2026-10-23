import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'state.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { rooms: {}, jobs: [], usedTickets: {} };
    const delivery = (this.data.settings?.delivery ?? this.data.settings?.bilibiliDelivery) === 'proxy' ? 'proxy' : 'direct';
    this.data.settings = { ...this.data.settings, delivery, bilibiliDelivery: delivery };
    // Reconnecting after a restart never unexpectedly starts playback.
    for (const room of Object.values(this.data.rooms)) { room.paused = true; room.updatedAt = Date.now(); }
    for (const job of this.data.jobs) {
      if (['queued', 'running'].includes(job.status)) { job.status = 'failed'; job.error = '服务重启，请重新添加下载任务'; }
    }
    this.save();
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  consumeTicket(p) {
    const now = Date.now() / 1000;
    for (const [key, expiry] of Object.entries(this.data.usedTickets)) if (expiry <= now) delete this.data.usedTickets[key];
    if (this.data.usedTickets[p.jti]) throw new Error('登录票据已使用，请从 Fiora 重新进入');
    this.data.usedTickets[p.jti] = p.exp;
    this.save();
  }
  room(id) {
    if (!this.data.rooms[id]) {
      if (Object.keys(this.data.rooms).length >= 1000) throw new Error('影院房间数量已达上限');
      this.data.rooms[id] = { id, media: null, position: 0, paused: true, updatedAt: Date.now(), revision: 0 };
      this.save();
    }
    return this.data.rooms[id];
  }
}

export function position(room, now = Date.now()) {
  return room.position + (room.paused ? 0 : Math.max(0, now - room.updatedAt) / 1000);
}

export function control(room, input, now = Date.now()) {
  if (input.revision !== room.revision) throw new Error('播放状态已更新，请重试');
  if (!room.media) throw new Error('请先选择视频');
  if (!['play', 'pause', 'seek'].includes(input.action)) throw new Error('未知播放操作');
  const nextPosition = input.action === 'seek' ? input.position : position(room, now);
  if (!Number.isFinite(nextPosition) || nextPosition < 0 || nextPosition > 7 * 86400) throw new Error('无效播放进度');
  room.position = nextPosition;
  if (input.action !== 'seek') room.paused = input.action === 'pause';
  room.updatedAt = now;
  room.revision += 1;
}
