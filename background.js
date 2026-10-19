import { decideSave, itemKey, rememberFile, statDownload } from "./catalog.js";
import { pathAttempts } from "./paths.js";

const idleState = () => ({
  running: false,
  paused: false,
  cancelled: false,
  interrupted: false,
  done: false,
  total: 0,
  completed: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  doneKeys: {},
  resume: null,
  current: "",
  courseName: "",
  locationName: "Downloads",
  stoppedByDialog: false,
  errors: [],
  shortened: 0,
});

const SAVE_HINT = "Cancel Chrome’s save dialog to stop the whole download.";

let state = idleState();
let jobEpoch = 0;
let filePort = null;
let portClosed = false;
let portPromise = null;
let nextFileId = 1;
const pending = new Map();
const resumeWaiters = [];
const streams = new Set();
let saverPort = null;
let offscreenPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "saver") {
    saverPort = port;
    port.onDisconnect.addListener(() => {
      if (saverPort === port) saverPort = null;
    });
    port.onMessage.addListener((msg) => {
      if (msg?.type !== "SAVE_PROGRESS" || !msg.state) return;
      state = { ...idleState(), ...msg.state };
      persist();
    });
    return;
  }
  if (port.name !== "offscreen") return;
  offscreenPort = port;
  port.onDisconnect.addListener(() => {
    if (offscreenPort === port) offscreenPort = null;
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type === "SAVE_PROGRESS" && msg.state) {
      state = { ...idleState(), ...msg.state };
      persist();
      return;
    }
    if (msg?.type !== "ZIP_READY") return;
    saveZipDownload(msg.filename || "course.zip")
      .then((reason) => {
        try {
          offscreenPort?.postMessage({ type: "ZIP_SAVED", reason: reason || "" });
        } catch {
          /* The zip was already written. */
        }
      })
      .catch((err) => {
        try {
          offscreenPort?.postMessage({ type: "ZIP_SAVED", reason: err?.message || "Could not save the zip." });
        } catch {
          /* The zip was already written. */
        }
      });
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  const entry = pending.get(delta.id);
  if (!entry || !delta.state) return;
  if (delta.state.current === "interrupted" && state.paused && !state.cancelled) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    pending.delete(delta.id);
    entry.finish(delta.state.current === "complete" ? "" : delta.error?.current || "interrupted");
  }
});

function persist() {
  chrome.storage.session.set({ downloadState: state });
  chrome.runtime.sendMessage({ type: "PROGRESS", state }).catch(() => {});
  if (state.resume?.items?.length && !state.done) chrome.storage.local.set({ resumeJob: state.resume });
  else if (state.done) chrome.storage.local.remove("resumeJob");
}

