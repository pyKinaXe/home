/*
Frontend controller for the pyKinaXe web upload page.

This file is intentionally lightweight: the browser handles folder selection,
ZIP creation, upload progress, and job-status polling, while the scientific
work stays on the Flask backend. The key UX responsibilities here are:

- validating PTK/STK folder selections
- packaging uploads for transport
- showing status/progress messages
- polling the backend queue/job state
- rendering returned result summaries and download links
*/

// Where the API lives. Same-origin by default (local dev / serving from
// Flask). When deployed on GitHub Pages, set window.PYKINAXE_API_BASE in
// index.html before this script loads, e.g.
//   <script>window.PYKINAXE_API_BASE = "https://you-pykinaxe.hf.space";</script>
const API_BASE = (window.PYKINAXE_API_BASE || "").replace(/\/+$/, "");
const api = (path) => `${API_BASE}${path}`;

const runButton = document.getElementById("runButton");
const ptkFolderInput = document.getElementById("ptkFolder");
const stkFolderInput = document.getElementById("stkFolder");
const ptkFolderLabel = document.getElementById("ptkFolderLabel");
const stkFolderLabel = document.getElementById("stkFolderLabel");
const statusBox = document.getElementById("statusBox");
const statusText = document.getElementById("statusText");
const resultsPanel = document.getElementById("resultsPanel");
const resultMeta = document.getElementById("resultMeta");
const kinaseResults = document.getElementById("kinaseResults");
const heatmapResults = document.getElementById("heatmapResults");
const downloadAllLink = document.getElementById("downloadAllLink");
const logPanel = document.getElementById("logPanel");
const viewerPresenceText = document.getElementById("viewerPresenceText");

let activePollTimer = null;
let activeJobId = null;
let heartbeatTimer = null;
let viewerHeartbeatTimer = null;
let autoDownloadInFlight = false;
const HEARTBEAT_INTERVAL_MS = 15000;
const VIEWER_HEARTBEAT_INTERVAL_MS = 10000;
const VIEWER_ID_KEY = "pykinaxe_viewer_id";
const VIEWER_SESSION_KEY = "pykinaxe_viewer_session_id";

/**
 * Generate a random identifier for browser- or tab-level presence tracking.
 *
 * @returns {string} Generated identifier string.
 */
function generateClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Return the stable browser-level viewer identifier.
 *
 * @returns {string} Persistent identifier shared across tabs in one browser.
 */
function getViewerId() {
  try {
    let viewerId = window.localStorage.getItem(VIEWER_ID_KEY);
    if (!viewerId) {
      viewerId = generateClientId();
      window.localStorage.setItem(VIEWER_ID_KEY, viewerId);
    }
    return viewerId;
  } catch {
    return generateClientId();
  }
}

/**
 * Return the per-tab session identifier used for viewer presence.
 *
 * @returns {string} Identifier unique to the current browser tab/session.
 */
function getViewerSessionId() {
  try {
    let sessionId = window.sessionStorage.getItem(VIEWER_SESSION_KEY);
    if (!sessionId) {
      sessionId = generateClientId();
      window.sessionStorage.setItem(VIEWER_SESSION_KEY, sessionId);
    }
    return sessionId;
  } catch {
    return generateClientId();
  }
}

/**
 * Convert the active-viewer count into a compact badge label.
 *
 * @param {number} count - Number of active viewers returned by the backend.
 * @returns {string} User-facing viewer-count label.
 */
function formatViewerPresence(count) {
  if (!Number.isFinite(count) || count < 0) {
    return "Online now unavailable";
  }
  if (count === 1) {
    return "1 user online now";
  }
  return `${count} users online now`;
}

/**
 * Update the visible viewer-presence label in the page corner.
 *
 * @param {number} count - Number of active viewers returned by the backend.
 * @returns {void}
 */
function setViewerPresence(count) {
  if (!viewerPresenceText) return;
  viewerPresenceText.textContent = formatViewerPresence(count);
}

