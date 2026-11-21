// =============================================================================
// StreamSniffer — popup.js
// Pure UI layer inspired by Video DownloadHelper.
// All downloading, decryption, and fMP4 remuxing run in offscreen.js so you can
// close and reopen the popup at any time without interrupting the download.
// =============================================================================

const mainEl          = document.getElementById("main");
const btnClear        = document.getElementById("btn-clear");
const progressOverlay = document.getElementById("progress-overlay");
const progressLabel   = document.getElementById("progress-label");
const progressBar     = document.getElementById("progress-bar");
const progressSub     = document.getElementById("progress-sub");
const btnCancel       = document.getElementById("btn-cancel");

let currentTab = null;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function friendlyName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    const prev = parts[parts.length - 2] || "";
    if (u.pathname.toLowerCase().includes("/audio/")) {
      return `🎵 Audio (${prev || "eng"}) — Auto-pairs Video`;
    }
    if (/^\d{3,4}p?$/i.test(prev)) {
      return `🎬 Video (${prev}) + Audio (.mp4)`;
    }
    if (parts.length > 2) {
      return `🎬 Video: ${prev}/${last}`;
    }
    return last || u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------

function showProgress(label, pct = 0, sub = "") {
  progressOverlay.classList.remove("hidden");
  progressLabel.textContent = label;
  progressBar.style.width   = `${pct}%`;
  progressSub.textContent   = sub;
}

function hideProgress() {
  progressOverlay.classList.add("hidden");
}

function applyState(state) {
  if (!state) return;

  if (state.phase === "running") {
    showProgress("Downloading MP4…", state.progress, state.sub);
    return;
  }

  if (state.phase === "done") {
    showProgress("Download Complete!", 100, state.sub || "Saved .mp4 file");
    setTimeout(hideProgress, 2000);
    return;
  }

  if (state.phase === "error") {
    hideProgress();
    showError(`HLS download failed: ${state.error}`);
    return;
  }

  if (state.phase === "cancelled" || state.phase === "idle") {
    hideProgress();
  }
}

// ---------------------------------------------------------------------------
// Error & Stream list rendering
// ---------------------------------------------------------------------------

function showError(msg) {
  const existing = mainEl.querySelector(".error-card");
  if (existing) existing.remove();
  const card = document.createElement("div");
  card.className = "error-card";
  card.style.whiteSpace = "pre-wrap";
  card.textContent = msg;
  mainEl.prepend(card);
}

function renderEmpty() {
  mainEl.innerHTML = `
    <div class="state-card">
      <span class="icon">📡</span>
      <span class="msg">No streams detected yet.</span>
      <span class="submsg">
        Play or seek in a video on this page — StreamSniffer will
        automatically detect MP4, WebM, and HLS streams.
      </span>
    </div>`;
}

function badgeClass(t) {
  return t === "MP4" ? "badge badge-mp4" : t === "HLS" ? "badge badge-hls" : "badge badge-webm";
}

function renderStreams(streams) {
  mainEl.innerHTML = "";
  if (!streams || !streams.length) {
    renderEmpty();
    return;
  }

  // Prioritize video/master streams above standalone audio playlists
  const sorted = [...streams].sort((a, b) => {
    const aAudio = a.url.toLowerCase().includes("/audio/");
    const bAudio = b.url.toLowerCase().includes("/audio/");
    if (aAudio !== bAudio) return aAudio ? 1 : -1;
    return b.timestamp - a.timestamp;
  });

  for (const stream of sorted) {
    const item = document.createElement("div");
    item.className = "stream-item";

    const badge = document.createElement("span");
    badge.className   = badgeClass(stream.fileType);
    badge.textContent = stream.fileType;

    const label = document.createElement("span");
    label.className   = "stream-url";
    label.textContent = friendlyName(stream.url);
    label.title       = stream.url;

    const btn = document.createElement("button");
    btn.className   = "btn-dl";
    btn.textContent = "⬇ Download MP4";
    btn.addEventListener("click", () => handleDownload(stream, btn));

    item.append(badge, label, btn);
    mainEl.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Download dispatcher
// ---------------------------------------------------------------------------

function handleDownload(stream, btn) {
  btn.disabled    = true;
  btn.textContent = "Starting…";

  if (stream.fileType === "HLS") {
    const cleanTitle = currentTab?.title
      ? currentTab.title.replace(/[^a-zA-Z0-9._ -]/g, "").trim().replace(/\s+/g, "_").slice(0, 60)
      : "";

    chrome.runtime.sendMessage(
      {
        type: "START_HLS_DOWNLOAD",
        url: stream.url,
        tabId: currentTab?.id,
        title: cleanTitle,
      },
      (resp) => {
        btn.disabled    = false;
        btn.textContent = "⬇ Download MP4";
        if (resp?.ok) {
          showProgress("Downloading MP4…", 0, "Resolving tracks…");
        } else {
          showError(resp?.error || "Could not start download.");
        }
      }
    );
  } else {
    const ext = stream.fileType === "WEBM" ? ".webm" : ".mp4";
    const base = (friendlyName(stream.url).replace(/[^a-zA-Z0-9._-]/g, "_") || "video").replace(/\.(mp4|webm)$/i, "");
    chrome.downloads.download({ url: stream.url, filename: `${base}${ext}` }, () => {
      if (chrome.runtime.lastError) {
        showError(`Download failed: ${chrome.runtime.lastError.message}`);
      }
      setTimeout(() => {
        btn.disabled    = false;
        btn.textContent = "⬇ Download MP4";
      }, 1200);
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;

  // 1. Restore active download state immediately when popup opens
  chrome.runtime.sendMessage({ type: "GET_DL_STATE" }, (resp) => {
    if (resp?.state) applyState(resp.state);
  });

  // 2. Subscribe to live progress updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DL_STATE") applyState(msg.state);
  });

  // 3. Load streams for active tab
  if (currentTab) {
    chrome.runtime.sendMessage({ type: "GET_STREAMS", tabId: currentTab.id }, (resp) => {
      if (chrome.runtime.lastError) {
        showError(`Could not connect to background worker: ${chrome.runtime.lastError.message}`);
        return;
      }
      renderStreams(resp?.streams || []);
    });
  } else {
    renderEmpty();
  }

  // 4. Clear button
  btnClear.addEventListener("click", () => {
    if (!currentTab) return;
    chrome.runtime.sendMessage({ type: "CLEAR_STREAMS", tabId: currentTab.id }, () => {
      renderEmpty();
    });
  });

  // 5. Cancel button
  btnCancel.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_DOWNLOAD" });
    hideProgress();
  });
}

init();