function wake() {
  const waiters = resumeWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

async function gate() {
  while (state.paused && !state.cancelled) {
    await new Promise((resolve) => resumeWaiters.push(resolve));
  }
}

function isPathError(reason) {
  return /could not be found|FILE_NAME_TOO_LONG/i.test(String(reason || ""));
}

async function saveChromeDownload(item) {
  const attempts = pathAttempts(item.filename);
  let reason = "";
  let used = attempts[0] || "file";
  for (let i = 0; i < attempts.length; i++) {
    used = attempts[i];
    reason = await downloadItem({
      ...item,
      filename: used,
      conflictAction: item.conflictAction || "uniquify",
    });
    if (!reason || reason === "USER_CANCELED" || reason === "cancelled" || state.cancelled) {
      return { reason, filename: used, shortened: i > 0 && !reason };
    }
    if (!isPathError(reason) || i === attempts.length - 1) break;
  }
  if (isPathError(reason)) {
    reason = "Windows couldn't save this file. Shorten the course folder name, or choose a folder closer to the drive, like Downloads.";
  }
  return { reason, filename: used, shortened: false };
}

function downloadItem(item) {
  return new Promise((resolve) => {
    let objectUrl = "";
    const options = {
      filename: item.filename,
      conflictAction: item.conflictAction || "uniquify",
      saveAs: false,
    };

    if (item.text != null) {
      options.url = `data:text/plain;charset=utf-8,${encodeURIComponent(item.text)}`;
    } else {
      options.url = item.url;
    }

    chrome.downloads.download(options, (id) => {
      const startError = chrome.runtime.lastError?.message;
      if (startError || id == null) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(startError || "Chrome did not start the download.");
        return;
      }

      let emptyTicks = 0;
      const promptTimer = setInterval(async () => {
        const [download] = await chrome.downloads.search({ id });
        if (!download || download.state !== "in_progress") return;
        if (download.filename) {
          emptyTicks = 0;
          if (state.current === SAVE_HINT) {
            state.current = item.filename;
            persist();
          }
          return;
        }
        emptyTicks += 1;
        if (emptyTicks >= 2 && state.current !== SAVE_HINT) {
          state.current = SAVE_HINT;
          persist();
        }
      }, 350);

      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearInterval(promptTimer);
        resolve("timed out");
      }, 15 * 60 * 1000);

      pending.set(id, {
        finish(reason) {
          clearTimeout(timeout);
          clearInterval(promptTimer);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          if (state.current === SAVE_HINT) state.current = item.filename;
          resolve(state.cancelled ? "cancelled" : reason);
        },
      });
    });
  });
}

async function ensurePort(tabId) {
  if (filePort && !portClosed) return;
  if (!portPromise) {
    portPromise = connectPort(tabId).finally(() => {
      portPromise = null;
    });
  }
  await portPromise;
}

async function connectPort(tabId) {
  if (!tabId) throw new Error("Open the Brightspace course tab, then resume.");
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["fetch-bridge.js"],
  });
  const port = chrome.tabs.connect(tabId, { name: "d2l-file" });
  filePort = port;
  portClosed = false;
  port.onDisconnect.addListener(() => {
    if (filePort !== port) return;
    portClosed = true;
    filePort = null;
    for (const finish of [...streams]) finish("tab-closed");
    if (state.running && !state.cancelled) {
      state.paused = true;
      state.current = "Course tab closed. Reopen the course, then resume.";
      persist();
    }
  });
}

async function pathToFile(root, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  let name = filename;
  let n = 2;
  for (;;) {
    try {
      await dir.getFileHandle(name);
      const dot = filename.lastIndexOf(".");
      name = dot > 0 ? `${filename.slice(0, dot)} (${n})${filename.slice(dot)}` : `${filename} (${n})`;
      n += 1;
    } catch (err) {
      if (err?.name !== "NotFoundError") throw err;
      const handle = await dir.getFileHandle(name, { create: true });
      return { dir, name, handle };
    }
  }
}

function streamUrl(port, url, writable) {
  const id = nextFileId++;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      streams.delete(finish);
      port.onMessage.removeListener(onMessage);
      resolve(reason);
    };
    streams.add(finish);
    const onMessage = async (msg) => {
      if (msg.id !== id) return;
      if (msg.type === "chunk") {
        try {
          await writable.write(msg.bytes);
          port.postMessage({ type: "ack", id });
        } catch (err) {
          try { port.postMessage({ type: "abort", id }); } catch { /* Port closed. */ }
          finish(err?.message || "Could not write the file.");
        }
        return;
      }
      if (msg.type === "end") finish("");
      if (msg.type === "error") {
        if (msg.reason === "cancelled" && !state.cancelled) finish("tab-closed");
        else finish(msg.reason === "cancelled" ? "cancelled" : msg.reason || "Download failed");
      }
    };
    port.onMessage.addListener(onMessage);
    if (portClosed) {
      finish("tab-closed");
      return;
    }
    port.postMessage({ type: "fetch", id, url });
  });
}