/**
 * Stop the periodic viewer-presence heartbeat timer.
 *
 * @returns {void}
 */
function stopViewerHeartbeat() {
  if (viewerHeartbeatTimer !== null) {
    window.clearInterval(viewerHeartbeatTimer);
    viewerHeartbeatTimer = null;
  }
}

/**
 * Send one viewer-presence heartbeat and refresh the visible count.
 *
 * @returns {Promise<void>}
 */
async function sendViewerHeartbeat() {
  try {
    const response = await fetch(api("/api/viewers/heartbeat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewer_id: getViewerId(),
        session_id: getViewerSessionId(),
      }),
      keepalive: true,
    });
    if (!response.ok) return;
    const payload = await response.json();
    setViewerPresence(Number(payload.viewer_count));
  } catch {
    if (viewerPresenceText && !viewerPresenceText.textContent.trim()) {
      viewerPresenceText.textContent = "Online now unavailable";
    }
  }
}

/**
 * Start the periodic viewer-presence heartbeat loop.
 *
 * @returns {void}
 */
function startViewerHeartbeat() {
  stopViewerHeartbeat();
  void sendViewerHeartbeat();
  viewerHeartbeatTimer = window.setInterval(() => {
    void sendViewerHeartbeat();
  }, VIEWER_HEARTBEAT_INTERVAL_MS);
}

/**
 * Notify the backend that this browser tab is no longer viewing the page.
 *
 * @returns {void}
 */
