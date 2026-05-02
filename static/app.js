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

let activePollTimer = null;
let activeJobId = null;
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 15000;

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

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

function clearActiveJob() {
  stopHeartbeat();
  activeJobId = null;
}

// Refresh, navigation, tab close, window close all trigger pagehide.
window.addEventListener("pagehide", releaseActiveJob);
// beforeunload covers some older Safari paths and reload via address bar.
window.addEventListener("beforeunload", releaseActiveJob);

function getSelectedFolderName(files) {
  if (!files || files.length === 0) {
    return null;
  }
  const first = files[0];
  const relativePath = first.webkitRelativePath || first.name || "";
  return relativePath.split("/")[0] || null;
}

function updateFolderLabel(input, label) {
  const folderName = getSelectedFolderName(input.files);
  label.textContent = folderName || "No folder selected.";
}

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

function setStatus(kind, message) {
  statusBox.className = `status ${kind}`;
  statusText.textContent = message;
}

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

function absolutize(url) {
  // Server returns paths like "/api/jobs/<id>/download". Prefix with API_BASE
  // when the frontend is hosted on a different origin (GitHub Pages).
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return url;
}

function renderResults(payload) {
  const results = payload.results;
  resultsPanel.classList.remove("hidden");
  resultMeta.textContent = `Job ${payload.job_id} finished at ${payload.finished_at || "unknown time"}.`;
  kinaseResults.innerHTML = "";
  heatmapResults.innerHTML = "";

  if (results.download_url) {
    downloadAllLink.hidden = false;
    downloadAllLink.href = absolutize(results.download_url);
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

async function pollJob(jobId) {
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

  if (payload.status === "queued" || payload.status === "running") {
    setStatus("running", payload.message || "Analysis is running...");
    activePollTimer = window.setTimeout(() => pollJob(jobId), 2500);
    return;
  }

  if (payload.status === "failed") {
    setStatus("failed", payload.error || payload.message || "Analysis failed.");
    runButton.disabled = false;
    clearActiveJob();
    return;
  }

  if (payload.status === "completed") {
    setStatus("completed", payload.message || "Analysis finished.");
    renderLogs(payload);
    renderResults(payload);
    runButton.disabled = false;
    // Keep the heartbeat going while the user is reading results so the
    // server doesn't reap the job folder out from under the download links.
  }
}

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
  logPanel.innerHTML = `<div class="log-empty">Preparing upload...</div>`;

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

    if (typeof JSZip === "undefined") {
      throw new Error("JSZip failed to load in the browser.");
    }

    // Build a ZIP in the browser by reading each File SEQUENTIALLY into
    // bytes. Safari's "I/O read" / "Load failed" errors come from JSZip's
    // streaming generator opening many webkitdirectory File handles at the
    // same time. Reading one at a time keeps exactly one handle open.
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
          // Yield to the event loop so Safari can repaint and stay responsive.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      setStatus("running", `Compressing ${kind.toUpperCase()} ZIP (0%)...`);
      // STORE: TIFFs are already incompressible; skipping DEFLATE avoids
      // CPU/memory stalls in Safari for large folders.
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

    // Use XMLHttpRequest for the upload: it gives a real upload-progress
    // event and surfaces a meaningful error when Safari aborts, unlike
    // fetch() which just throws "Load failed".
    function uploadZipBlob(kind, blob) {
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

    async function zipAndUploadFolder(kind, files) {
      const blob = await buildZipBlob(kind, files);
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
      setStatus("running", `Uploading ${kind.toUpperCase()} ZIP (${sizeMB} MB)...`);
      const responsePayload = await uploadZipBlob(kind, blob);
      if (responsePayload) renderLogs(responsePayload);
    }

    await zipAndUploadFolder("ptk", ptkRelevantFiles);
    await zipAndUploadFolder("stk", stkRelevantFiles);

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

    setStatus("running", startPayload.message || "Analysis queued.");
    renderLogs(startPayload);
    await pollJob(jobId);
  } catch (error) {
    setStatus("failed", error.message || "Unexpected error during upload.");
    runButton.disabled = false;
    // Upload failed — release any half-uploaded job folder.
    releaseActiveJob();
    clearActiveJob();
  }
}

runButton.addEventListener("click", startUpload);

ptkFolderInput.addEventListener("change", () => updateFolderLabel(ptkFolderInput, ptkFolderLabel));
stkFolderInput.addEventListener("change", () => updateFolderLabel(stkFolderInput, stkFolderLabel));
