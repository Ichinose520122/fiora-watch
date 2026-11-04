export const CACHE_DEFAULTS = Object.freeze({
  bilibili: { enabled: true, maxGiB: 1, ttlHours: 6 },
  girigiri: { enabled: true, maxGiB: 2, ttlHours: 24 },
  online: { enabled: true, maxGiB: 2, ttlHours: 6 },
});

export function cacheSettings(value = {}) {
  return Object.fromEntries(Object.entries(CACHE_DEFAULTS).map(([provider, defaults]) => {
    const item = value?.[provider];
    return [provider, {
      enabled: typeof item?.enabled === 'boolean' ? item.enabled : defaults.enabled,
      maxGiB: Number.isFinite(item?.maxGiB) && item.maxGiB >= 0.1 && item.maxGiB <= 100 ? item.maxGiB : defaults.maxGiB,
      ttlHours: Number.isFinite(item?.ttlHours) && item.ttlHours >= 1 && item.ttlHours <= 168 ? item.ttlHours : defaults.ttlHours,
    }];
  }));
}

export function updateCacheSettings(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(CACHE_DEFAULTS, key))) throw new Error('缓存设置格式无效');
  const result = cacheSettings(current);
  for (const [provider, item] of Object.entries(input)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['enabled', 'maxGiB', 'ttlHours'].includes(key))) throw new Error('缓存设置格式无效');
    const merged = { ...result[provider], ...item };
    if (typeof merged.enabled !== 'boolean' || !Number.isFinite(merged.maxGiB) || merged.maxGiB < 0.1 || merged.maxGiB > 100 ||
        !Number.isFinite(merged.ttlHours) || merged.ttlHours < 1 || merged.ttlHours > 168) throw new Error('缓存容量须为 0.1–100 GiB，保留时间须为 1–168 小时');
    result[provider] = merged;
  }
  return result;
}

export function cachePolicies(settings) {
  return Object.fromEntries(Object.entries(cacheSettings(settings)).map(([provider, value]) => [provider,
    { enabled: value.enabled, maxBytes: Math.floor(value.maxGiB * 1024 ** 3), ttlMs: value.ttlHours * 3600000 }]));
}

export function cacheProvider(media) {
  if (media?.bilibili) return 'bilibili';
  try { if (/(^|\.)girigirilove\.com$/.test(new URL(media?.source).hostname)) return 'girigiri'; } catch {}
  return media?.youtubeDash || (['hls', 'mp4'].includes(media?.kind) && /^https?:\/\//i.test(media.url)) ? 'online' : null;
}
