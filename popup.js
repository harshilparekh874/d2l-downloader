import { scanCourse } from "./extract.js";
import { itemKey } from "./catalog.js";
import { clearDestination, destinationName } from "./handles.js";
import { fileLeaf, safeRelativePath } from "./paths.js";

const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const folderInput = document.querySelector("#folder-name");
const locationNameEl = document.querySelector("#location-name");
const chooseBtn = document.querySelector("#choose-location");
const downloadsBtn = document.querySelector("#use-downloads");
const summaryEl = document.querySelector("#summary");
const hiddenLabel = document.querySelector("#hidden-label");
const hiddenInput = document.querySelector("#include-hidden");
const hiddenText = document.querySelector("#hidden-text");
const locationLabel = document.querySelector("#location-label");
const typeEl = document.querySelector("#types");
const organizeSelect = document.querySelector("#organize");
const zipInput = document.querySelector("#as-zip");
const resumeSavedBtn = document.querySelector("#resume-saved");
const intro = document.querySelector("#intro");
const treeEl = document.querySelector("#tree");
const extraEl = document.querySelector("#extra");
const progressEl = document.querySelector("#progress");
const barFill = document.querySelector("#bar-fill");
const progressLabel = document.querySelector("#progress-label");
const progressCurrent = document.querySelector("#progress-current");
const errorsEl = document.querySelector("#errors");
const scanBtn = document.querySelector("#scan");
const downloadBtn = document.querySelector("#download");
const pauseBtn = document.querySelector("#pause");
const resumeBtn = document.querySelector("#resume");
const cancelBtn = document.querySelector("#cancel");

let scan = null;
let scanning = false;
let courseTabId = null;
let customFolder = false;
let busy = false;
let savedResume = null;
let rememberTimer = 0;

function sanitize(input, max = 100) {
  let text = String(input ?? "").replace(/[\u0000-\u001f]/g, " ");
  text = text.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/[. ]+$/g, "");
  if (!text || text === "." || text === "..") text = "D2L Course";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = `_${text}`;
  if (text.length > max) text = text.slice(0, max).replace(/[. ]+$/g, "");
  return text || "D2L Course";
}

function setStatus(text) {
  statusEl.hidden = false;
  statusEl.textContent = text;
}

function folderName() {
  return sanitize(folderInput.value, 100);
}

function visibleFiles() {
  if (!scan?.ok) return [];
  return scan.files.filter((file) => hiddenInput.checked || !file.hidden);
}

function fileExtension(file) {
  const name = String(file?.filename || "").split("/").pop() || "";
  const match = name.match(/\.([a-z0-9]{1,8})$/i);
  if (!match) return "other";
  const ext = match[1].toLowerCase();
  if (ext === "jpg") return "jpeg";
  if (ext === "htm") return "html";
  return ext;
}

function typeLabel(ext) {
  return ext === "other" ? "Other" : ext.toUpperCase();
}

function chosenFiles() {
  return visibleFiles().filter((file) => file.selected !== false);
}

function selectedLinks() {
  if (!scan?.ok) return [];
  return scan.links.filter((link) => (hiddenInput.checked || !link.hidden) && link.selected !== false);
}

function relativePath(filename) {
  const prefix = `${scan.courseFolder}/`;
  return filename.startsWith(prefix) ? filename.slice(prefix.length) : filename;
}

function outputPath(filename) {
  const relative = relativePath(filename);
  return relative ? `${folderName()}/${relative}` : folderName();
}