async function writeToDirectory(root, item, tabId) {
  let created = null;
  try {
    created = await pathToFile(root, item.filename);
    const writable = await created.handle.createWritable();
    try {
      if (item.text != null) {
        await writable.write(item.text);
        await writable.close();
        return "";
      }
      await ensurePort(tabId);
      if (!filePort) {
        await writable.abort().catch(() => {});
        await created.dir.removeEntry(created.name).catch(() => {});
        return "retry";
      }
      const reason = await streamUrl(filePort, item.url, writable);
      if (reason) {
        await writable.abort().catch(() => {});
        await created.dir.removeEntry(created.name).catch(() => {});
        return reason === "cancelled" ? "cancelled" : reason;
      }
      await writable.close();
      return "";
    } catch (err) {
      await writable.abort().catch(() => {});
      await created.dir.removeEntry(created.name).catch(() => {});
      const message = err?.message || "Could not save the file.";
      if (/tab|access|script|Receiving end|frame/i.test(message)) return "retry";
      return message;
    }
  } catch (err) {
    return err?.message || "Could not create the course folder.";
  }
}

async function ensureSaver() {
  if (saverPort) return saverPort;
  await chrome.windows.create({
    url: chrome.runtime.getURL("picker.html"),
    type: "normal",
    width: 480,
    height: 360,
    focused: true,
  });
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (saverPort || Date.now() - started > 4000) {
        clearInterval(timer);
        resolve(saverPort);
      }
    }, 50);
  });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Course files keep saving after you click away from the extension.",
    });
  }
  if (offscreenPort) return offscreenPort;
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (offscreenPort || Date.now() - started > 4000) {
        clearInterval(timer);
        resolve(offscreenPort);
      }
    }, 50);
  });
}

let activeMode = "";

async function runChromeDownloads(items, courseName, message = {}) {
  const prior = message.prior || {};
  activeMode = "chrome";
  state = {
    ...idleState(),
    running: true,
    total: items.length + (prior.completed || 0),
    completed: prior.completed || 0,
    downloaded: prior.downloaded || 0,
    skipped: prior.skipped || 0,
    failed: prior.failed || 0,
    doneKeys: { ...(message.doneKeys || {}) },
    courseName,
    locationName: "Downloads",
    current: "Starting…",
  };
  const resumeBase = () => ({
    orgUnitId: message.orgUnitId || "",
    courseName,
    items,
    doneKeys: state.doneKeys,
    downloaded: state.downloaded,
    skipped: state.skipped,
    failed: state.failed,
    useDestination: false,
    asZip: false,
  });
  state.resume = resumeBase();
  persist();

  const queue = items.slice();
  while (!state.cancelled) {
    await gate();
    if (state.cancelled) break;
    if (state.paused) continue;
    const item = queue.shift();
    if (!item) break;
    state.current = item.filename;
    persist();
    let choice = { action: "write", filename: item.filename };
    if (item.text == null) {
      try {
        choice = await decideSave(item, (path) => statDownload(path));
      } catch {
        choice = { action: "write", filename: item.filename };
      }
    }
    if (choice.action === "skip") {
      state.skipped += 1;
      state.doneKeys[itemKey(item)] = "skipped";
      state.completed += 1;
      state.resume = resumeBase();
      persist();
      continue;
    }
    const saved = await saveChromeDownload({
      ...item,
      filename: choice.filename || item.filename,
      conflictAction: choice.update ? "overwrite" : "uniquify",
    });
    if (saved.reason === "USER_CANCELED") {
      state.cancelled = true;
      state.stoppedByDialog = true;
      break;
    }
    if (state.cancelled || saved.reason === "cancelled") break;
    if (saved.reason) {
      state.failed += 1;
      if (state.errors.length < 50) state.errors.push({ file: item.filename, reason: saved.reason });
    } else {
      state.downloaded += 1;
      if (saved.shortened) state.shortened += 1;
      state.doneKeys[itemKey(item)] = "downloaded";
      const onDisk = item.text == null ? await statDownload(saved.filename).catch(() => null) : null;
      await rememberFile(itemKey(item), {
        url: itemKey(item),
        path: saved.filename,
        size: onDisk?.size ?? choice.facts?.size ?? (item.text != null ? item.text.length : null),
        etag: choice.facts?.etag || "",
        modified: choice.facts?.modified || "",
      });
    }
    state.completed += 1;
    state.resume = resumeBase();
    persist();
  }

  for (const id of pending.keys()) chrome.downloads.cancel(id, () => void chrome.runtime.lastError);
  state.running = false;
  state.paused = false;
  state.done = !state.cancelled;
  state.current = "";
  state.resume = state.done ? null : resumeBase();
  activeMode = "";
  persist();
  return { ok: true };
}

