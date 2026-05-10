chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (e) {
    console.log('[hdgrab] executeScript skipped:', (e && e.message) || e);
  }
});

// 由 background 发起 fetch → 不受页面 CORS 约束,
// 然后把图以 data URL 形式返给 content script,由它绘制到 canvas 再写入剪贴板。
async function fetchAsDataUrl(url) {
  // referrerPolicy: 'no-referrer' 绕过 Referer 防盗链(Instagram / 微博 / etc.)
  // cache: 'no-store' 避开本地缓存错误态
  const r = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // 分块 String.fromCharCode 避开大数组爆栈
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return {
    dataUrl: `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`,
    type: blob.type || 'image/jpeg',
  };
}


const SHADOW_LANTERN_ENDPOINT = 'http://127.0.0.1:8765/shadow-lantern';

async function callShadowLantern(imageDataUrl, granularity) {
  const r = await fetch(SHADOW_LANTERN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl, granularity }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  const markdown = data.markdown || data.result || data.text;
  if (!markdown) throw new Error('empty response');
  return { markdown };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'download' && msg.url) {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename || undefined,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (id) => {
      if (chrome.runtime.lastError) {
        console.log('[hdgrab] download skipped:', chrome.runtime.lastError && chrome.runtime.lastError.message, msg.url);
      }
      sendResponse({ ok: !chrome.runtime.lastError, id });
    });
    return true;
  }
  if (msg && msg.action === 'shadow-lantern' && msg.imageDataUrl) {
    callShadowLantern(msg.imageDataUrl, msg.granularity)
      .then((data) => sendResponse(data))
      .catch((e) => sendResponse({
        error: String(e && e.message || e),
        endpoint: SHADOW_LANTERN_ENDPOINT,
      }));
    return true;
  }
  if (msg && msg.action === 'fetch-image' && msg.url) {
    fetchAsDataUrl(msg.url)
      .then((data) => sendResponse(data))
      .catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true; // async sendResponse
  }
});