function uniquePath(used, path, hint) {
  const key = path.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const note = sanitize(hint || "copy", 40);
  let n = 2;
  let candidate = `${dir ? `${dir}/` : ""}${stem} - ${note}${ext}`;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${dir ? `${dir}/` : ""}${stem} - ${note} (${n})${ext}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function organizedPath(file, used) {
  const course = folderName();
  const leaf = fileLeaf({ label: file.label, filename: file.leaf || file.filename, url: file.url });
  const mode = organizeSelect.value;
  let path;
  if (mode === "course") path = `${course}/${leaf}`;
  else if (mode === "topic") {
    const parts = [course, file.module, file.topic].filter(Boolean);
    path = `${parts.join("/")}/${leaf}`;
  } else {
    const current = String(file.filename || "");
    const slash = current.lastIndexOf("/");
    const dir = slash >= 0 ? current.slice(0, slash) : "";
    path = outputPath(dir ? `${dir}/${leaf}` : leaf);
  }
  return uniquePath(used, safeRelativePath(path), file.module || file.topic || "");
}

function tally(downloadState) {
  const parts = [];
  if (downloadState.downloaded) parts.push(`${downloadState.downloaded} downloaded`);
  if (downloadState.skipped) parts.push(`${downloadState.skipped} already saved`);
  if (downloadState.shortened) parts.push(`${downloadState.shortened} saved with a shorter path`);
  if (downloadState.failed) parts.push(`${downloadState.failed} failed`);
  return parts.join(", ");
}

function outputFolder(folder) {
  if (!folder || folder === scan.courseFolder) return folderName();
  const prefix = `${scan.courseFolder}/`;
  const relative = folder.startsWith(prefix) ? folder.slice(prefix.length) : folder;
  return `${folderName()}/${relative}`;
}

function ensureFolder(root, folder) {
  const parts = relativePath(folder).split("/").filter(Boolean);
  let node = root;
  for (const part of parts) {
    if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
    node = node.dirs.get(part);
  }
  return node;
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const entry of scan.folders || []) {
    const folder = typeof entry === "string" ? entry : entry.folder;
    const hidden = typeof entry === "string" ? false : entry.hidden;
    if (!folder || (!hiddenInput.checked && hidden)) continue;
    ensureFolder(root, folder);
  }
  const entries = [
    ...files,
    ...(scan.links || []).filter((link) => hiddenInput.checked || !link.hidden).map((link) => ({
      kind: "link",
      selected: link.selected !== false,
      filename: link.filename || `${link.folder}/${link.title}`,
      label: link.title,
      linkRef: link,
      hidden: link.hidden,
    })),
  ];
  for (const file of entries) {
    const parts = relativePath(file.filename).split("/").filter(Boolean);
    const name = parts.pop() || file.label || "file";
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    const shown = file.kind === "link"
      ? `${name} (link)`
      : fileLeaf({ label: file.label, filename: file.leaf || name, url: file.url });
    node.files.push({ file, name: shown });
  }
  return root;
}

function renderNodes(node, container) {
  for (const dir of node.dirs.values()) {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "folder";
    const label = document.createElement("span");
    label.textContent = dir.name;
    summary.append(box, label);
    details.append(summary);
    renderNodes(dir, details);
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => {
      const files = [...details.querySelectorAll("input.file")];
      const next = files.some((input) => !input.checked);
      for (const input of files) {
        input.checked = next;
        input.fileRef.selected = next;
        if (input.fileRef.linkRef) input.fileRef.linkRef.selected = next;
      }
      syncChecks(treeEl);
      updateSummary();
    });
    container.append(details);
  }

  if (!node.files.length) return;
  const list = document.createElement("ul");
  for (const entry of node.files) {
    const item = document.createElement("li");
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "file";
    box.checked = entry.file.selected !== false;
    box.fileRef = entry.file;
    box.addEventListener("change", () => {
      entry.file.selected = box.checked;
      if (entry.file.linkRef) entry.file.linkRef.selected = box.checked;
      syncChecks(treeEl);
      updateSummary();
    });
    const name = document.createElement("span");
    name.textContent = entry.name;
    row.append(box, name);
    item.append(row);
    list.append(item);
  }
  container.append(list);
}

function syncChecks(container) {
  for (const detail of container.querySelectorAll(":scope > details")) {
    syncChecks(detail);
    const box = detail.querySelector(":scope > summary input");
    const files = [...detail.querySelectorAll("input.file")];
    const selected = files.filter((input) => input.checked).length;
    if (!box) continue;
    box.checked = files.length > 0 && selected === files.length;
    box.indeterminate = selected > 0 && selected < files.length;
  }
}

function syncTypeChecks() {
  for (const input of typeEl.querySelectorAll("input")) {
    const files = visibleFiles().filter((file) => fileExtension(file) === input.dataset.ext);
    const selected = files.filter((file) => file.selected !== false).length;
    input.checked = files.length > 0 && selected === files.length;
    input.indeterminate = selected > 0 && selected < files.length;
  }
}

