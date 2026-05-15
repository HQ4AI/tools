(function () {
  // 幂等:再次点击插件图标(或按快捷键)→ 切换面板显隐
  if (window.__HDGRAB_LOADED__) {
    const p = document.getElementById('__hdgrab_panel__');
    if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    return;
  }
  window.__HDGRAB_LOADED__ = true;

  let minDim = Number(localStorage.getItem('__hdgrab_minw') || 500);
  let sortMode = localStorage.getItem('__hdgrab_sort') || 'time-desc';
  const items = new Map(); // key -> { url, thumb, w, h, ts, area }
  const videoItems = new Map(); // key -> { url, w, h, ts, area, srcEl }
  let panel, imageTab, videoTab, styleTab, list, videoList, countEl, widthInput, sortSelect, stylePreview, styleOutput, styleStatus, styleRunBtn, styleCopyBtn;
  let granularityOne, granularityTwo;
  let pastedStyleImage = null;
  let styleGranularity = Number(localStorage.getItem('__hdgrab_style_granularity') || 1) === 2 ? 2 : 1;
  let activeTab = 'image';
  let seq = 0;

  // —— URL 规整:只做"安全动作",不改会让签名失效的路径 ——
  function normalize(url) {
    try {
      const u = new URL(url, location.href);
      if (/xhscdn\.com/.test(u.hostname)) {
        u.hostname = u.hostname.replace(/^sns-webpic(-qc)?/, 'sns-img-qc');
      }
      ['x-oss-process', 'imageView2', 'imageMogr2', 'imageslim', 'imageView', 'imageMogr',
        'x-image-process'].forEach(k => u.searchParams.delete(k));
      return u.toString();
    } catch {
      return url;
    }
  }

  function guessExt(url, fallback) {
    const m = String(url).match(/\.(jpe?g|png|webp|gif|avif|heic|mp4|webm|mov|m4v)(?:\?|#|$)/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    return fallback || 'jpg';
  }

  function filenameFor(url, fallbackExt) {
    try {
      const last = (new URL(url).pathname.split('/').pop() || 'img').split('~')[0];
      const base = (last.replace(/\.[^.]+$/, '') || 'img').slice(0, 40);
      return base + '.' + guessExt(url, fallbackExt);
    } catch {
      return 'media_' + Date.now() + '.' + guessExt(url, fallbackExt);
    }
  }

  // —— 采集 ——
  function tryAdd(img) {
    const raw = img.currentSrc || img.src;
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) {
      img.addEventListener('load', () => tryAdd(img), { once: true });
      return;
    }
    if (w < minDim && h < minDim) return;
    const key = normalize(raw);
    if (items.has(key)) return;
    items.set(key, { url: key, thumb: raw, w, h, ts: ++seq, area: w * h, srcEl: img });
    scheduleRender();
  }

  // 扫 CSS background-image 拿到的 URL,异步探测尺寸后再入 items
  function tryAddByUrl(rawUrl) {
    if (!rawUrl) return;
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return;
    if (!/^https?:/i.test(rawUrl)) return;
    const key = normalize(rawUrl);
    if (items.has(key)) return;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => {
      const w = probe.naturalWidth, h = probe.naturalHeight;
      if (!w || !h) return;
      if (w < minDim && h < minDim) return;
      if (items.has(key)) return;
      items.set(key, { url: key, thumb: rawUrl, w, h, ts: ++seq, area: w * h, srcEl: probe });
      scheduleRender();
    };
    probe.onerror = () => {};
    probe.src = rawUrl;
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|mov|m4v)(?:[?#/]|$)/i.test(String(url));
  }

  function decodeMaybeEscapedUrl(value) {
    if (!value) return '';
    let text = String(value).trim();
    text = text
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/\\u0025/g, '%')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
    try {
      text = decodeURIComponent(text);
    } catch {}
    return text;
  }

  function addVideoCandidate(rawUrl, srcEl) {
    tryAddVideoUrl(rawUrl, srcEl || null);
  }

  function normalizeVideoCandidate(rawUrl) {
    const decoded = decodeMaybeEscapedUrl(rawUrl);
    if (!decoded || !isVideoUrl(decoded)) return null;
    try {
      const u = new URL(decoded, location.href);
      if (!/^https?:$/i.test(u.protocol)) return null;
      const wasByteRange = u.searchParams.has('bytestart') || u.searchParams.has('byteend');
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
      return { url: u.toString(), wasByteRange };
    } catch {
      return null;
    }
  }

  function parseInstagramVideoInfo(url) {
    try {
      const u = new URL(url);
      const raw = u.searchParams.get('efg');
      if (!raw) return {};
      const json = JSON.parse(atob(decodeURIComponent(raw)));
      return {
        assetId: json.xpv_asset_id || json.video_id || '',
        bitrate: Number(json.bitrate || 0),
        duration: Number(json.duration_s || 0),
        tag: json.vencode_tag || '',
      };
    } catch {
      return {};
    }
  }

  function videoIdentity(url, info) {
    if (info && info.assetId) return 'ig:' + info.assetId;
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  function videoScore(item) {
    return (item.area || 0) + (item.bitrate || 0) + (item.transferSize || 0) + (item.wasByteRange ? 1 : 0);
  }

  function tryAddVideoUrl(rawUrl, srcEl) {
    const normalized = normalizeVideoCandidate(rawUrl);
    if (!normalized) return;
    const key = normalize(normalized.url);
    const w = srcEl ? (srcEl.videoWidth || srcEl.clientWidth || 0) : 0;
    const h = srcEl ? (srcEl.videoHeight || srcEl.clientHeight || 0) : 0;
    if (w && h && w < minDim && h < minDim) return;
    const info = parseInstagramVideoInfo(key);
    const identity = videoIdentity(key, info);
    const next = {
      url: key,
      w,
      h,
      ts: ++seq,
      area: w * h,
      srcEl,
      identity,
      wasByteRange: normalized.wasByteRange,
      bitrate: info.bitrate || 0,
      duration: info.duration || 0,
      tag: info.tag || '',
      transferSize: 0,
    };
    for (const [existingKey, existing] of videoItems.entries()) {
      if (existing.identity !== identity) continue;
      if (videoScore(existing) >= videoScore(next)) return;
      videoItems.delete(existingKey);
      break;
    }
    videoItems.set(key, next);
    scheduleRender();
  }

  function tryAddVideo(video) {
    const raw = video.currentSrc || video.src || (video.querySelector('source[src]') && video.querySelector('source[src]').src);
    if (raw) tryAddVideoUrl(raw, video);
    if (!video.videoWidth || !video.videoHeight) {
      video.addEventListener('loadedmetadata', () => {
        const key = normalize(video.currentSrc || video.src || raw || '');
        const item = videoItems.get(key);
        if (item) {
          item.w = video.videoWidth || item.w || 0;
          item.h = video.videoHeight || item.h || 0;
          item.area = item.w * item.h;
          scheduleRender();
        } else {
          tryAddVideo(video);
        }
      }, { once: true });
    }
    video.querySelectorAll('source[src]').forEach((source) => tryAddVideoUrl(source.src, video));
  }

  function visibleVideoElements() {
    return [...document.querySelectorAll('video')].filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
    }).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
  }

  function attachVisibleVideoThumbs() {
    const videos = visibleVideoElements();
    if (!videos.length || !videoItems.size) return;
    const primary = videos[0];
    for (const item of videoItems.values()) {
      if (!item.srcEl || !item.srcEl.isConnected) item.srcEl = primary;
      if (!item.w || !item.h) {
        item.w = primary.videoWidth || Math.round(primary.getBoundingClientRect().width) || item.w || 0;
        item.h = primary.videoHeight || Math.round(primary.getBoundingClientRect().height) || item.h || 0;
        item.area = item.w * item.h;
      }
    }
  }

  function scanVideoLinks() {
    document.querySelectorAll('a[href], source[src]').forEach((el) => {
      const raw = el.href || el.src;
      addVideoCandidate(raw, null);
    });
  }

  function scanVideoMeta() {
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').forEach((meta) => {
      addVideoCandidate(meta.content, null);
    });
  }

  function scanVideoAttributes() {
    const attrs = ['src', 'href', 'data-src', 'data-video-url', 'data-video-src', 'data-url'];
    document.querySelectorAll('*').forEach((el) => {
      for (const attr of attrs) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value) addVideoCandidate(value, null);
      }
    });
  }

  function scanPerformanceVideos() {
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        const name = entry && entry.name;
        if (!name) return;
        if (entry.initiatorType === 'video' || entry.initiatorType === 'media' || isVideoUrl(name)) {
          const before = videoItems.size;
          addVideoCandidate(name, null);
          if (videoItems.size !== before) {
            const normalized = normalizeVideoCandidate(name);
            const item = normalized && videoItems.get(normalize(normalized.url));
            if (item) item.transferSize = Number(entry.transferSize || entry.encodedBodySize || 0);
          }
        }
      });
    } catch {}
  }

  function scanScriptVideos() {
    const urlRe = /https?:\\?\/\\?\/[^"'<>\s]+/g;
    document.querySelectorAll('script').forEach((script) => {
      const text = script.textContent || '';
      if (!text || !/mp4|webm|video_url|playback_url/i.test(text)) return;
      let m;
      while ((m = urlRe.exec(text)) !== null) {
        addVideoCandidate(m[0], null);
      }
    });
  }

  function scanVideoSources(deep = false) {
    document.querySelectorAll('video').forEach(tryAddVideo);
    scanVideoLinks();
    scanVideoMeta();
    scanPerformanceVideos();
    if (deep) {
      scanVideoAttributes();
      scanScriptVideos();
    }
    attachVisibleVideoThumbs();
  }

  function extractBgUrls(bg, sink) {
    if (!bg || bg === 'none') return;
    const re = /url\(["']?([^"')]+)["']?\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) sink(m[1]);
  }

  let scanTimer = null;
  function scanAll(deep = false) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      // <img>
      document.querySelectorAll('img').forEach(tryAdd);
      scanVideoSources(deep);
      // inline style 上的 background-image(快,覆盖大多数 lightbox)
      document.querySelectorAll('[style*="background"]').forEach((el) => {
        extractBgUrls(el.style.backgroundImage, tryAddByUrl);
      });
      // 深扫:computed style 上的 background-image(慢,仅在"重扫"时启用)
      if (deep) {
        const all = document.body.querySelectorAll('*');
        for (const el of all) {
          try { extractBgUrls(getComputedStyle(el).backgroundImage, tryAddByUrl); } catch {}
        }
      }
    }, 300);
  }

  const obs = new MutationObserver((muts) => {
    let needScan = false;
    for (const m of muts) {
      if (m.type === 'attributes') { needScan = true; break; }
      for (const n of m.addedNodes) {
        if (n && n.nodeType === 1) {
          if (n.tagName === 'IMG') tryAdd(n);
          else if (n.tagName === 'VIDEO') tryAddVideo(n);
          else if (n.querySelectorAll) {
            n.querySelectorAll('img').forEach(tryAdd);
            n.querySelectorAll('video').forEach(tryAddVideo);
            n.querySelectorAll('a[href], source[src]').forEach((el) => {
              const raw = el.href || el.src;
              addVideoCandidate(raw, null);
            });
          }
          // 节点自身带 inline bg
          if (n.style && n.style.backgroundImage) {
            extractBgUrls(n.style.backgroundImage, tryAddByUrl);
          }
        }
      }
    }
    if (needScan) scanAll();
  });

  // —— 按钮视觉反馈辅助 ——
  // 点击后短暂变色 + 变文案,给用户"点到了"的明确回执
  function flashBtn(btn, text, bg, ms) {
    if (!btn) return;
    const origText = btn.textContent;
    const origBg = btn.style.background;
    btn.textContent = text;
    btn.style.background = bg;
    setTimeout(() => {
      btn.textContent = origText;
      btn.style.background = origBg;
    }, ms || 1100);
  }

  // —— 下载 ——
  function download(url, btn, fallbackExt) {
    chrome.runtime.sendMessage({ action: 'download', url, filename: filenameFor(url, fallbackExt) });
    if (btn) flashBtn(btn, '✓ 已发起', '#27ae60', 1000);
  }
  function downloadAll(btn) {
    const list = getSorted();
    if (btn) flashBtn(btn, `发起 ${list.length} 张`, '#27ae60', 1400);
    list.forEach((v, i) => setTimeout(() => download(v.url), i * 250));
  }
  function downloadAllVideos(btn) {
    const videos = getSorted(videoItems);
    if (btn) flashBtn(btn, `发起 ${videos.length} 条`, '#27ae60', 1400);
    videos.forEach((v, i) => setTimeout(() => download(v.url, null, 'mp4'), i * 250));
  }

  // —— 复制到剪贴板 ——
  // 关键:navigator.clipboard.write 必须在点击事件的 sync stack 内调用
  // 才能保留 transient user activation。传入 Promise<Blob> 作为值,
  // 浏览器会等待 promise 解析,同时保持"用户手势"有效。
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });
  }

  async function buildPngFromUrl(url) {
    // 通过 background 发起 fetch(绕开页面 CORS 限制)
    const resp = await chrome.runtime.sendMessage({ action: 'fetch-image', url });
    if (!resp || resp.error) throw new Error(resp && resp.error ? resp.error : 'no response');
    // resp.dataUrl 形如 data:image/xxx;base64,...,是 same-origin data URL,canvas 不会被污染
    const img = await loadImage(resp.dataUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((r, j) =>
      c.toBlob((b) => (b ? r(b) : j(new Error('toBlob null'))), 'image/png')
    );
  }

  function copyImage(url, btn) {
    const origText = btn.textContent;
    const origBg = btn.style.background;
    btn.disabled = true;
    btn.textContent = '…';
    btn.classList.add('__hdgrab_busy');

    // 必须同步调用 clipboard.write,Promise 内部再异步拿图
    navigator.clipboard.write([
      new ClipboardItem({ 'image/png': buildPngFromUrl(url) }),
    ]).then(() => {
      btn.classList.remove('__hdgrab_busy');
      btn.textContent = '✓ 已复制';
      btn.style.background = '#27ae60';
    }).catch(async (e) => {
      console.log('[hdgrab] copy image fallback -> URL text:', (e && e.message) || e);
      btn.classList.remove('__hdgrab_busy');
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = '✗ 只复制URL';
        btn.style.background = '#c0392b';
      } catch {
        btn.textContent = '✗ 失败';
        btn.style.background = '#c0392b';
      }
    }).finally(() => {
      setTimeout(() => {
        btn.textContent = origText;
        btn.style.background = origBg;
        btn.disabled = false;
      }, 1400);
    });
  }

  // —— shadow-lantern 风格反解 ——
  function fallbackShadowMarkdown(error, endpoint) {
    const note = endpoint
      ? `本地 shadow-lantern 桥接服务暂不可用：${endpoint} (${error || 'unknown error'})`
      : `shadow-lantern 调用失败：${error || 'unknown error'}`;
    return `## 视觉风格总结\n\n> ${note}\n>\n> 请把当前粘贴的图片交给 Codex，并使用 shadow-lantern skill 按以下结构反解。\n\n### 整体气质\n待 shadow-lantern 根据图片提取。\n\n### 色彩特征\n待 shadow-lantern 根据图片提取。\n\n### 光线特征\n待 shadow-lantern 根据图片提取。\n\n### 影调与对比\n待 shadow-lantern 根据图片提取。\n\n### 背景与空间\n待 shadow-lantern 根据图片提取。\n\n### 质感特征\n待 shadow-lantern 根据图片提取。\n\n### 构图语言\n待 shadow-lantern 根据图片提取。\n\n### 可复用风格提示词\n请生成一段可迁移到任意主体的自然语言风格提示词，并避免复述原图主体。`;
  }

  function setStyleStatus(text, tone) {
    if (!styleStatus) return;
    styleStatus.textContent = text || '';
    const colors = { ok: '#5bd38c', warn: '#f1c40f', err: '#ff7675', idle: '#999' };
    styleStatus.style.color = colors[tone || 'idle'] || colors.idle;
  }

  function setStyleGranularity(value) {
    styleGranularity = Number(value) === 2 ? 2 : 1;
    localStorage.setItem('__hdgrab_style_granularity', String(styleGranularity));
    if (granularityOne) granularityOne.checked = styleGranularity === 1;
    if (granularityTwo) granularityTwo.checked = styleGranularity === 2;
  }

  async function shrinkStyleImage(dataUrl) {
    const img = await loadImage(dataUrl);
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    if (scale >= 1 && dataUrl.length < 2_500_000) return dataUrl;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }

  async function showStyleImage(dataUrl) {
    if (stylePreview) {
      stylePreview.innerHTML = '';
      const img = document.createElement('img');
      img.src = dataUrl;
      img.style.cssText = 'max-width:100%;max-height:180px;object-fit:contain;border-radius:6px;display:block;margin:auto;background:#111;';
      stylePreview.appendChild(img);
    }
    setStyleStatus('正在准备图片…', 'idle');
    try {
      pastedStyleImage = await shrinkStyleImage(dataUrl);
      if (styleRunBtn) styleRunBtn.disabled = false;
      setStyleStatus('已粘贴图片，可以反解。', 'ok');
    } catch (e) {
      pastedStyleImage = dataUrl;
      if (styleRunBtn) styleRunBtn.disabled = false;
      setStyleStatus('图片压缩失败，将尝试发送原图。', 'warn');
    }
  }

  function handleStylePaste(e) {
    const files = [];
    if (e.clipboardData) {
      for (const item of e.clipboardData.items || []) {
        if (item.kind === 'file' && /^image\//.test(item.type)) files.push(item.getAsFile());
      }
    }
    const file = files.find(Boolean);
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => showStyleImage(reader.result);
    reader.onerror = () => setStyleStatus('读取剪贴板图片失败。', 'err');
    reader.readAsDataURL(file);
  }

  function runShadowLantern(btn) {
    if (!pastedStyleImage) {
      setStyleStatus('先在这个区域粘贴一张图片。', 'warn');
      return;
    }
    if (btn) btn.disabled = true;
    setStyleStatus('正在调用 shadow-lantern…', 'idle');
    chrome.runtime.sendMessage({
      action: 'shadow-lantern',
      imageDataUrl: pastedStyleImage,
      granularity: styleGranularity,
    }, (resp) => {
      if (btn) btn.disabled = false;
      if (chrome.runtime.lastError) {
        const md = fallbackShadowMarkdown(chrome.runtime.lastError.message);
        if (styleOutput) styleOutput.value = md;
        setStyleStatus('调用失败，已生成可复制的 fallback 请求。', 'err');
        return;
      }
      if (resp && resp.markdown) {
        if (styleOutput) styleOutput.value = resp.markdown;
        setStyleStatus('已生成 Markdown 提示词。', 'ok');
        return;
      }
      const md = fallbackShadowMarkdown(resp && resp.error, resp && resp.endpoint);
      if (styleOutput) styleOutput.value = md;
      setStyleStatus('本地桥接未响应，已生成 fallback 请求。', 'warn');
    });
  }

  async function copyStyleMarkdown(btn) {
    const text = styleOutput && styleOutput.value;
    if (!text) {
      setStyleStatus('还没有可复制的 Markdown。', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (btn) flashBtn(btn, '✓ 已复制', '#27ae60', 1000);
      setStyleStatus('Markdown 已复制。', 'ok');
    } catch (e) {
      setStyleStatus('复制失败，请手动选中文本。', 'err');
    }
  }

  // —— 排序 & 渲染 ——
  function cmp(a, b) {
    switch (sortMode) {
      case 'time-asc':  return a.ts - b.ts;
      case 'size-desc': return b.area - a.area || b.ts - a.ts;
      case 'size-asc':  return a.area - b.area || a.ts - b.ts;
      case 'time-desc':
      default:          return b.ts - a.ts;
    }
  }
  function getSorted(source) {
    return [...(source || items).values()].sort(cmp);
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = requestAnimationFrame(() => {
      renderTimer = null;
      renderList();
      renderVideoList();
      updateCount();
    });
  }

  // 从页面已有的 <img> 元素 drawImage 到 canvas,不发起网络请求。
  // 原图还没加载完时也能显示当前已渲染部分;load 后再刷一次,拿清晰版本。
  function buildThumbCanvas(srcEl) {
    const box = 72;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${box}px;height:${box}px;border-radius:4px;flex-shrink:0;background:#222;display:block;`;
    canvas.width = Math.round(box * dpr);
    canvas.height = Math.round(box * dpr);
    const ctx = canvas.getContext('2d');

    function paint() {
      try {
        const w = srcEl.naturalWidth || 0;
        const h = srcEl.naturalHeight || 0;
        if (!w || !h) return;
        // object-fit: cover 效果:居中裁成方形
        let sx, sy, s;
        if (w > h) { s = h; sx = (w - h) / 2; sy = 0; }
        else       { s = w; sx = 0;           sy = (h - w) / 2; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(srcEl, sx, sy, s, s, 0, 0, canvas.width, canvas.height);
      } catch (e) {
        // drawImage 基本不会抛(和 CORS 无关),这里只是兜底
      }
    }

    if (srcEl.complete && srcEl.naturalWidth) {
      paint();
    } else {
      // loading 占位
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#555'; ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('loading', canvas.width / 2, canvas.height / 2);
      srcEl.addEventListener('load', paint, { once: true });
    }
    return canvas;
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:12px;';

    // 优先从页面原 img 元素 drawImage 到 canvas(不走网络);元素已销毁则 fallback 到 <img> 加载
    let thumb;
    if (item.srcEl && item.srcEl.isConnected) {
      thumb = buildThumbCanvas(item.srcEl);
    } else {
      thumb = document.createElement('img');
      thumb.src = item.thumb;
      thumb.referrerPolicy = 'no-referrer';
      thumb.loading = 'lazy';
      thumb.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#222;';
      thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0;';
    const size = document.createElement('div');
    size.textContent = `${item.w} × ${item.h}`;
    size.style.cssText = 'color:#eee;font-size:13px;font-weight:600;margin-bottom:3px;';
    const urlEl = document.createElement('div');
    urlEl.textContent = item.url;
    urlEl.style.cssText = 'color:#888;font-size:10px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;';
    urlEl.title = '点击在新标签页打开原图 · ' + item.url;
    urlEl.onclick = () => window.open(item.url, '_blank');
    meta.append(size, urlEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';
    const btnCss = 'color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;min-width:66px;transition:background 0.15s;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.style.cssText = btnCss + 'background:#3498db;';
    copyBtn.onclick = () => copyImage(item.url, copyBtn);

    const dlBtn = document.createElement('button');
    dlBtn.textContent = '下载';
    dlBtn.style.cssText = btnCss + 'background:#6c5ce7;';
    dlBtn.onclick = () => download(item.url, dlBtn);

    actions.append(copyBtn, dlBtn);
    row.append(thumb, meta, actions);
    return row;
  }

  function buildVideoThumbCanvas(video) {
    const box = 72;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${box}px;height:${box}px;border-radius:4px;flex-shrink:0;background:#222;display:block;`;
    canvas.width = Math.round(box * dpr);
    canvas.height = Math.round(box * dpr);
    const ctx = canvas.getContext('2d');

    function paint() {
      try {
        const w = video.videoWidth || video.clientWidth || 0;
        const h = video.videoHeight || video.clientHeight || 0;
        if (!w || !h) return false;
        let sx, sy, s;
        if (w > h) { s = h; sx = (w - h) / 2; sy = 0; }
        else       { s = w; sx = 0;           sy = (h - w) / 2; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, sx, sy, s, s, 0, 0, canvas.width, canvas.height);
        return true;
      } catch {
        return false;
      }
    }

    if (!paint()) {
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#777'; ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VIDEO', canvas.width / 2, canvas.height / 2);
      video.addEventListener('loadeddata', paint, { once: true });
      video.addEventListener('timeupdate', paint, { once: true });
    }
    return canvas;
  }

  function buildVideoRow(item) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:12px;';

    let thumb;
    if (item.srcEl && item.srcEl.isConnected && (item.srcEl.videoWidth || item.srcEl.readyState >= 2)) {
      thumb = buildVideoThumbCanvas(item.srcEl);
    } else if (item.srcEl && item.srcEl.isConnected && item.srcEl.poster) {
      thumb = document.createElement('img');
      thumb.src = item.srcEl.poster;
      thumb.referrerPolicy = 'no-referrer';
      thumb.loading = 'lazy';
      thumb.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#222;';
      thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
    } else {
      thumb = document.createElement('div');
      thumb.textContent = 'VIDEO';
      thumb.style.cssText = 'width:72px;height:72px;border-radius:4px;flex-shrink:0;background:#222;color:#777;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;letter-spacing:0;';
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0;';
    const size = document.createElement('div');
    size.textContent = item.w && item.h ? `${item.w} × ${item.h}` : '视频';
    size.style.cssText = 'color:#eee;font-size:13px;font-weight:600;margin-bottom:3px;';
    const urlEl = document.createElement('div');
    urlEl.textContent = item.url;
    urlEl.style.cssText = 'color:#888;font-size:10px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;';
    urlEl.title = '点击在新标签页打开视频 · ' + item.url;
    urlEl.onclick = () => window.open(item.url, '_blank');
    meta.append(size, urlEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';
    const dlBtn = document.createElement('button');
    dlBtn.textContent = '下载';
    dlBtn.style.cssText = 'color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;min-width:66px;transition:background 0.15s;background:#6c5ce7;';
    dlBtn.onclick = () => download(item.url, dlBtn, 'mp4');

    actions.append(dlBtn);
    row.append(thumb, meta, actions);
    return row;
  }

  function renderList() {
    if (!list) return;
    const arr = getSorted();
    list.innerHTML = '';
    if (arr.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:28px 18px;color:#888;font-size:12px;line-height:1.8;text-align:center;';
      empty.innerHTML =
        `暂未扫到 ≥ <b style="color:#ccc">${minDim}px</b> 的图<br>` +
        `<span style="font-size:11px">` +
        `· 试试把上面的「最小尺寸」调低,比如 500<br>` +
        `· 让目标图滑入视口后再点「重扫」<br>` +
        `· 有些全屏浏览器浮层用 CSS 背景图,会略慢` +
        `</span>`;
      list.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      arr.forEach((it) => frag.appendChild(buildRow(it)));
      list.appendChild(frag);
    }
    updateCount();
  }

  function renderVideoList() {
    if (!videoList) return;
    const arr = getSorted(videoItems);
    videoList.innerHTML = '';
    if (arr.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:28px 18px;color:#888;font-size:12px;line-height:1.8;text-align:center;';
      empty.innerHTML =
        `暂未扫到网页视频<br>` +
        `<span style="font-size:11px">` +
        `· 支持 video/source、meta、资源列表和 mp4/webm/mov/m4v 直链<br>` +
        `· 让目标视频加载后再点「重扫」<br>` +
        `· Instagram byte-range 分片会先规整成完整候选` +
        `</span>`;
      videoList.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      arr.forEach((it) => frag.appendChild(buildVideoRow(it)));
      videoList.appendChild(frag);
    }
    updateCount();
  }

  function updateCount() {
    if (!countEl) return;
    countEl.textContent = activeTab === 'video' ? videoItems.size : items.size;
  }

  function rebuild() {
    items.clear();
    videoItems.clear();
    seq = 0;
    updateCount();
    if (list) list.innerHTML = '';
    if (videoList) videoList.innerHTML = '';
    scheduleRender();   // 先画空状态提示
    scanAll(true);      // 深扫 computed style 的 background-image
  }

  // —— 面板 ——
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = '__hdgrab_panel__';
    panel.style.cssText = `
      position:fixed;bottom:20px;right:20px;width:480px;max-height:72vh;
      background:#171717;color:#eee;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:2147483647;
      font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      display:flex;flex-direction:column;border:1px solid #333;`;

    // 注入按钮交互样式(hover / active / disabled / 处理中脉冲)
    if (!document.getElementById('__hdgrab_style__')) {
      const style = document.createElement('style');
      style.id = '__hdgrab_style__';
      style.textContent = `
        #__hdgrab_panel__ button {
          transition: transform 0.08s ease, filter 0.15s ease, background-color 0.2s ease;
        }
        #__hdgrab_panel__ button:hover:not(:disabled) { filter: brightness(1.18); }
        #__hdgrab_panel__ button:active:not(:disabled) { transform: scale(0.93); filter: brightness(0.78); }
        #__hdgrab_panel__ button:disabled { opacity: 0.6; cursor: wait; }
        @keyframes __hdgrab_pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        #__hdgrab_panel__ button.__hdgrab_busy { animation: __hdgrab_pulse 0.7s ease-in-out infinite; }
      `;
      document.head.appendChild(style);
    }

    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 12px;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:8px;cursor:move;user-select:none;background:#1f1f1f;border-radius:10px 10px 0 0;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px;font-weight:600;flex:1';
    title.innerHTML = `👁 感官刺客 <span id="__hdgrab_count" style="background:#6c5ce7;padding:1px 8px;border-radius:10px;margin-left:6px;font-size:11px;font-weight:400">0</span> <span style="color:#666;font-size:10px;font-weight:400;margin-left:4px">⌥⇧G</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:#eee;cursor:pointer;font-size:20px;padding:0 6px;line-height:1;';
    closeBtn.onclick = () => {
      panel.remove();
      obs.disconnect();
      window.__HDGRAB_LOADED__ = false;
    };
    header.append(title, closeBtn);

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;border-bottom:1px solid #2a2a2a;background:#181818;';
    const imageTabBtn = document.createElement('button');
    const videoTabBtn = document.createElement('button');
    const styleTabBtn = document.createElement('button');
    const tabCss = 'flex:1;background:#181818;color:#aaa;border:none;border-bottom:2px solid transparent;padding:9px 10px;cursor:pointer;font-size:12px;';
    imageTabBtn.textContent = '抓图';
    videoTabBtn.textContent = '抓视频';
    styleTabBtn.textContent = '风格反解';
    imageTabBtn.style.cssText = tabCss;
    videoTabBtn.style.cssText = tabCss;
    styleTabBtn.style.cssText = tabCss;
    tabs.append(imageTabBtn, videoTabBtn, styleTabBtn);

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'padding:8px 10px;border-bottom:1px solid #2a2a2a;display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

    const label = document.createElement('span');
    label.textContent = '最小尺寸';
    label.style.cssText = 'font-size:11px;color:#aaa;';
    widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.value = minDim;
    widthInput.min = '100';
    widthInput.max = '6000';
    widthInput.step = '100';
    widthInput.style.cssText = 'width:70px;background:#0f0f0f;border:1px solid #333;color:#ccc;padding:5px 6px;border-radius:4px;font-size:12px;outline:none;';
    widthInput.onchange = () => {
      minDim = Number(widthInput.value) || 500;
      if (videoWidthInput) videoWidthInput.value = minDim;
      localStorage.setItem('__hdgrab_minw', String(minDim));
      rebuild();
    };
    const px = document.createElement('span'); px.textContent = 'px'; px.style.cssText = 'font-size:11px;color:#888;';

    const sortLabel = document.createElement('span');
    sortLabel.textContent = '排序';
    sortLabel.style.cssText = 'font-size:11px;color:#aaa;margin-left:8px;';
    sortSelect = document.createElement('select');
    sortSelect.style.cssText = 'background:#0f0f0f;border:1px solid #333;color:#ccc;padding:5px 6px;border-radius:4px;font-size:12px;outline:none;cursor:pointer;';
    [
      ['time-desc', '最新加载'],
      ['time-asc',  '最早加载'],
      ['size-desc', '尺寸 大→小'],
      ['size-asc',  '尺寸 小→大'],
    ].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === sortMode) o.selected = true;
      sortSelect.appendChild(o);
    });
    sortSelect.onchange = () => {
      sortMode = sortSelect.value;
      if (videoSortSelect) videoSortSelect.value = sortMode;
      localStorage.setItem('__hdgrab_sort', sortMode);
      renderList();
      renderVideoList();
    };

    const rescan = document.createElement('button');
    rescan.textContent = '重扫';
    rescan.style.cssText = 'background:#444;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    rescan.onclick = () => { flashBtn(rescan, '深扫中…', '#555', 700); rebuild(); };
    const dlAll = document.createElement('button');
    dlAll.textContent = '全部下载';
    dlAll.style.cssText = 'background:#6c5ce7;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;margin-left:auto;';
    dlAll.onclick = () => downloadAll(dlAll);

    toolbar.append(label, widthInput, px, sortLabel, sortSelect, rescan, dlAll);

    list = document.createElement('div');
    list.style.cssText = 'overflow-y:auto;flex:1;';

    imageTab = document.createElement('div');
    imageTab.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1;';
    imageTab.append(toolbar, list);

    const videoToolbar = document.createElement('div');
    videoToolbar.style.cssText = 'padding:8px 10px;border-bottom:1px solid #2a2a2a;display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
    const videoLabel = document.createElement('span');
    videoLabel.textContent = '最小尺寸';
    videoLabel.style.cssText = 'font-size:11px;color:#aaa;';
    const videoWidthInput = document.createElement('input');
    videoWidthInput.type = 'number';
    videoWidthInput.value = minDim;
    videoWidthInput.min = '100';
    videoWidthInput.max = '6000';
    videoWidthInput.step = '100';
    videoWidthInput.style.cssText = 'width:70px;background:#0f0f0f;border:1px solid #333;color:#ccc;padding:5px 6px;border-radius:4px;font-size:12px;outline:none;';
    videoWidthInput.onchange = () => {
      minDim = Number(videoWidthInput.value) || 500;
      if (widthInput) widthInput.value = minDim;
      localStorage.setItem('__hdgrab_minw', String(minDim));
      rebuild();
    };
    const videoPx = document.createElement('span');
    videoPx.textContent = 'px';
    videoPx.style.cssText = 'font-size:11px;color:#888;';
    const videoSortLabel = document.createElement('span');
    videoSortLabel.textContent = '排序';
    videoSortLabel.style.cssText = 'font-size:11px;color:#aaa;margin-left:8px;';
    const videoSortSelect = document.createElement('select');
    videoSortSelect.style.cssText = 'background:#0f0f0f;border:1px solid #333;color:#ccc;padding:5px 6px;border-radius:4px;font-size:12px;outline:none;cursor:pointer;';
    [
      ['time-desc', '最新加载'],
      ['time-asc',  '最早加载'],
      ['size-desc', '尺寸 大→小'],
      ['size-asc',  '尺寸 小→大'],
    ].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === sortMode) o.selected = true;
      videoSortSelect.appendChild(o);
    });
    videoSortSelect.onchange = () => {
      sortMode = videoSortSelect.value;
      if (sortSelect) sortSelect.value = sortMode;
      localStorage.setItem('__hdgrab_sort', sortMode);
      renderList();
      renderVideoList();
    };
    const videoRescan = document.createElement('button');
    videoRescan.textContent = '重扫';
    videoRescan.style.cssText = 'background:#444;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    videoRescan.onclick = () => { flashBtn(videoRescan, '深扫中…', '#555', 700); rebuild(); };
    const videoDlAll = document.createElement('button');
    videoDlAll.textContent = '全部下载';
    videoDlAll.style.cssText = 'background:#6c5ce7;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;margin-left:auto;';
    videoDlAll.onclick = () => downloadAllVideos(videoDlAll);
    videoToolbar.append(videoLabel, videoWidthInput, videoPx, videoSortLabel, videoSortSelect, videoRescan, videoDlAll);

    videoList = document.createElement('div');
    videoList.style.cssText = 'overflow-y:auto;flex:1;';

    videoTab = document.createElement('div');
    videoTab.style.cssText = 'display:none;flex-direction:column;min-height:0;flex:1;';
    videoTab.append(videoToolbar, videoList);

    styleTab = document.createElement('div');
    styleTab.style.cssText = 'display:none;flex-direction:column;gap:10px;padding:12px;overflow-y:auto;flex:1;min-height:0;';
    styleTab.tabIndex = 0;
    styleTab.addEventListener('paste', handleStylePaste);

    stylePreview = document.createElement('div');
    stylePreview.style.cssText = 'height:190px;border:1px dashed #444;border-radius:8px;background:#101010;display:flex;align-items:center;justify-content:center;color:#777;font-size:12px;text-align:center;line-height:1.7;outline:none;';
    stylePreview.tabIndex = 0;
    stylePreview.innerHTML = '点击这里后按 ⌘V / Ctrl+V<br>粘贴一张参考图';
    stylePreview.addEventListener('paste', handleStylePaste);

    const granularityBox = document.createElement('div');
    granularityBox.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';

    function buildGranularityOption(value, titleText, detailText) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:8px;align-items:flex-start;background:#101010;border:1px solid #333;border-radius:6px;padding:8px 9px;cursor:pointer;user-select:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = styleGranularity === value;
      input.style.cssText = 'margin:2px 0 0;accent-color:#00a884;';
      input.onchange = () => setStyleGranularity(input.checked ? value : (value === 1 ? 2 : 1));
      const copy = document.createElement('span');
      copy.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
      const titleLine = document.createElement('span');
      titleLine.textContent = titleText;
      titleLine.style.cssText = 'color:#eee;font-size:12px;font-weight:600;line-height:1.25;';
      const detailLine = document.createElement('span');
      detailLine.textContent = detailText;
      detailLine.style.cssText = 'color:#888;font-size:10px;line-height:1.35;';
      copy.append(titleLine, detailLine);
      label.append(input, copy);
      return { label, input };
    }

    const g1 = buildGranularityOption(1, '颗粒度 1', '只抽可迁移风格');
    const g2 = buildGranularityOption(2, '颗粒度 2', '风格 + 画面内容');
    granularityOne = g1.input;
    granularityTwo = g2.input;
    granularityBox.append(g1.label, g2.label);

    const styleActions = document.createElement('div');
    styleActions.style.cssText = 'display:flex;gap:8px;align-items:center;';
    styleRunBtn = document.createElement('button');
    styleRunBtn.textContent = '反解 Markdown';
    styleRunBtn.disabled = true;
    styleRunBtn.style.cssText = 'background:#00a884;color:#fff;border:none;padding:7px 12px;border-radius:4px;cursor:pointer;font-size:12px;';
    styleRunBtn.onclick = () => runShadowLantern(styleRunBtn);
    styleCopyBtn = document.createElement('button');
    styleCopyBtn.textContent = '复制结果';
    styleCopyBtn.style.cssText = 'background:#444;color:#fff;border:none;padding:7px 12px;border-radius:4px;cursor:pointer;font-size:12px;';
    styleCopyBtn.onclick = () => copyStyleMarkdown(styleCopyBtn);
    styleStatus = document.createElement('span');
    styleStatus.textContent = '等待粘贴图片';
    styleStatus.style.cssText = 'font-size:11px;color:#999;margin-left:auto;';
    styleActions.append(styleRunBtn, styleCopyBtn, styleStatus);

    styleOutput = document.createElement('textarea');
    styleOutput.placeholder = 'shadow-lantern 生成的 Markdown 会出现在这里';
    styleOutput.style.cssText = 'min-height:230px;resize:vertical;background:#0f0f0f;border:1px solid #333;color:#ddd;border-radius:6px;padding:10px;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none;';

    styleTab.append(stylePreview, granularityBox, styleActions, styleOutput);
    setStyleGranularity(styleGranularity);

    function switchTab(name) {
      const styleActive = name === 'style';
      const imageActive = name === 'image';
      const videoActive = name === 'video';
      activeTab = name;
      imageTab.style.display = imageActive ? 'flex' : 'none';
      videoTab.style.display = videoActive ? 'flex' : 'none';
      styleTab.style.display = styleActive ? 'flex' : 'none';
      imageTabBtn.style.color = imageActive ? '#fff' : '#aaa';
      videoTabBtn.style.color = videoActive ? '#fff' : '#aaa';
      styleTabBtn.style.color = styleActive ? '#fff' : '#aaa';
      imageTabBtn.style.borderBottomColor = imageActive ? '#6c5ce7' : 'transparent';
      videoTabBtn.style.borderBottomColor = videoActive ? '#e17055' : 'transparent';
      styleTabBtn.style.borderBottomColor = styleActive ? '#00a884' : 'transparent';
      if (styleActive) setTimeout(() => stylePreview && stylePreview.focus(), 0);
      updateCount();
    }
    imageTabBtn.onclick = () => switchTab('image');
    videoTabBtn.onclick = () => switchTab('video');
    styleTabBtn.onclick = () => switchTab('style');

    panel.append(header, tabs, imageTab, videoTab, styleTab);
    document.body.appendChild(panel);
    countEl = panel.querySelector('#__hdgrab_count');
    switchTab('image');

    // 拖动
    let dx = 0, dy = 0, drag = false;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      drag = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - dx) + 'px';
      panel.style.top = Math.max(0, e.clientY - dy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 100);
    buildPanel();
    obs.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'href'],
    });
    scanAll();
  }
  boot();
})();
