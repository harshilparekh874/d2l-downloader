import { loadDestination, saveDestination } from "./handles.js";
import { isDirectoryHandle, runFolderJob } from "./folder-save.js";

const note = document.querySelector("#note");
const pickBtn = document.querySelector("#pick");

let directoryHandle = null;
let pendingJob = null;
let running = false;
let paused = false;
let cancelled = false;
let abortCurrent = null;

const port = chrome.runtime.connect({ name: "saver" });

port.onMessage.addListener((msg) => {
  if (msg?.type === "PAUSE") paused = true;
  if (msg?.type === "RESUME") paused = false;
  if (msg?.type === "CANCEL") {
    cancelled = true;
    abortCurrent?.abort();
  }
  if (msg?.type === "DOWNLOAD") beginJob(msg);
});

function report(downloadState) {
  try {
    port.postMessage({ type: "SAVE_PROGRESS", state: downloadState });
  } catch {
    /* The popup can close. Saving continues in this window. */
  }
}

async function remember(handle) {
  if (!isDirectoryHandle(handle)) return null;
  directoryHandle = handle;
  return handle;
}

async function resolveHandle() {
  if (isDirectoryHandle(directoryHandle)) return directoryHandle;
  return remember(await loadDestination());
}

async function beginJob(message) {
  if (running) return;
  pendingJob = message;
  const handle = await resolveHandle();
  if (!handle) {
    note.textContent = "Choose the folder again. Saving starts as soon as you do.";
    const win = await chrome.windows.getCurrent();
    chrome.windows.update(win.id, { focused: true });
    return;
  }
  await run(message, handle);
}

async function run(message, handle) {
  if (running) return;
  running = true;
  paused = false;
  cancelled = false;
  note.textContent = `Saving in ${handle.name}. You can click away. Leave this window open until it finishes.`;
  try {
    const result = await runFolderJob({
      handle,
      items: Array.isArray(message.items) ? message.items : [],
      tabId: message.tabId,
      courseName: message.courseName || "",
      asZip: !!message.asZip,
      hooks: {
        report,
        orgUnitId: message.orgUnitId || "",
        prior: message.prior || {},
        doneKeys: message.doneKeys || {},
        paused: () => paused,
        cancelled: () => cancelled,
        setAbort: (controller) => {
          abortCurrent = controller;
        },
      },
    });
    const blocked = result?.errors?.some((error) => error.reason === "Choose the folder again, then download.");
    if (blocked) {
      pendingJob = message;
      note.textContent = "Choose the folder again. Saving starts as soon as you do.";
      return;
    }
    pendingJob = null;
    note.textContent = cancelled
      ? "Saving stopped. Files already written were kept."
      : `Finished saving in ${handle.name}.`;
  } catch (err) {
    note.textContent = err?.message || "Could not save in that folder.";
    report({
      running: false,
      done: true,
      failed: 1,
      courseName: message.courseName || "",
      locationName: handle.name,
      current: "",
      errors: [{ file: "Folder", reason: err?.message || "Could not save in that folder." }],
    });
  } finally {
    running = false;
    abortCurrent = null;
  }
}

pickBtn.addEventListener("click", async () => {
  try {
    const picked = await window.showDirectoryPicker({
      id: "d2l-course-destination",
      mode: "readwrite",
      startIn: "downloads",
    });
    await saveDestination(picked);
    await remember(picked);
    note.textContent = `Using ${picked.name}. You can click away. Leave this window open while files are saving.`;
    if (pendingJob && !running) await run(pendingJob, picked);
  } catch (err) {
    if (err?.name === "AbortError") return;
    note.textContent = err?.message || "Chrome didn't allow that folder.";
  }
});

resolveHandle().then((handle) => {
  if (handle) note.textContent = `Using ${handle.name}. You can click away or close this window until you start a download.`;
});