function renderTypes() {
  const counts = new Map();
  for (const file of visibleFiles()) {
    const ext = fileExtension(file);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const types = [...counts.entries()].sort((a, b) => b[1] - a[1] || typeLabel(a[0]).localeCompare(typeLabel(b[0])));
  typeEl.replaceChildren();
  for (const [ext, count] of types) {
    const label = document.createElement("label");
    label.className = "chip";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.ext = ext;
    box.addEventListener("change", () => {
      for (const file of scan.files) {
        if (fileExtension(file) === ext) file.selected = box.checked;
      }
      for (const input of treeEl.querySelectorAll("input.file")) {
        if (fileExtension(input.fileRef) === ext) input.checked = box.checked;
      }
      syncChecks(treeEl);
      updateSummary();
    });
    const name = document.createElement("span");
    name.textContent = typeLabel(ext);
    const total = document.createElement("span");
    total.className = "count";
    total.textContent = String(count);
    label.append(box, name, total);
    typeEl.append(label);
  }
  syncTypeChecks();
}

function updateSummary() {
  const visible = visibleFiles();
  const chosen = chosenFiles();
  const asZip = zipInput.checked;
  summaryEl.textContent = `${chosen.length} of ${visible.length} files selected.`;
  locationLabel.textContent = asZip ? "Save the zip in" : "Save this folder in";
  downloadBtn.hidden = false;
  downloadBtn.disabled = busy || (chosen.length === 0 && selectedLinks().length === 0);
  if (asZip) downloadBtn.textContent = chosen.length ? `Download zip (${chosen.length})` : "Download links zip";
  else downloadBtn.textContent = chosen.length ? `Download ${chosen.length} files` : "Save link list";
  syncTypeChecks();
  rememberScan();
}

function renderScan() {
  folderInput.value = scan.folderName || scan.courseFolder;
  hiddenLabel.hidden = !scan.hiddenCount;
  hiddenText.textContent = `Include hidden items (${scan.hiddenCount})`;
  treeEl.replaceChildren();
  renderNodes(buildTree(visibleFiles()), treeEl);
  syncChecks(treeEl);
  renderTypes();
  const links = selectedLinks();
  const notes = [];
  if (links.length) notes.push(`${links.length} links or activities will be listed in links.txt.`);
  if (scan.skippedBroken) notes.push(`${scan.skippedBroken} broken items were skipped.`);
  if (scan.warnings?.length) notes.push(scan.warnings[0]);
  extraEl.textContent = notes.join(" ");
  updateSummary();
  resultEl.hidden = false;
  scanBtn.textContent = "Scan again";
  rememberScan();
}

function placeLabel(downloadState) {
  if (downloadState?.locationName && downloadState.locationName !== "Downloads") {
    return `${downloadState.locationName} / ${downloadState.courseName}`;
  }
  return downloadState?.courseName ? `Downloads / ${downloadState.courseName}` : "your Downloads folder";
}

function renderProgress(downloadState) {
  const active = downloadState?.running || downloadState?.done || downloadState?.interrupted || downloadState?.cancelled;
  if (!active) return;
  progressEl.hidden = false;
  const done = downloadState.completed || 0;
  const total = downloadState.total || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  barFill.style.width = `${downloadState.running ? Math.max(pct, 8) : pct}%`;
  barFill.classList.toggle("active", !!downloadState.running);
  busy = !!downloadState.running;
  pauseBtn.hidden = true;
  resumeBtn.hidden = true;
  cancelBtn.hidden = true;

  if (downloadState.running && downloadState.paused) {
    progressLabel.textContent = `Paused at ${done} of ${total}`;
    progressCurrent.textContent = downloadState.current || "Resume to continue the remaining files.";
    resumeBtn.hidden = false;
    cancelBtn.hidden = false;
  } else if (downloadState.running) {
    progressLabel.textContent = `Downloading ${done} of ${total}`;
    progressCurrent.textContent = downloadState.current || "";
    pauseBtn.hidden = false;
    cancelBtn.hidden = false;
  } else if (downloadState.cancelled) {
    const counts = tally(downloadState);
    progressLabel.textContent = downloadState.stoppedByDialog ? "Download stopped" : `Cancelled after ${done} of ${total}`;
    progressCurrent.textContent = downloadState.stoppedByDialog
      ? "Cancel on Chrome’s save dialog stops the rest. Files already saved were kept."
      : `${counts ? `${counts}. ` : ""}Files already saved were kept. Resume later for the rest.`;
  } else if (downloadState.interrupted) {
    progressLabel.textContent = "The download stopped early.";
    progressCurrent.textContent = "Files already saved were kept. Start it again for the rest.";
  } else if (downloadState.done) {
    const counts = tally(downloadState);
    progressLabel.textContent = downloadState.failed
      ? `Finished with ${downloadState.failed} problem${downloadState.failed === 1 ? "" : "s"}`
      : "Download finished";
    progressCurrent.textContent = `${counts ? `${counts}. ` : ""}Saved in ${placeLabel(downloadState)}`;
  }
  if (downloadState.done) savedResume = null;
  else if (downloadState.resume && !downloadState.running) savedResume = downloadState.resume;
  const left = remainingItems(savedResume);
  resumeSavedBtn.hidden = busy || !left.length;
  if (left.length) resumeSavedBtn.textContent = `Resume saved download (${left.length} left)`;
  if (scan?.ok) updateSummary();

  errorsEl.replaceChildren();
  for (const error of (downloadState.errors || []).slice(0, 6)) {
    const item = document.createElement("li");
    item.textContent = `${error.file.split("/").pop()}: ${error.reason}`;
    errorsEl.append(item);
  }
}

function linksFileText(links) {
  const lines = ["These items are links or activities, so they were not saved as files.", ""];
  let lastFolder = "";
  for (const link of links) {
    const folder = outputFolder(link.folder);
    if (folder !== lastFolder) {
      lines.push(folder);
      lastFolder = folder;
    }
    lines.push(`- ${link.title}${link.url ? ` — ${link.url}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function orgFromUrl(url) {
  if (!url) return "";
  const patterns = [
    /\/d2l\/home\/(\d+)/,
    /\/d2l\/le\/[^/?#]+\/(\d+)/,
    /[?&](?:ou|orgUnitId)=(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function rememberScan() {
  if (!scan?.ok) return;
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    chrome.storage.session.set({
      savedScan: {
        originOu: String(scan.originOu || scan.orgUnitId || ""),
        host: scan.host || "",
        scan,
        includeHidden: hiddenInput.checked,
        asZip: zipInput.checked,
        organize: organizeSelect.value,
      },
    });
  }, 150);
}

function remainingItems(job) {
  const done = job?.doneKeys || {};
  return (job?.items || []).filter((item) => {
    const key = item.key || itemKey(item);
    return done[key] !== "downloaded" && done[key] !== "skipped";
  });
}

async function showResume(ou) {
  const stored = await chrome.storage.local.get("resumeJob");
  const job = stored.resumeJob;
  const left = remainingItems(job);
  if (!job || !ou || String(job.orgUnitId) !== String(ou) || !left.length) {
    savedResume = null;
    resumeSavedBtn.hidden = true;
    return;
  }
  savedResume = job;
  resumeSavedBtn.hidden = busy;
  resumeSavedBtn.textContent = `Resume saved download (${left.length} left)`;
}

function showSaveLocation(name) {
  customFolder = !!name;
  locationNameEl.textContent = name || "Downloads";
  downloadsBtn.hidden = !name;
}

async function refreshDestination() {
  showSaveLocation(await destinationName());
}

function setChosen(selected) {
  for (const file of visibleFiles()) file.selected = selected;
  for (const link of scan?.links || []) {
    if (hiddenInput.checked || !link.hidden) link.selected = selected;
  }
  renderScan();
}

async function runScan() {
  scanBtn.disabled = true;
  scanning = true;
  downloadBtn.hidden = true;
  resultEl.hidden = true;
  setStatus("Scanning the course outline…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("No active tab to scan.");
      return;
    }
    if (tab.url && !/^https?:/i.test(tab.url)) {
      setStatus("Open a Brightspace course page in this tab, then scan.");
      return;
    }
    courseTabId = tab.id;
    chrome.storage.session.set({ courseTabId: tab.id });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanCourse,
    });
    scan = injection?.result;
    if (!scan?.ok) {
      setStatus(scan?.error || "Could not read this course.");
      return;
    }
    for (const file of scan.files) if (file.selected == null) file.selected = true;
    for (const link of scan.links || []) if (link.selected == null) link.selected = true;
    scan.folderName = scan.courseFolder;
    statusEl.hidden = true;
    renderScan();
  } catch (err) {
    setStatus(err?.message || "Scan failed. Reload the course page and try again.");
  } finally {
    scanBtn.disabled = false;
    scanning = false;
  }
}

scanBtn.addEventListener("click", () => runScan());

hiddenInput.addEventListener("change", () => {
  if (scan?.ok) renderScan();
});

folderInput.addEventListener("input", () => {
  if (scan) scan.folderName = folderInput.value;
  rememberScan();
});

organizeSelect.addEventListener("change", () => {
  if (scan?.ok) rememberScan();
});

document.querySelector("#select-all").addEventListener("click", () => setChosen(true));
document.querySelector("#select-none").addEventListener("click", () => setChosen(false));
zipInput.addEventListener("change", () => {
  if (scan?.ok) updateSummary();
});

document.querySelector("#open-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});

document.querySelector("#intro-done").addEventListener("click", () => {
  chrome.storage.local.set({ introSeen: true });
  intro.close();
});

chooseBtn.addEventListener("click", async () => {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("picker.html"),
      type: "normal",
      width: 480,
      height: 360,
      focused: true,
    });
  } catch (err) {
    setStatus(err?.message || "Could not open the folder picker.");
  }
});

downloadsBtn.addEventListener("click", async () => {
  await clearDestination();
  customFolder = false;
  locationNameEl.textContent = "Downloads";
  downloadsBtn.hidden = true;
});

function buildItems() {
  const name = folderName();
  const used = new Set();
  const items = chosenFiles().map((file) => ({
    url: file.url,
    filename: organizedPath(file, used),
    key: itemKey(file),
  }));
  const links = selectedLinks();
  if (links.length) {
    items.push({
      text: linksFileText(links),
      filename: `${name}/links.txt`,
      key: `text:${name}/links.txt`,
    });
  }
  return items;
}

async function startDownload(extra = {}) {
  if (!scan?.ok && !extra.items) return;
  const name = folderName();
  if (scan) {
    folderInput.value = name;
    scan.folderName = name;
  }
  const items = extra.items || buildItems();
  if (!items.length) return;
  downloadBtn.disabled = true;
  resumeSavedBtn.hidden = true;
  progressEl.hidden = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START",
      courseName: extra.courseName || name,
      items,
      tabId: courseTabId,
      useDestination: extra.useDestination ?? customFolder,
      asZip: extra.asZip ?? zipInput.checked,
      orgUnitId: extra.orgUnitId || scan?.originOu || scan?.orgUnitId || "",
      prior: extra.prior || {},
      doneKeys: extra.doneKeys || {},
    });
    if (!response?.ok) setStatus(response?.error || "Could not start the download.");
  } catch (err) {
    setStatus(err?.message || "Could not use that folder.");
    downloadBtn.disabled = false;
  }
}

