const DB_NAME = "d2l-downloader";
const STORE = "kv";
const KEY = "destination";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDestination(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await chrome.storage.local.set({ destinationName: handle.name });
}

export async function loadDestination() {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

export async function clearDestination() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await chrome.storage.local.remove("destinationName");
}

export async function destinationName() {
  const stored = await chrome.storage.local.get("destinationName");
  return stored.destinationName || "";
}

export async function grantedDestination() {
  const handle = await loadDestination();
  if (!handle) return null;
  const permission = await handle.queryPermission({ mode: "readwrite" });
  return permission === "granted" ? handle : null;
}