async function saveZipDownload(filename) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle("d2l-course.zip");
  const file = await fileHandle.getFile();
  const url = URL.createObjectURL(file);
  try {
    return await downloadItem({ url, filename });
  } finally {
    URL.revokeObjectURL(url);
    await root.removeEntry("d2l-course.zip").catch(() => {});
  }
}

async function startDownloads(message) {
  if (state.running) return { ok: false, error: "A download is already running." };
  jobEpoch += 1;
  const items = Array.isArray(message.items) ? message.items : [];
  await ensureOffscreen().catch(() => null);

  if (message.useDestination) {
    const saver = await ensureSaver();
    if (!saver) return { ok: false, error: "Could not open the folder window. Choose the folder, then download again." };
    activeMode = "folder";
    const stored = await chrome.storage.local.get("destinationName");
    state = {
      ...idleState(),
      running: true,
      total: items.length,
      current: "Starting…",
      courseName: message.courseName || "",
      locationName: stored.destinationName || "",
    };
    persist();
    saver.postMessage({
      type: "DOWNLOAD",
      items,
      tabId: message.tabId,
      courseName: message.courseName || "",
      asZip: !!message.asZip,
      orgUnitId: message.orgUnitId || "",
      prior: message.prior || {},
      doneKeys: message.doneKeys || {},
    });
    return { ok: true };
  }

  if (!message.asZip) return runChromeDownloads(items, message.courseName || "", message);

  const worker = offscreenPort;
  if (!worker) return { ok: false, error: "Could not start the downloader. Reload the extension and try again." };
  activeMode = "zip";
  state = {
    ...idleState(),
    running: true,
    total: items.length,
    current: "Starting…",
    courseName: message.courseName || "",
  };
  persist();
  worker.postMessage({
    type: "DOWNLOAD",
    items,
    tabId: message.tabId,
    courseName: message.courseName || "",
    useDestination: false,
    asZip: true,
  });
  return { ok: true };
}

function controlDownload(type) {
  const target = activeMode === "folder" ? saverPort : offscreenPort;
  try {
    target?.postMessage({ type });
  } catch {
    /* Files already saved stay in the folder. */
  }
}

function pauseDownloads() {
  state.paused = true;
  for (const id of pending.keys()) chrome.downloads.pause(id, () => void chrome.runtime.lastError);
  if (activeMode === "chrome") {
    persist();
    return;
  }
  controlDownload("PAUSE");
}

function resumeDownloads() {
  state.paused = false;
  for (const id of pending.keys()) chrome.downloads.resume(id, () => void chrome.runtime.lastError);
  if (activeMode === "chrome") {
    wake();
    persist();
    return;
  }
  controlDownload("RESUME");
}

function cancelDownloads() {
  state.cancelled = true;
  state.paused = false;
  wake();
  for (const id of pending.keys()) chrome.downloads.cancel(id, () => void chrome.runtime.lastError);
  if (activeMode === "chrome") {
    persist();
    return;
  }
  controlDownload("CANCEL");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START") {
    startDownloads(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || "Download failed." }));
    return true;
  }
  if (message?.type === "PAUSE") {
    pauseDownloads();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "RESUME") {
    resumeDownloads();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "CANCEL") {
    cancelDownloads();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_STATE") {
    sendResponse(state);
    return false;
  }
  return false;
});
