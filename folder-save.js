import { createZipWriter } from "./zip.js";
import { decideSave, itemKey, rememberFile, statDirectory } from "./catalog.js";
import { limitFileName, pathAttempts } from "./paths.js";

export function isDirectoryHandle(handle) {
  return !!handle && typeof handle.getDirectoryHandle === "function" && typeof handle.getFileHandle === "function";
}

function isLoginPage(url, contentType, bytes) {
  if (/\.html?($|\?)/i.test(url)) return false;
  if (contentType && !/text\/html/i.test(contentType)) return false;
  const head = new TextDecoder().decode(bytes.slice(0, 240)).trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export async function fetchCourseFile(url, tabId, hooks) {
  const controller = new AbortController();
  hooks?.setAbort?.(controller);
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
    if (err?.name === "AbortError") return { error: hooks?.cancelled?.() ? "cancelled" : "Timed out" };
  } finally {
    clearTimeout(timer);
    hooks?.setAbort?.(null);
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

async function writeExact(root, relativePath, data) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error("Missing file name.");
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

function pathTooLong(err) {
  return err?.name === "NotFoundError" || /could not be found/i.test(err?.message || "");
}

export async function writeBytes(root, relativePath, data) {
  if (!isDirectoryHandle(root)) throw new Error("Choose the folder again, then download.");
  const attempts = pathAttempts(relativePath);
  let last;
  for (let i = 0; i < attempts.length; i++) {
    try {
      await writeExact(root, attempts[i], data);
      return { path: attempts[i], shortened: i > 0 };
    } catch (err) {
      last = err;
      if (!pathTooLong(err) || i === attempts.length - 1) break;
    }
  }
  if (pathTooLong(last)) {
    throw new Error("Windows couldn't save this file. Shorten the course folder name, or choose a folder closer to the drive, like Downloads.");
  }
  throw last;
}

function folderFailure(err) {
  const message = err?.message || "Could not save the file.";
  if (err?.name === "NotAllowedError" || /getDirectoryHandle is not a function|permission|not allowed/i.test(message)) {
    return "Choose the folder again, then download.";
  }
  return message;
}

async function waitWhilePaused(hooks, downloadState) {
  while (hooks.paused() && !hooks.cancelled()) {
    downloadState.paused = true;
    downloadState.current = "Paused. You can click away. Leave this window open, then resume.";
    hooks.report(downloadState);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function resumeSnapshot(downloadState, items) {
  return {
    orgUnitId: downloadState.orgUnitId || "",
    courseName: downloadState.courseName,
    items,
    doneKeys: downloadState.doneKeys || {},
    downloaded: downloadState.downloaded || 0,
    skipped: downloadState.skipped || 0,
    failed: downloadState.failed || 0,
    useDestination: true,
    asZip: !!downloadState.asZip,
  };
}

export async function runFolderJob({ handle, items, tabId, courseName, asZip, hooks }) {
  const prior = hooks.prior || {};
  const downloadState = {
    running: true,
    paused: false,
    cancelled: false,
    interrupted: false,
    done: false,
    total: (asZip ? items.length + 1 : items.length) + (prior.completed || 0),
    completed: prior.completed || 0,
    downloaded: prior.downloaded || 0,
    skipped: prior.skipped || 0,
    failed: prior.failed || 0,
    current: "Starting…",
    courseName: courseName || "",
    locationName: handle?.name || "",
    orgUnitId: hooks.orgUnitId || "",
    asZip: !!asZip,
    doneKeys: { ...(hooks.doneKeys || {}) },
    stoppedByDialog: false,
    errors: [],
    shortened: 0,
  };
  const hooksWithCancel = {
    ...hooks,
    cancelled: () => hooks.cancelled(),
    setAbort: (controller) => hooks.setAbort(controller),
  };
  hooks.report(downloadState);

  if (asZip) return saveZip(handle, items, tabId, courseName, downloadState, hooksWithCancel);

  for (const item of items) {
    await waitWhilePaused(hooks, downloadState);
    if (hooks.cancelled()) break;
    downloadState.paused = false;
    downloadState.current = item.filename;
    hooks.report(downloadState);
    let reason = "";
    let choice = { action: "write", filename: item.filename };
    try {
      if (item.text == null) choice = await decideSave(item, (path) => statDirectory(handle, path));
      if (choice.action === "skip") {
        downloadState.skipped += 1;
        downloadState.doneKeys[itemKey(item)] = "skipped";
        downloadState.completed += 1;
        downloadState.resume = resumeSnapshot(downloadState, items);
        hooks.report(downloadState);
        continue;
      }
      const filename = choice.filename || item.filename;
      let written = null;
      if (item.text != null) written = await writeBytes(handle, filename, item.text);
      else {
        const fetched = await fetchCourseFile(item.url, tabId, hooksWithCancel);
        if (fetched.error) reason = fetched.error;
        else if (!fetched.bytes || fetched.bytes.byteLength === 0) reason = "The file came back empty.";
        else {
          written = await writeBytes(handle, filename, fetched.bytes);
          const size = fetched.bytes.byteLength;
          await rememberFile(itemKey(item), {
            url: itemKey(item),
            path: written.path,
            size,
            etag: choice.facts?.etag || "",
            modified: choice.facts?.modified || "",
          });
        }
      }
      if (written?.shortened) downloadState.shortened += 1;
    } catch (err) {
      reason = folderFailure(err);
    }
    if (hooks.cancelled() || reason === "cancelled") break;
    if (reason === "Choose the folder again, then download.") {
      downloadState.failed += 1;
      downloadState.errors.push({ file: item.filename, reason });
      downloadState.current = reason;
      downloadState.resume = resumeSnapshot(downloadState, items);
      break;
    }
    if (reason) {
      downloadState.failed += 1;
      if (downloadState.errors.length < 50) downloadState.errors.push({ file: item.filename, reason });
    } else {
      downloadState.downloaded += 1;
      downloadState.doneKeys[itemKey(item)] = "downloaded";
    }
    downloadState.completed += 1;
    downloadState.resume = resumeSnapshot(downloadState, items);
    hooks.report(downloadState);
  }

  downloadState.running = false;
  downloadState.paused = false;
  downloadState.cancelled = hooks.cancelled();
  downloadState.done = !hooks.cancelled();
  if (downloadState.current === "Choose the folder again, then download.") {
    downloadState.done = true;
    downloadState.cancelled = false;
    downloadState.resume = null;
  } else {
    downloadState.current = "";
  }
  if (downloadState.done) downloadState.resume = null;
  else downloadState.resume = resumeSnapshot(downloadState, items);
  hooks.report(downloadState);
  return downloadState;
}

async function saveZip(handle, items, tabId, courseName, downloadState, hooks) {
  const zipName = limitFileName(`${courseName || "Course"}.zip`, 80);
  let fileHandle;
  let sink;
  try {
    fileHandle = await handle.getFileHandle(zipName, { create: true });
    sink = await fileHandle.createWritable();
  } catch (err) {
    downloadState.running = false;
    downloadState.done = true;
    downloadState.failed = 1;
    downloadState.current = "";
    downloadState.errors = [{ file: zipName, reason: folderFailure(err) }];
    hooks.report(downloadState);
    return downloadState;
  }
  const zip = createZipWriter(sink);
  let added = 0;
  for (const item of items) {
    await waitWhilePaused(hooks, downloadState);
    if (hooks.cancelled()) break;
    downloadState.paused = false;
    downloadState.current = item.filename;
    hooks.report(downloadState);
    let reason = "";
    let skipped = false;
    try {
      let bytes = null;
      const choice = item.text == null ? await decideSave(item, (path) => statDirectory(handle, path)) : { action: "write", filename: item.filename };
      const filename = choice.filename || item.filename;
      if (choice.action === "skip") {
        const existing = await statDirectory(handle, filename);
        if (existing?.file) bytes = new Uint8Array(await existing.file.arrayBuffer());
        skipped = !!bytes;
      }
      if (!bytes && item.text != null) bytes = new TextEncoder().encode(item.text);
      else if (!bytes) {
        const fetched = await fetchCourseFile(item.url, tabId, hooks);
        if (fetched.error) reason = fetched.error;
        else if (!fetched.bytes || fetched.bytes.byteLength === 0) reason = "The file came back empty.";
        else {
          bytes = new Uint8Array(fetched.bytes);
          await rememberFile(itemKey(item), {
            url: itemKey(item),
            path: filename,
            size: fetched.bytes.byteLength,
            etag: choice.facts?.etag || "",
            modified: choice.facts?.modified || "",
          });
        }
      }
      if (!reason && bytes) {
        await zip.add(filename, bytes);
        added += 1;
      }
    } catch (err) {
      reason = folderFailure(err);
    }
    if (hooks.cancelled() || reason === "cancelled") break;
    if (reason) {
      downloadState.failed += 1;
      if (downloadState.errors.length < 50) downloadState.errors.push({ file: item.filename, reason });
    } else if (skipped) {
      downloadState.skipped += 1;
      downloadState.doneKeys[itemKey(item)] = "skipped";
    } else {
      downloadState.downloaded += 1;
      downloadState.doneKeys[itemKey(item)] = "downloaded";
    }
    downloadState.completed += 1;
    downloadState.resume = resumeSnapshot(downloadState, items);
    hooks.report(downloadState);
  }

  if (hooks.cancelled() || added === 0) {
    await zip.abort()?.catch(() => {});
    await handle.removeEntry(zipName).catch(() => {});
    downloadState.running = false;
    downloadState.paused = false;
    downloadState.cancelled = hooks.cancelled();
    downloadState.done = !hooks.cancelled();
    downloadState.current = hooks.cancelled() ? "" : "Nothing could be saved into the zip.";
    downloadState.resume = hooks.cancelled() ? resumeSnapshot(downloadState, items) : null;
    hooks.report(downloadState);
    return downloadState;
  }

  downloadState.current = "Saving the zip…";
  hooks.report(downloadState);
  try {
    await zip.close();
    downloadState.completed += 1;
  } catch (err) {
    await handle.removeEntry(zipName).catch(() => {});
    downloadState.failed += 1;
    if (downloadState.errors.length < 50) downloadState.errors.push({ file: zipName, reason: folderFailure(err) });
  }
  downloadState.running = false;
  downloadState.paused = false;
  downloadState.cancelled = hooks.cancelled();
  downloadState.done = !hooks.cancelled();
  downloadState.current = "";
  downloadState.resume = downloadState.done ? null : resumeSnapshot(downloadState, items);
  hooks.report(downloadState);
  return downloadState;
}
