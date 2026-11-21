// =============================================================================
// StreamSniffer — background.js (Service Worker)
// • Sniffs network requests for video streams and stores them per tab.
// • Manages the persistent Offscreen Document for high-speed HLS downloading
//   & real-time fMP4 remuxing (survives popup close & service worker idle).
// • Automatically triggers chrome.downloads.download with a valid .mp4 filename
//   even if the popup is closed when the download finishes.
// =============================================================================

// ---------------------------------------------------------------------------
// Stream detection constants
// ---------------------------------------------------------------------------

const MEDIA_EXTENSIONS = {
  mp4:  "MP4",
  webm: "WEBM",
  m3u8: "HLS",
  m4v:  "MP4",
  ogg:  "WEBM",
};

const MIN_SIZE_BYTES = 10_000;

// ---------------------------------------------------------------------------
// Download state (persisted in session storage + mirrored in memory)
// ---------------------------------------------------------------------------

let dl = {
  phase: "idle", // "idle" | "running" | "done" | "error" | "cancelled"
  url: "",
  progress: 0,
  sub: "",
  error: null,
  filename: null,
};

function broadcastState() {
  chrome.storage.session.set({ dl_state: dl }).catch(() => {});
  chrome.runtime.sendMessage({ type: "DL_STATE", state: { ...dl } }).catch(() => {});

  const badge =
    dl.phase === "running" ? `${dl.progress}%` :
    dl.phase === "done"    ? "✓" :
    dl.phase === "error"   ? "✕" : "";

  const color =
    dl.phase === "done"  ? "#43a047" :
    dl.phase === "error" ? "#e53935" : "#6c63ff";

  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// Restore download state on service worker startup
chrome.storage.session.get("dl_state").then(res => {
  if (res?.dl_state) dl = res.dl_state;
}).catch(() => {});

// ---------------------------------------------------------------------------
// Offscreen Document lifecycle
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "WORKERS"],
    justification: "High-speed parallel HLS download, AES-128 decryption, fMP4 muxing, and Blob URL creation.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// ---------------------------------------------------------------------------
// Message API (Popup <-> Background <-> Offscreen)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ── 1. Stream list queries from popup ────────────────────────────────────
  if (msg.type === "GET_STREAMS") {
    readStreams(msg.tabId)
      .then(streams => sendResponse({ streams }))
      .catch(err => sendResponse({ streams: [], error: err.message }));
    return true;
  }

  if (msg.type === "CLEAR_STREAMS") {
    clearStreams(msg.tabId)
      .then(() => updateBadge(msg.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── 2. Start HLS download (delegates to Offscreen Document) ──────────────
  if (msg.type === "START_HLS_DOWNLOAD") {
    if (dl.phase === "running") {
      sendResponse({ ok: false, error: "A download is already in progress." });
      return;
    }

    (async () => {
      try {
        await ensureOffscreenDocument();
        const tabStreams = msg.tabId ? await readStreams(msg.tabId) : [];
        dl = {
          phase: "running",
          url: msg.url,
          progress: 0,
          sub: "Starting high-speed downloader…",
          error: null,
          filename: null,
        };
        broadcastState();

        chrome.runtime.sendMessage({
          type: "OFFSCREEN_START_HLS",
          url: msg.url,
          tabStreams,
          title: msg.title || "",
        });
        sendResponse({ ok: true });
      } catch (err) {
        dl = { phase: "error", url: msg.url, progress: 0, sub: "", error: err.message, filename: null };
        broadcastState();
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── 3. Cancel active download ────────────────────────────────────────────
  if (msg.type === "CANCEL_DOWNLOAD") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL" }).catch(() => {});
    dl = { phase: "idle", url: "", progress: 0, sub: "", error: null, filename: null };
    broadcastState();
    sendResponse({ ok: true });
    return;
  }

  // ── 4. Popup queries current download state ──────────────────────────────
  if (msg.type === "GET_DL_STATE") {
    sendResponse({ state: { ...dl } });
    return;
  }

  // ── 5. Offscreen reports live progress / error / cancellation ────────────
  if (msg.type === "OFFSCREEN_DL_UPDATE") {
    dl = { ...dl, ...msg.patch };
    if (dl.phase === "cancelled") {
      dl = { phase: "idle", url: "", progress: 0, sub: "", error: null, filename: null };
    }
    broadcastState();
    sendResponse({ ok: true });
    return;
  }

  // ── 6. Offscreen finished muxing .mp4 and created a typed Blob URL ───────
  if (msg.type === "OFFSCREEN_SAVE_READY") {
    const { blobUrl, filename, opfsName } = msg;
    dl = {
      phase: "done",
      url: dl.url,
      progress: 100,
      sub: `Saved ${filename}`,
      error: null,
      filename,
    };
    broadcastState();

    // Automatically trigger browser download right away (even if popup is closed!)
    chrome.downloads.download(
      {
        url: blobUrl,
        filename,
        saveAs: false,
      },
      () => {
        // Schedule OPFS and Blob URL cleanup after Chrome finishes reading the blob
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: "OFFSCREEN_CLEANUP", opfsName }).catch(() => {});
          if (dl.phase === "done") {
            dl = { phase: "idle", url: "", progress: 0, sub: "", error: null, filename: null };
            broadcastState();
          }
        }, 15_000);
      }
    );
    sendResponse({ ok: true });
    return;
  }
});

// ---------------------------------------------------------------------------
// Stream detection — webRequest listener
// ---------------------------------------------------------------------------

function detectFileType(url, mimeType) {
  if (mimeType) {
    const mime = mimeType.toLowerCase().split(";")[0].trim();
    if (mime === "video/mp4" || mime === "video/x-m4v") return "MP4";
    if (mime === "video/webm" || mime === "video/ogg")  return "WEBM";
    if (mime === "application/x-mpegurl" || mime === "application/vnd.apple.mpegurl") return "HLS";
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const [ext, type] of Object.entries(MEDIA_EXTENSIONS)) {
      if (path.endsWith(`.${ext}`)) return type;
    }
  } catch {}
  return null;
}

async function readStreams(tabId) {
  const key = `tab_${tabId}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || [];
}

async function writeStreams(tabId, streams) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: streams });
}

async function clearStreams(tabId) {
  await chrome.storage.session.remove(`tab_${tabId}`);
}

async function updateBadge(tabId) {
  if (dl.phase === "running" || dl.phase === "done" || dl.phase === "error") return;
  const streams = await readStreams(tabId);
  const count = streams.length;
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
    await chrome.action.setBadgeBackgroundColor({ color: "#e53935", tabId });
  } catch {}
}

chrome.webRequest.onCompleted.addListener(
  async ({ tabId, url, responseHeaders = [] }) => {
    if (tabId < 0) return;
    let mimeType = null, contentLength = Infinity;
    for (const h of responseHeaders) {
      const name = h.name.toLowerCase();
      if (name === "content-type")   mimeType      = h.value;
      if (name === "content-length") contentLength = parseInt(h.value, 10) || 0;
    }
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (!isHls && contentLength < MIN_SIZE_BYTES) return;
    const fileType = detectFileType(url, mimeType);
    if (!fileType) return;
    const streams = await readStreams(tabId);
    if (streams.some(s => s.url === url)) return;
    streams.push({ url, fileType, timestamp: Date.now() });
    await writeStreams(tabId, streams);
    await updateBadge(tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener(tabId => clearStreams(tabId));

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return;
  await clearStreams(tabId);
  await updateBadge(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
