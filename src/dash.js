export function segmentRange(value) {
  if (typeof value !== 'string' || !/^\d+-\d+$/.test(value)) throw new Error('DASH 字节索引无效');
  const [start, end] = value.split('-').map(Number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) throw new Error('DASH 字节索引无效');
  return `${start}-${end}`;
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

export function buildDashManifest(dash, trackUrl, { discoverRanges = false } = {}) {
  const adaptations = ['video', 'audio'].map(type => {
    const representations = dash.tracks.map((track, index) => {
      if (track.type !== type) return '';
      const local = trackUrl(track, index);
      const dimensions = type === 'video' ? ` width="${track.width}" height="${track.height}"${track.frameRate ? ` frameRate="${xml(track.frameRate)}"` : ''}` : '';
      const segment = discoverRanges ? '<SegmentBase/>' : `<SegmentBase indexRange="${segmentRange(track.indexRange)}" indexRangeExact="true"><Initialization range="${segmentRange(track.initialization)}"/></SegmentBase>`;
      return `<Representation id="${xml(track.id)}" bandwidth="${track.bandwidth}" codecs="${xml(track.codecs)}"${dimensions}><BaseURL>${xml(local)}</BaseURL>${segment}</Representation>`;
    }).join('');
    if (!representations) throw new Error('DASH 缺少音视频轨道');
    return `<AdaptationSet contentType="${type}" mimeType="${type}/mp4" segmentAlignment="true" startWithSAP="1">${representations}</AdaptationSet>`;
  }).join('');
  const duration = Number(dash.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400) throw new Error('DASH 视频时长无效');
  return `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT1.5S" mediaPresentationDuration="PT${duration}S"><Period start="PT0S">${adaptations}</Period></MPD>`;
}