function releaseViewerPresence() {
  const sessionId = getViewerSessionId();
  const viewerId = getViewerId();
  const payload = new URLSearchParams({
    viewer_id: viewerId,
    session_id: sessionId,
  });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(api("/api/viewers/release"), payload);
    } else {
      fetch(api("/api/viewers/release"), {
        method: "POST",
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

/**
 * Stop the periodic heartbeat ping for the currently watched job.
 *
 * @returns {void}
 */
// Stop the periodic heartbeat ping for the currently watched job.
function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Start the heartbeat timer for the active backend job.
 *
 * @param {string} jobId - Unique identifier of the job being monitored.
 * @returns {void}
 */
// Start a background heartbeat so the server knows the browser tab is still
// interested in keeping this job alive.
function startHeartbeat(jobId) {
  stopHeartbeat();
  activeJobId = jobId;
  heartbeatTimer = window.setInterval(() => {
    if (!activeJobId) return;
    // Best-effort: ignore network errors. The server's reaper will use this
    // to know the client is still alive.
    fetch(api(`/api/jobs/${activeJobId}/heartbeat`), {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Notify the backend that the current job can be released.
 *
 * @returns {void}
 */
// Best-effort signal that the current job can be cleaned up if the user leaves
// the page or starts over with a different job.
function releaseActiveJob() {
  if (!activeJobId) return;
  const jobId = activeJobId;
  // Tell the server this job is abandoned so it can be deleted immediately.
  // sendBeacon is the only reliable way to fire a request during pagehide /
  // beforeunload — fetch() requests are usually cancelled by the browser.
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(api(`/api/jobs/${jobId}/release`), new Blob([], { type: "text/plain" }));
    } else {
      fetch(api(`/api/jobs/${jobId}/release`), { method: "POST", keepalive: true }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

/**
 * Clear the browser-side state for the currently active job.
 *
 * @returns {void}
 */
// Clear the active job bookkeeping held in the browser.
function clearActiveJob() {
  stopHeartbeat();
  activeJobId = null;
}

// Refresh, navigation, tab close, window close all trigger pagehide.
window.addEventListener("pagehide", releaseActiveJob);
// beforeunload covers some older Safari paths and reload via address bar.
window.addEventListener("beforeunload", releaseActiveJob);
window.addEventListener("pagehide", releaseViewerPresence);
window.addEventListener("beforeunload", releaseViewerPresence);

/**
 * Infer the top-level folder name from a `webkitdirectory` file selection.
 *
 * @param {FileList|File[]} files - Files selected from one folder chooser.
 * @returns {string|null} The inferred folder name, or `null` when unavailable.
 */
// Infer the top-level selected folder name from a webkitdirectory file list.
function getSelectedFolderName(files) {
  if (!files || files.length === 0) {
    return null;
  }
  const first = files[0];
  const relativePath = first.webkitRelativePath || first.name || "";
  return relativePath.split("/")[0] || null;
}

/**
 * Refresh the visible label for one selected upload folder.
 *
 * @param {HTMLInputElement} input - Folder input whose files are being inspected.
 * @param {HTMLElement} label - Label element updated with the folder name.
 * @returns {void}
 */
// Refresh the visible PTK/STK folder label after a new folder is chosen.
function updateFolderLabel(input, label) {
  const folderName = getSelectedFolderName(input.files);
  label.textContent = folderName || "No folder selected.";
}

/**
 * Decide whether one selected file should be uploaded to the backend.
 *
 * @param {File} file - Candidate file from the selected PTK/STK folder.
 * @returns {boolean} `true` when the file is relevant to the analysis upload.
 */
// Keep only the files the backend actually needs from a PamGene run folder.
function isRelevantUploadFile(file) {
  const relativePath = String(file.webkitRelativePath || file.name || "");
  const upperPath = relativePath.toUpperCase();
  const filename = relativePath.split("/").pop() || "";
  const upperFilename = filename.toUpperCase();

  if (upperPath.includes("/IMAGERESULTS/") && upperFilename.endsWith(".TIF")) {
    return true;
  }
  if (upperFilename.endsWith("SAMPLE ANNOTATION.TXT")) {
    return true;
  }
  if (upperFilename.endsWith("ARRAY LAYOUT.TXT")) {
    return true;
  }
  return false;
}

/**
 * Convert one backend comparison label into a cleaner display label.
 *
 * @param {string} value - Raw comparison label returned by the backend.
 * @returns {string} Human-readable comparison label for the UI.
 */
// Normalize backend comparison labels into a more readable frontend form.
function formatComparisonLabel(value) {
  let text = String(value || "").trim();
  if (text.startsWith("Control_")) {
    text = text.slice("Control_".length);
  } else if (text.startsWith("Control ")) {
    text = text.slice("Control ".length);
  }
  // Insert a space between "Test" and a trailing number, e.g. "Test1" -> "Test 1".
  return text.replace(/\bTest(\d+)\b/g, "Test $1");
}

/**
 * Derive a compact heatmap title from a generated heatmap filename.
 *
 * @param {string} filename - Heatmap filename returned by the backend.
 * @returns {string} Display-ready heatmap title.
 */
// Derive a concise display title from one generated peptide heatmap filename.
function formatHeatmapTitle(filename) {
  // Strip extension and the well-known prefix, then take the last
  // underscore-delimited token (the test condition), e.g.
  //   "peptides_heatmap_Control_Test1.png" -> "Test 1"
  let text = String(filename || "").trim();
  text = text.replace(/\.[^.]+$/, "");
  text = text.replace(/^peptides[_\s-]*heatmap[_\s-]*/i, "");
  const parts = text.split("_").filter(Boolean);
  if (parts.length > 0) {
    text = parts[parts.length - 1];
  }
  return formatComparisonLabel(text);
}

/**
 * Update the shared status banner shown during upload and analysis.
 *
 * @param {string} kind - Status kind controlling the banner styling.
 * @param {string} message - Human-readable status message.
 * @returns {void}
 */
// Update the shared status banner shown to the user during upload and analysis.
function setStatus(kind, message) {
  statusBox.className = `status ${kind}`;
  statusText.textContent = message;
}

/**
 * Format the queue metadata returned by the backend into UI text.
 *
 * @param {Object} payload - Job-status payload returned by the backend.
 * @returns {string} Queue status text for the user.
 */
// Build the user-facing queue message from the backend queue metadata.
function formatQueuedStatus(payload) {
  const queuePosition = Number(payload.queue_position);
  const jobsAhead = Number(payload.jobs_ahead);
  const status = String(payload.status || "");

  let prefix = "Queued";
  if (status === "waiting_for_upload") {
    prefix = "Waiting for upload turn";
  } else if (status === "queued") {
    prefix = "Upload complete. Waiting for analysis";
  } else if (status === "upload_ready") {
    prefix = "Upload turn ready";
  }

  if (Number.isFinite(queuePosition) && queuePosition > 0) {
    if (Number.isFinite(jobsAhead) && jobsAhead >= 0) {
      const aheadLabel = jobsAhead === 1 ? "job" : "jobs";
      return `${prefix}: position ${queuePosition} (${jobsAhead} ${aheadLabel} ahead).`;
    }
    return `${prefix}: position ${queuePosition}.`;
  }

  return payload.message || "Job is queued.";
}

/**
 * Render the rolling log entries for the current backend job.
 *
 * @param {Object} payload - Job-status payload containing log entries.
 * @returns {void}
 */
// Render the rolling per-job log stream returned by the backend.
function renderLogs(payload) {
  const logs = payload.logs || [];
  if (logs.length === 0) {
    logPanel.innerHTML = `<div class="log-empty">Logs will appear here after a job starts.</div>`;
    return;
  }

  logPanel.innerHTML = "";
  const list = document.createElement("div");
  list.className = "log-list";

  for (const entry of logs) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.innerHTML = `
      <div class="log-time">${entry.timestamp || ""}</div>
      <div class="log-message">${entry.message || ""}</div>
    `;
    list.appendChild(item);
  }

  logPanel.appendChild(list);
  logPanel.scrollTop = logPanel.scrollHeight;
}

/**
 * Append one client-side log line without waiting for another backend poll.
 *
 * @param {string} message - Human-readable message to append to the log panel.
 * @returns {void}
 */
function appendClientLog(message) {
  if (!message) return;

  const empty = logPanel.querySelector(".log-empty");
  if (empty) {
    logPanel.innerHTML = "";
  }

  let list = logPanel.querySelector(".log-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "log-list";
    logPanel.appendChild(list);
  }

  const item = document.createElement("div");
  item.className = "log-item";
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  item.innerHTML = `
    <div class="log-time">${timestamp}</div>
    <div class="log-message">${message}</div>
  `;
  list.appendChild(item);
  logPanel.scrollTop = logPanel.scrollHeight;
}

/**
 * Convert a backend-relative URL into one usable by the current frontend.
 *
 * @param {string} url - Relative or absolute URL returned by the backend.
 * @returns {string} Absolute URL suitable for links and image tags.
 */
// Prefix backend-relative URLs when the frontend is hosted on another origin.
function absolutize(url) {
  // Server returns paths like "/api/jobs/<id>/download". Prefix with API_BASE
  // when the frontend is hosted on a different origin (GitHub Pages).
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return url;
}

/**
 * Render the completed-job outputs in the results panel.
 *
 * @param {Object} payload - Completed job payload returned by the backend.
 * @returns {void}
 */
// Render the completed-job outputs such as workbooks, heatmaps, and downloads.
function renderResults(payload) {
  const results = payload.results;
  resultsPanel.classList.remove("hidden");
  resultMeta.textContent = `Job ${payload.job_id} finished at ${payload.finished_at || "unknown time"}.`;
  kinaseResults.innerHTML = "";
  heatmapResults.innerHTML = "";

  if (results.download_url) {
    downloadAllLink.hidden = false;
    downloadAllLink.href = absolutize(`${results.download_url}?cleanup=1`);
    if (results.archive_name) {
      downloadAllLink.download = results.archive_name;
    }
  }

  for (const item of results.kinase_outputs || []) {
    const card = document.createElement("article");
    card.className = "card";
    const workbookUrl = absolutize(item.workbook_url);
    card.innerHTML = `
      <h4>${formatComparisonLabel(item.comparison)}</h4>
      <p class="muted">Workbook: <a href="${workbookUrl}" target="_blank" rel="noopener">${item.workbook_name}</a></p>
      <div class="csv-line">${item.kinase_csv || "No significant kinases found."}</div>
    `;
    kinaseResults.appendChild(card);
  }

  if ((results.kinase_outputs || []).length === 0) {
    kinaseResults.innerHTML = `<div class="card"><div class="csv-line">No Kinases_Significant output was found.</div></div>`;
  }

  for (const item of results.heatmaps || []) {
    const card = document.createElement("article");
    card.className = "card heatmap-card";
    const prettyName = formatHeatmapTitle(item.filename);
    const imgUrl = absolutize(item.url);
    card.innerHTML = `
      <h4>${prettyName}</h4>
      <p class="muted"><a href="${imgUrl}" target="_blank" rel="noopener">Open image in a new tab</a></p>
      <img src="${imgUrl}" alt="${prettyName}">
    `;
    heatmapResults.appendChild(card);
  }

  if ((results.heatmaps || []).length === 0) {
    heatmapResults.innerHTML = `<div class="card"><div class="csv-line">No peptide heatmap images were found.</div></div>`;
  }
}

/**
 * Download the completed ZIP archive automatically, then release the job so
 * the backend can delete uploaded inputs and generated artifacts.
 *
 * @param {Object} payload - Completed job payload returned by the backend.
 * @returns {Promise<void>}
 */
async function autoDownloadResults(payload) {
  if (autoDownloadInFlight) return;
  const results = payload && payload.results;
  if (!results || !results.download_url) return;

  autoDownloadInFlight = true;
  const jobId = payload.job_id;
  const downloadUrl = absolutize(results.download_url);

  try {
    setStatus("completed", "Analysis finished. Downloading ZIP archive...");
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`ZIP download failed with HTTP ${response.status}.`);
    }

    const totalBytes = Number(response.headers.get("content-length"));
    const contentDisposition = String(response.headers.get("content-disposition") || "");
    const filenameMatch =
      contentDisposition.match(/filename\*=UTF-8''([^;]+)/i) ||
      contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
    const suggestedFilename = filenameMatch
      ? decodeURIComponent(filenameMatch[1])
      : String(results.archive_name || "").trim() || "pyKinaXe_results.zip";

    let archiveBlob;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          receivedBytes += value.byteLength;
          if (Number.isFinite(totalBytes) && totalBytes > 0) {
            const percent = Math.round((receivedBytes / totalBytes) * 100);
            setStatus("completed", `Analysis finished. Downloading ZIP archive (${percent}%)...`);
          } else {
            const sizeMB = (receivedBytes / (1024 * 1024)).toFixed(1);
            setStatus("completed", `Analysis finished. Downloading ZIP archive (${sizeMB} MB received)...`);
          }
        }
      }

      archiveBlob = new Blob(chunks, {
        type: response.headers.get("content-type") || "application/zip",
      });
    } else {
      archiveBlob = await response.blob();
    }

    setStatus("completed", "Analysis finished. Saving ZIP archive...");
    const blobUrl = URL.createObjectURL(archiveBlob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = suggestedFilename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

    if (activeJobId === jobId) {
      clearActiveJob();
    }

    setStatus("completed", "ZIP archive saved in the browser. Cleaning bucket-backed runtime...");
    const cleanupResponse = await fetch(api(`/api/jobs/${jobId}/finalize_download`), {
      method: "POST",
    });
    if (!cleanupResponse.ok) {
      let cleanupPayload = null;
      try {
        cleanupPayload = await cleanupResponse.json();
      } catch {
        cleanupPayload = null;
      }
      throw new Error(
        (cleanupPayload && cleanupPayload.error) ||
          `Bucket cleanup failed with HTTP ${cleanupResponse.status}.`
      );
    }

    setStatus(
      "completed",
      "Results downloaded. Bucket cleanup completed, and the next queued upload can proceed."
    );
    appendClientLog("Job finished successfully, results downloaded.");
  } catch (error) {
    setStatus(
      "completed",
      (error && error.message) ||
        "Analysis finished, but automatic ZIP download or cleanup failed. Use the download link below."
    );
  } finally {
    autoDownloadInFlight = false;
  }
}

/**
 * Build one ZIP archive in the browser from a folder selection.
 *
 * @param {string} kind - Upload kind, usually `ptk` or `stk`.
 * @param {File[]} files - Relevant files selected from the chosen folder.
 * @returns {Promise<Blob>} ZIP blob ready for upload.
 */
async function buildZipBlob(kind, files) {
  const zip = new JSZip();
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const relativePath = file.webkitRelativePath || file.name;
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch (err) {
      throw new Error(
        `Could not read ${relativePath} from disk (${err && err.message ? err.message : err}). ` +
          "Safari sometimes loses access to a webkitdirectory selection — " +
          "please re-select the folder and try again."
      );
    }
    zip.file(relativePath, bytes);
    if (i % 10 === 0 || i === files.length - 1) {
      setStatus(
        "running",
        `Reading ${kind.toUpperCase()} files (${i + 1}/${files.length})...`
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  setStatus("running", `Compressing ${kind.toUpperCase()} ZIP (0%)...`);
  return zip.generateAsync(
    { type: "blob", compression: "STORE", streamFiles: false },
    (metadata) => {
      if (metadata && typeof metadata.percent === "number") {
        setStatus(
          "running",
          `Compressing ${kind.toUpperCase()} ZIP (${Math.round(metadata.percent)}%)...`
        );
      }
    }
  );
}

/**
 * Upload one prepared ZIP blob to the matching backend endpoint.
 *
 * @param {string} jobId - Unique identifier of the active upload job.
 * @param {string} kind - Upload kind, usually `ptk` or `stk`.
 * @param {Blob} blob - ZIP blob produced from one selected folder.
 * @returns {Promise<Object|null>} Parsed backend response payload.
 */
function uploadZipBlob(jobId, kind, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = api(`/api/jobs/${jobId}/upload_zip?kind=${encodeURIComponent(kind)}`);
    xhr.open("POST", url, true);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setStatus(
          "running",
          `Uploading ${kind.toUpperCase()} ZIP (${percent}%)...`
        );
      }
    };

    xhr.onload = () => {
      let parsed = null;
      try {
        parsed = JSON.parse(xhr.responseText || "null");
      } catch {
        parsed = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed);
        return;
      }
      const message =
        (parsed && parsed.error) ||
        `Upload of ${kind.toUpperCase()} ZIP failed (HTTP ${xhr.status}).`;
      reject(new Error(message));
    };

    xhr.onerror = () =>
      reject(
        new Error(
          `Network error while uploading ${kind.toUpperCase()} ZIP. ` +
            "Check that the local server is still running."
        )
      );
    xhr.onabort = () =>
      reject(new Error(`Upload of ${kind.toUpperCase()} ZIP was aborted.`));

    const formData = new FormData();
    formData.append("archive", blob, `${kind}.zip`);
    xhr.send(formData);
  });
}

/**
 * ZIP and upload one selected PTK/STK folder.
 *
 * @param {string} jobId - Unique identifier of the active upload job.
 * @param {string} kind - Upload kind, usually `ptk` or `stk`.
 * @param {File[]} files - Relevant files selected from the chosen folder.
 * @returns {Promise<void>}
 */
async function zipAndUploadFolder(jobId, kind, files) {
  const blob = await buildZipBlob(kind, files);
  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  setStatus("running", `Uploading ${kind.toUpperCase()} ZIP (${sizeMB} MB)...`);
  const responsePayload = await uploadZipBlob(jobId, kind, blob);
  if (responsePayload) renderLogs(responsePayload);
}

/**
 * Ask the backend for the current upload turn, then send the selected folders.
 *
 * @param {string} jobId - Unique identifier of the queued job.
 * @param {{ptkFiles: File[], stkFiles: File[], started: boolean}} uploadPlan - Files held in the browser until the queue reaches this user.
 * @returns {Promise<void>}
 */
async function beginQueuedUpload(jobId, uploadPlan) {
  if (!uploadPlan || uploadPlan.started) return;
  uploadPlan.started = true;

  try {
    setStatus("running", "Your turn has arrived. Preparing a clean upload workspace...");
    const beginResponse = await fetch(api(`/api/jobs/${jobId}/begin_upload`), {
      method: "POST",
    });

    let beginPayload;
    try {
      beginPayload = await beginResponse.json();
    } catch {
      throw new Error(`Upload turn request failed with HTTP ${beginResponse.status}.`);
    }
    if (!beginResponse.ok) {
      throw new Error(beginPayload.error || "Upload turn request failed.");
    }

    renderLogs(beginPayload);

    if (typeof JSZip === "undefined") {
      throw new Error("JSZip failed to load in the browser.");
    }

    await zipAndUploadFolder(jobId, "ptk", uploadPlan.ptkFiles);
    await zipAndUploadFolder(jobId, "stk", uploadPlan.stkFiles);

    setStatus("running", "Starting analysis job...");
    const startResponse = await fetch(api(`/api/jobs/${jobId}/start`), { method: "POST" });
    let startPayload;
    try {
      startPayload = await startResponse.json();
    } catch {
      throw new Error(`Job start failed with HTTP ${startResponse.status}.`);
    }
    if (!startResponse.ok) {
      throw new Error(startPayload.error || "Job start failed.");
    }

    renderLogs(startPayload);
    if (startPayload.status === "queued") {
      setStatus("running", formatQueuedStatus(startPayload));
    } else {
      setStatus("running", startPayload.message || "Analysis queued.");
    }

    await pollJob(jobId, uploadPlan);
  } catch (error) {
    uploadPlan.started = false;
    throw error;
  }
}

/**
 * Poll the backend until the requested job reaches a terminal state.
 *
 * @param {string} jobId - Unique identifier of the job being monitored.
 * @param {{ptkFiles: File[], stkFiles: File[], started: boolean}|null} uploadPlan - Client-side files held until the upload turn begins.
 * @returns {Promise<void>}
 */
// Poll the backend until the current job reaches a terminal state.
async function pollJob(jobId, uploadPlan = null) {
  const response = await fetch(api(`/api/jobs/${jobId}`));
  if (!response.ok) {
    if (response.status === 404) {
      setStatus("failed", "This job is no longer available on the server.");
      runButton.disabled = false;
      return;
    }
    setStatus("failed", `Job polling failed with HTTP ${response.status}.`);
    runButton.disabled = false;
    return;
  }
  const payload = await response.json();
  renderLogs(payload);

  if (payload.status === "waiting_for_upload") {
    setStatus("running", formatQueuedStatus(payload));
    activePollTimer = window.setTimeout(() => pollJob(jobId, uploadPlan), 2500);
    return;
  }

  if (payload.status === "upload_ready") {
    setStatus("running", payload.message || formatQueuedStatus(payload));
    if (uploadPlan && !uploadPlan.started) {
      try {
        await beginQueuedUpload(jobId, uploadPlan);
      } catch (error) {
        setStatus("failed", error.message || "Unexpected error during upload.");
        runButton.disabled = false;
        releaseActiveJob();
        clearActiveJob();
      }
      return;
    }
    activePollTimer = window.setTimeout(() => pollJob(jobId, uploadPlan), 1500);
    return;
  }

  if (payload.status === "uploading") {
    setStatus("running", payload.message || "Uploading selected PTK/STK data...");
    activePollTimer = window.setTimeout(() => pollJob(jobId, uploadPlan), 2500);
    return;
  }

  if (payload.status === "queued") {
    setStatus("running", formatQueuedStatus(payload));
    activePollTimer = window.setTimeout(() => pollJob(jobId, uploadPlan), 2500);
    return;
  }

  if (payload.status === "starting" || payload.status === "running") {
    setStatus("running", payload.message || "Analysis is running...");
    activePollTimer = window.setTimeout(() => pollJob(jobId, uploadPlan), 2500);
    return;
  }

  if (payload.status === "failed") {
    setStatus("failed", payload.error || payload.message || "Analysis failed.");
    runButton.disabled = false;
    releaseActiveJob();
    clearActiveJob();
    return;
  }

  if (payload.status === "completed") {
    setStatus("completed", payload.message || "Analysis finished.");
    renderLogs(payload);
    renderResults(payload);
    runButton.disabled = false;
    await autoDownloadResults(payload);
  }
}

/**
 * Run the complete browser-side upload and queueing workflow.
 *
 * @returns {Promise<void>}
 */
// Drive the complete browser-side workflow: validate folders, upload data,
// queue the job, and begin polling for results.
async function startUpload() {
  if (activePollTimer !== null) {
    window.clearTimeout(activePollTimer);
    activePollTimer = null;
  }
  // If the user is starting a new job while another one is active, release
  // the previous job's folder on the server right away.
  if (activeJobId) {
    releaseActiveJob();
    clearActiveJob();
  }

  const ptkFiles = Array.from(ptkFolderInput.files || []);
  const stkFiles = Array.from(stkFolderInput.files || []);
  const ptkRelevantFiles = ptkFiles.filter(isRelevantUploadFile);
  const stkRelevantFiles = stkFiles.filter(isRelevantUploadFile);

  runButton.disabled = true;
  resultsPanel.classList.add("hidden");
  downloadAllLink.hidden = true;
  downloadAllLink.removeAttribute("href");
  logPanel.innerHTML = `<div class="log-empty">Joining the upload queue...</div>`;

  try {
    if (ptkFiles.length === 0 || stkFiles.length === 0) {
      throw new Error("Please choose both a PTK folder and an STK folder.");
    }

    if (ptkRelevantFiles.length === 0 || stkRelevantFiles.length === 0) {
      throw new Error("The selected folder does not contain the expected ImageResults TIFFs and annotation/layout text files.");
    }

    setStatus("running", "Creating analysis job...");
    const initResponse = await fetch(api("/api/jobs/init"), { method: "POST" });

    let payload;
    try {
      payload = await initResponse.json();
    } catch {
      throw new Error(`Upload init failed with HTTP ${initResponse.status}.`);
    }
    if (!initResponse.ok) {
      throw new Error(payload.error || "Upload init failed.");
    }

    const jobId = payload.job_id;
    startHeartbeat(jobId);

    renderLogs(payload);
    const uploadPlan = {
      ptkFiles: ptkRelevantFiles,
      stkFiles: stkRelevantFiles,
      started: false,
    };
    await pollJob(jobId, uploadPlan);
  } catch (error) {
    setStatus("failed", error.message || "Unexpected error during upload.");
    runButton.disabled = false;
    // Upload failed — release any half-uploaded job folder.
    releaseActiveJob();
    clearActiveJob();
  }
}

// The main action button launches the end-to-end upload and analysis flow.
runButton.addEventListener("click", startUpload);

// Keep the visible folder labels in sync with the selected upload folders.
ptkFolderInput.addEventListener("change", () => updateFolderLabel(ptkFolderInput, ptkFolderLabel));
stkFolderInput.addEventListener("change", () => updateFolderLabel(stkFolderInput, stkFolderLabel));

startViewerHeartbeat();
