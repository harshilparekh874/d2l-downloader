import { loadDestination } from "./handles.js";
import { writeBytes } from "./folder-save.js";
import { createZipWriter } from "./zip.js";

let running = false;
let paused = false;
let cancelled = false;
let abortCurrent = null;
let zipSavedWait = null;

function finishZipWait(reason) {
  const resolve = zipSavedWait;
  zipSavedWait = null;
  resolve?.(reason || "");
}

const port = chrome.runtime.connect({ name: "offscreen" });

port.onMessage.addListener((msg) => {
  if (msg?.type === "DOWNLOAD") startJob(msg);
  if (msg?.type === "PAUSE") paused = true;
  if (msg?.type === "RESUME") paused = false;
  if (msg?.type === "CANCEL") {
    cancelled = true;
    abortCurrent?.abort();
    finishZipWait("cancelled");
  }
  if (msg?.type === "ZIP_SAVED") finishZipWait(msg.reason || "");
});

function report(downloadState) {
  try {
    port.postMessage({ type: "SAVE_PROGRESS", state: downloadState });
  } catch {
    /* The popup can close. Saving continues here. */
  }
}

async function destinationHandle(passed) {
  if (passed && typeof passed.getDirectoryHandle === "function") return passed;
  const stored = await loadDestination();
  if (stored && typeof stored.getDirectoryHandle === "function") return stored;
  return null;
}

async function fetchBytes(url, tabId) {
  const controller = new AbortController();
  abortCurrent = controller;
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (response.ok) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 0 && !isLoginPage(url, response.headers.get("content-type"), bytes)) {
        return { bytes };
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") return { error: cancelled ? "cancelled" : "Timed out" };
  } finally {
    clearTimeout(timer);
    abortCurrent = null;
  }
  if (!tabId) return { error: "Could not read the file from Brightspace." };
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url],
      func: async (fileUrl) => {
        try {
          const headers = { "X-Requested-With": "XMLHttpRequest" };
          const match = document.cookie.match(/(?:^|;\s*)d2lSecureSessionVal=([^;]+)/);
          if (match) headers["X-Csrf-Token"] = decodeURIComponent(match[1]);
          const response = await fetch(fileUrl, { credentials: "include", headers });
          if (!response.ok) return { error: `HTTP ${response.status}` };
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          return { base64: btoa(binary) };
        } catch (err) {
          return { error: err?.message || "Could not download the file." };
        }
      },
    });
    const result = injected?.result;
    if (result?.error) return result;
    if (!result?.base64) return { error: "The course tab didn't return the file." };
    const raw = atob(result.base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    if (isLoginPage(url, "text/html", bytes)) return { error: "Brightspace returned a page instead of the file." };
    return { bytes: bytes.buffer };
  } catch (err) {
    return { error: err?.message || "Could not read the file from the course tab." };
  }
}