downloadBtn.addEventListener("click", () => startDownload());

resumeSavedBtn.addEventListener("click", () => {
  if (!savedResume) return;
  const left = remainingItems(savedResume);
  startDownload({
    items: left,
    courseName: savedResume.courseName,
    useDestination: !!savedResume.useDestination,
    asZip: !!savedResume.asZip,
    orgUnitId: savedResume.orgUnitId,
    doneKeys: savedResume.doneKeys || {},
    prior: {
      completed: (savedResume.downloaded || 0) + (savedResume.skipped || 0),
      downloaded: savedResume.downloaded || 0,
      skipped: savedResume.skipped || 0,
      failed: 0,
    },
  });
});

pauseBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "PAUSE" }));
resumeBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "RESUME" }));
cancelBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "CANCEL" }));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_STATUS" && scanning && message.text) setStatus(message.text);
  if (message?.type === "PROGRESS") renderProgress(message.state);
  if (message?.type === "DESTINATION") showSaveLocation(message.name || "");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.destinationName) showSaveLocation(changes.destinationName.newValue || "");
});

chrome.storage.session.get("courseTabId").then(({ courseTabId: saved }) => {
  if (saved) courseTabId = saved;
});
refreshDestination();

async function restoreIfSameCourse() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  courseTabId = tab.id;
  const ou = orgFromUrl(tab.url);
  let host = "";
  try {
    host = new URL(tab.url).host;
  } catch {
    host = "";
  }
  const stored = await chrome.storage.session.get("savedScan");
  const saved = stored.savedScan;
  const sameHost = !saved?.host || !host || saved.host === host;
  const sameCourse = !!(ou && saved?.originOu && sameHost && String(saved.originOu) === String(ou));
  if (saved?.scan?.ok && sameCourse) {
    scan = saved.scan;
    hiddenInput.checked = saved.includeHidden !== false;
    zipInput.checked = !!saved.asZip;
    organizeSelect.value = saved.organize || "module";
    statusEl.hidden = true;
    renderScan();
  } else if (saved) {
    chrome.storage.session.remove("savedScan");
  }
  await showResume(ou);
}

restoreIfSameCourse();
chrome.storage.local.get("introSeen").then(({ introSeen }) => {
  if (!introSeen) intro.showModal();
});
chrome.runtime.sendMessage({ type: "GET_STATE" }, (downloadState) => {
  if (chrome.runtime.lastError) return;
  renderProgress(downloadState);
});
