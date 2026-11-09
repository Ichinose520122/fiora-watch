// Shared search and link picker. The media center supplies the download actions.
export function createDiscovery({ api, getState, select, download, downloadBatch, isDownloading, document: doc = document }) {
  const $ = id => doc.getElementById(id);
  let catalog;
  let selectedIndex = 0;
  let currentGroup = '';
  let catalogLoading = false;
  let selecting = false;
  let searchLoading = false;
  let searchQuery = '';
  let searchPage = 0;
  const selectedDownloads = new Set();
  const episodeGroup = episode => String(episode.groupId ?? episode.group ?? 'default');

  function report(text = '', error = false) {
    const status = $('source-notice');
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('error', error);
  }

  function run(task) {
    return Promise.resolve().then(task).catch(error => report(error.message, true));
  }

  function canDownload() {
    return Boolean(download && getState()?.user?.admin && catalog?.episodes?.length &&
      catalog.episodes.every(episode => {
        try { return !/(^|\.)bilibili\.com$|^b23\.tv$/.test(new URL(episode.url).hostname); }
        catch { return false; }
      }));
  }

  function refresh() {
    const state = getState();
    const canSelect = state?.canControl && !selecting;
    const downloading = Boolean(isDownloading?.());
    $('current-title').textContent = state?.media?.title || '未选择';
    $('load').disabled = !canSelect;
    $('clear').disabled = !canSelect || !state.media;
    $('inspect').disabled = catalogLoading;
    $('play-episode').disabled = !canSelect || catalogLoading || !catalog?.episodes?.[selectedIndex];
    $('download-episode').hidden = $('download-batch').hidden = $('batch-controls').hidden = !canDownload();
    $('download-episode').disabled = downloading || catalogLoading || !catalog?.episodes?.[selectedIndex];
    $('download-batch').disabled = downloading || catalogLoading || !selectedDownloads.size || selectedDownloads.size > 100;
    $('download-batch').textContent = downloading ? '加入队列中…' : `下载已选剧集${selectedDownloads.size ? `（${selectedDownloads.size}）` : ''}`;
    $('select-all-episodes').disabled = $('clear-episodes').disabled = downloading || catalogLoading;
    $('batch-count').textContent = `已选 ${selectedDownloads.size} 集 · 每批最多 100 集`;
  }

  function updateLinkOptions() {
    let hostname;
    try { hostname = new URL($('source').value.trim()).hostname.replace(/^(www\.|m\.|mobile\.)/, ''); } catch {}
    $('youtube-link-options').hidden = hostname !== 'youtube.com' && hostname !== 'youtu.be';
    $('youtube-link-delivery').value = '';
  }

  function setSource(url) {
    $('source').value = url;
    updateLinkOptions();
  }

  function renderCatalog() {
    const episodes = catalog?.episodes || [];
    const groups = new Map();
    for (const episode of episodes) {
      const id = episodeGroup(episode);
      if (!groups.has(id)) groups.set(id, { name: episode.group || '默认线路', count: 0 });
      groups.get(id).count++;
    }
    if (!groups.has(currentGroup)) currentGroup = episodeGroup(episodes[selectedIndex] || {});
    $('catalog-detail').hidden = !catalog;
    $('catalog-title').textContent = catalog?.title || '分集';
    $('catalog-description').textContent = catalog?.description || '';
    $('catalog-count').textContent = `${groups.get(currentGroup)?.count || 0} 集 · ${groups.size} 条线路`;
    $('catalog-group').replaceChildren(...Array.from(groups, ([id, group]) => {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = `${group.name}（${group.count} 集）`;
      option.selected = id === currentGroup;
      return option;
    }));
    const list = $('catalog-episodes');
    list.replaceChildren();
    const allowDownload = canDownload();
    episodes.forEach((episode, index) => {
      if (episodeGroup(episode) !== currentGroup) return;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = index === selectedIndex ? 'episode active' : 'episode';
      button.textContent = episode.title || `第 ${index + 1} 集`;
      button.setAttribute('aria-pressed', String(index === selectedIndex));
      button.onclick = () => { selectedIndex = index; renderCatalog(); };
      if (!allowDownload) { list.append(button); return; }
      const wrapper = doc.createElement('div');
      wrapper.className = 'episode-choice';
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedDownloads.has(index);
      checkbox.disabled = isDownloading();
      checkbox.setAttribute('aria-label', `下载 ${episode.group || ''} ${button.textContent}`);
      checkbox.onchange = () => {
        if (checkbox.checked) selectedDownloads.add(index);
        else selectedDownloads.delete(index);
        refresh();
      };
      wrapper.append(checkbox, button);
      list.append(wrapper);
    });
    const episode = episodes[selectedIndex];
    $('selected-episode').textContent = episode ? `当前：${[episode.group, episode.title].filter(Boolean).join(' · ')}` : '暂无可用分集';
    refresh();
  }

  function showCatalog(result) {
    catalog = result;
    selectedIndex = result?.episodeIndex || 0;
    currentGroup = '';
    selectedDownloads.clear();
    renderCatalog();
  }

  function showMedia(media) {
    showCatalog(media?.episodes?.length ? { ...media, title: media.seriesTitle || media.title } : null);
  }

  async function inspect(url) {
    if (catalogLoading) return;
    catalogLoading = true;
    $('inspect').textContent = '读取中…';
    report();
    showCatalog(null);
    try {
      const result = await api(`/api/catalog/episodes?url=${encodeURIComponent(url)}`);
      setSource(url);
      showCatalog(result);
      if (catalog.episodes?.length) $('catalog-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      else report('未找到分集，可以直接播放此地址。');
    } finally {
      catalogLoading = false;
      $('inspect').textContent = '读取分集';
      refresh();
    }
  }

  async function load(media, { updateCatalog = false } = {}) {
    if (selecting || !getState()?.canControl) return;
    selecting = true;
    refresh();
    report(media.mode === 'clear' ? '正在清空…' : '正在读取影片…');
    try {
      const result = await select(media);
      if (updateCatalog && result && !result.skipped) showMedia(getState()?.media);
      const success = media.mode === 'clear' ? '已清空' : '已加载到放映室';
      report(result?.warning || (result && !result.skipped ? success : ''), Boolean(result?.warning));
      return result;
    } catch (error) {
      report(error.message, true);
      throw error;
    } finally {
      selecting = false;
      refresh();
    }
  }

  function appendSearch(items) {
    for (const entry of items) {
      const card = doc.createElement('button');
      card.className = 'catalog-card';
      card.type = 'button';
      if (/^https?:\/\//.test(entry.cover || '')) {
        const cover = doc.createElement('img');
        cover.src = entry.cover;
        cover.alt = '';
        cover.loading = 'lazy';
        cover.referrerPolicy = 'no-referrer';
        cover.onerror = () => { cover.remove(); card.classList.add('no-cover'); };
        card.append(cover);
      } else card.classList.add('no-cover');
      const info = doc.createElement('div');
      info.className = 'catalog-info';
      const title = doc.createElement('strong');
      title.textContent = entry.title;
      const description = doc.createElement('small');
      description.textContent = entry.description || '查看剧集';
      info.append(title, description);
      card.append(info);
      card.onclick = () => run(() => inspect(entry.url));
      $('search-results').append(card);
    }
  }

  async function search(append = false) {
    const query = $('search').value.trim();
    if (searchLoading || !query) return;
    const continuing = append && query === searchQuery;
    const page = continuing ? searchPage + 1 : 1;
    searchLoading = true;
    report();
    $('search-button').disabled = $('more-results').disabled = true;
    $('search-button').textContent = '搜索中…';
    if (!continuing) { $('search-results').replaceChildren(); $('more-results').hidden = true; }
    try {
      const result = await api(`/api/catalog/search?q=${encodeURIComponent(query)}&page=${page}`);
      searchQuery = query;
      searchPage = result.page || page;
      appendSearch(result.items || []);
      $('more-results').hidden = !result.hasMore;
      if (!result.items?.length && !continuing) $('search-results').textContent = '没有找到相关影片';
    } finally {
      searchLoading = false;
      $('search-button').disabled = $('more-results').disabled = false;
      $('search-button').textContent = '搜索影片';
    }
  }

  $('source').oninput = updateLinkOptions;
  $('source-form').onsubmit = event => {
    event.preventDefault();
    if (!$('source').reportValidity()) return;
    const delivery = !$('youtube-link-options').hidden && $('youtube-link-delivery').value;
    run(() => load({ mode: 'online', url: $('source').value.trim(), ...(delivery && { youtubeDelivery: delivery }) }, { updateCatalog: true }));
  };
  $('inspect').onclick = () => { if ($('source').reportValidity()) run(() => inspect($('source').value.trim())); };
  $('search-form').onsubmit = event => { event.preventDefault(); run(() => search()); };
  $('more-results').onclick = () => run(() => search(true));
  $('clear').onclick = () => run(() => load({ mode: 'clear' }));
  $('play-episode').onclick = () => {
    const episode = catalog?.episodes?.[selectedIndex];
    if (episode) run(() => load({ mode: 'online', url: episode.url }));
  };
  $('catalog-group').onchange = () => {
    currentGroup = $('catalog-group').value;
    selectedIndex = catalog.episodes.findIndex(episode => episodeGroup(episode) === currentGroup);
    selectedDownloads.clear();
    renderCatalog();
  };
  if (download) {
    $('select-all-episodes').onclick = () => {
      selectedDownloads.clear();
      catalog.episodes.forEach((episode, index) => { if (episodeGroup(episode) === currentGroup) selectedDownloads.add(index); });
      renderCatalog();
      if (selectedDownloads.size > 100) report('此线路超过 100 集，请取消部分勾选后分批下载。', true);
    };
    $('clear-episodes').onclick = () => { selectedDownloads.clear(); renderCatalog(); };
    $('download-episode').onclick = () => run(() => download(catalog.episodes[selectedIndex].url));
    $('download-batch').onclick = () => run(async () => {
      if (!selectedDownloads.size || selectedDownloads.size > 100) return;
      const urls = [...selectedDownloads].sort((a, b) => a - b).map(index => catalog.episodes[index].url);
      await downloadBatch(urls);
      selectedDownloads.clear();
      renderCatalog();
    });
  }
  return { refresh, inspect, setSource, showMedia, openInvite: url => load({ mode: 'online', url, fromInvite: true }, { updateCatalog: true }) };
}