function isLoginPage(url, contentType, bytes) {
  if (/\.html?($|\?)/i.test(url)) return false;
  if (contentType && !/text\/html/i.test(contentType)) return false;
  const head = new TextDecoder().decode(bytes.slice(0, 240)).trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function saveToFolder(handle, tabId, item) {
  if (item.text != null) {
    await writeBytes(handle, item.filename, item.text);
    return "";
  }
  const fetched = await fetchBytes(item.url, tabId);
  if (fetched.error) return fetched.error;
  if (!fetched.bytes || fetched.bytes.byteLength === 0) return "The file came back empty.";
  await writeBytes(handle, item.filename, fetched.bytes);
  return "";
}

async function openZipSink(handle, courseName) {
  const zipName = `${courseName || "Course"}.zip`;
  if (handle) {
    const fileHandle = await handle.getFileHandle(zipName, { create: true });
    return {
      sink: await fileHandle.createWritable(),
      discard: () => handle.removeEntry(zipName).catch(() => {}),
    };
  }
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle("d2l-course.zip", { create: true });
  return {
    sink: await fileHandle.createWritable(),
    handoff: true,
    discard: () => root.removeEntry("d2l-course.zip").catch(() => {}),
  };
}

async function runZip(message, handle, items, downloadState) {
  downloadState.total = items.length + 1;
  report(downloadState);
  const zipName = `${message.courseName || "Course"}.zip`;
  let opened;
  try {
    opened = await openZipSink(handle, message.courseName);
  } catch (err) {
    downloadState.running = false;
    downloadState.done = true;
    downloadState.failed = 1;
    downloadState.current = "";
    downloadState.errors = [{ file: zipName, reason: err?.message || "Could not create the zip." }];
    running = false;
    report(downloadState);
    return;
  }

  const zip = createZipWriter(opened.sink);
  let added = 0;
  for (const item of items) {
    while (paused && !cancelled) {
      downloadState.paused = true;
      downloadState.current = "Paused. You can click away. Resume when you want the rest.";
      report(downloadState);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (cancelled) break;
    downloadState.paused = false;
    downloadState.current = item.filename;
    report(downloadState);
    let reason = "";
    try {
      let bytes = null;
      if (item.text != null) bytes = new TextEncoder().encode(item.text);
      else {
        const fetched = await fetchBytes(item.url, message.tabId);
        if (fetched.error) reason = fetched.error;
        else if (!fetched.bytes || fetched.bytes.byteLength === 0) reason = "The file came back empty.";
        else bytes = new Uint8Array(fetched.bytes);
      }
      if (!reason && bytes) {
        await zip.add(item.filename, bytes);
        added += 1;
      }
    } catch (err) {
      reason = err?.message || "Could not add the file.";
    }
    if (cancelled || reason === "cancelled") {
      cancelled = true;
      break;
    }
    if (reason) {
      downloadState.failed += 1;
      if (downloadState.errors.length < 50) downloadState.errors.push({ file: item.filename, reason });
    }
    downloadState.completed += 1;
    report(downloadState);
  }

  if (cancelled || added === 0) {
    await zip.abort()?.catch(() => {});
    await opened.discard();
    downloadState.running = false;
    downloadState.paused = false;
    downloadState.cancelled = cancelled;
    downloadState.done = !cancelled;
    downloadState.current = cancelled ? "" : "Nothing could be saved into the zip.";
    running = false;
    report(downloadState);
    return;
  }

  downloadState.current = "Saving the zip…";
  report(downloadState);
  let saveReason = "";
  try {
    await zip.close();
    if (opened.handoff) {
      port.postMessage({ type: "ZIP_READY", filename: zipName });
      saveReason = await new Promise((resolve) => {
        zipSavedWait = resolve;
      });
    }
  } catch (err) {
    saveReason = err?.message || "Could not finish the zip.";
    await opened.discard();
  }

  if (saveReason === "USER_CANCELED") {
    cancelled = true;
    downloadState.stoppedByDialog = true;
  } else if (saveReason === "cancelled") {
    cancelled = true;
  } else if (saveReason) {
    downloadState.failed += 1;
    if (downloadState.errors.length < 50) downloadState.errors.push({ file: zipName, reason: saveReason });
  } else {
    downloadState.completed += 1;
  }

  downloadState.running = false;
  downloadState.paused = false;
  downloadState.cancelled = cancelled;
  downloadState.done = !cancelled;
  downloadState.current = "";
  running = false;
  report(downloadState);
}

async function startJob(message) {
  if (running) return;
  running = true;
  paused = false;
  cancelled = false;
  const items = Array.isArray(message.items) ? message.items : [];
  const handle = message.useDestination ? await destinationHandle(message.handle) : null;
  const downloadState = {
    running: true,
    paused: false,
    cancelled: false,
    interrupted: false,
    done: false,
    total: items.length,
    completed: 0,
    failed: 0,
    current: "Starting…",
    courseName: message.courseName || "",
    locationName: handle?.name || "Downloads",
    stoppedByDialog: false,
    errors: [],
  };

  if (message.useDestination && !handle) {
    downloadState.running = false;
    downloadState.done = true;
    downloadState.failed = 1;
    downloadState.current = "Choose the folder again, then download.";
    downloadState.errors = [{ file: "Folder", reason: "No save folder is selected." }];
    running = false;
    report(downloadState);
    return;
  }

  report(downloadState);

  if (message.asZip) {
    try {
      await runZip(message, handle, items, downloadState);
    } catch (err) {
      downloadState.running = false;
      downloadState.done = true;
      downloadState.failed += 1;
      downloadState.current = "";
      if (downloadState.errors.length < 50) {
        downloadState.errors.push({ file: "Zip", reason: err?.message || "Could not create the zip." });
      }
      running = false;
      report(downloadState);
    }
    return;
  }

  for (let index = 0; index < items.length; index += 1) {
    while (paused && !cancelled) {
      downloadState.paused = true;
      downloadState.current = "Paused. You can click away. Resume when you want the rest.";
      report(downloadState);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (cancelled) break;
    const item = items[index];
    downloadState.paused = false;
    downloadState.current = item.filename;
    report(downloadState);
    let reason = "";
    try {
      if (!handle) reason = "Choose a folder, then download again.";
      else reason = await saveToFolder(handle, message.tabId, item);
    } catch (err) {
      reason = err?.message || "Could not save the file.";
    }
    if (reason === "USER_CANCELED") {
      cancelled = true;
      downloadState.stoppedByDialog = true;
      break;
    }
    if (cancelled || reason === "cancelled") break;
    if (reason) {
      downloadState.failed += 1;
      if (downloadState.errors.length < 50) downloadState.errors.push({ file: item.filename, reason });
    }
    downloadState.completed += 1;
    report(downloadState);
  }

  downloadState.running = false;
  downloadState.paused = false;
  downloadState.cancelled = cancelled;
  downloadState.done = !cancelled;
  downloadState.current = "";
  running = false;
  report(downloadState);
}
