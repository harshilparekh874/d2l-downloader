const CATALOG = "savedCatalog";

let memory = null;
let writeQueue = Promise.resolve();

export function itemKey(item) {
  if (!item) return "";
  if (item.text != null) return `text:${item.filename}`;
  return String(item.url || "").split("#")[0];
}

export async function loadCatalog() {
  if (memory) return memory;
  const stored = await chrome.storage.local.get(CATALOG);
  memory = stored[CATALOG] && typeof stored[CATALOG] === "object" ? stored[CATALOG] : {};
  return memory;
}

export function rememberFile(key, record) {
  if (!key) return Promise.resolve();
  return loadCatalog().then(() => {
    memory[key] = record;
    const snapshot = { ...memory };
    writeQueue = writeQueue.then(() => chrome.storage.local.set({ [CATALOG]: snapshot })).catch(() => {});
    return writeQueue;
  });
}

export async function remoteFacts(url) {
  if (!url) return {};
  try {
    const response = await fetch(url, { method: "HEAD", credentials: "include" });
    if (!response.ok) return {};
    const length = Number(response.headers.get("content-length"));
    return {
      size: Number.isFinite(length) && length >= 0 ? length : null,
      etag: response.headers.get("etag") || "",
      modified: response.headers.get("last-modified") || "",
    };
  } catch {
    return {};
  }
}

export async function statDirectory(root, relativePath) {
  if (!root || typeof root.getDirectoryHandle !== "function") return null;
  try {
    const parts = String(relativePath || "").split("/").filter(Boolean);
    const filename = parts.pop();
    if (!filename) return null;
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    return { size: file.size, file };
  } catch {
    return null;
  }
}

export async function statDownload(relativePath) {
  const base = String(relativePath || "").split("/").pop();
  if (!base || !chrome.downloads?.search) return null;
  const rows = await chrome.downloads.search({ query: [base], state: "complete", limit: 25 });
  const tail = String(relativePath || "").replaceAll("\\", "/").toLowerCase();
  for (const row of rows) {
    if (row.exists === false) continue;
    const name = String(row.filename || "").replaceAll("\\", "/").toLowerCase();
    if (!name.endsWith(`/${tail}`) && name !== tail) continue;
    return { size: row.fileSize };
  }
  return null;
}

function ownerOf(catalog, path) {
  for (const record of Object.values(catalog)) {
    if (record?.path === path) return record;
  }
  return null;
}

function withSuffix(path, n) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${dir ? `${dir}/` : ""}${stem} (${n})${ext}`;
}

export async function decideSave(item, stat) {
  if (item?.text != null) return { action: "write", filename: item.filename };
  const key = itemKey(item);
  if (!key) return { action: "write", filename: item.filename };
  const catalog = await loadCatalog();
  let filename = item.filename;
  let local = await stat(filename).catch(() => null);
  for (let guard = 2; local && guard < 30; guard += 1) {
    const owner = ownerOf(catalog, filename);
    if (!owner || owner.url === key) break;
    filename = withSuffix(item.filename, guard);
    local = await stat(filename).catch(() => null);
  }
  if (!local) return { action: "write", filename };
  const previous = catalog[key];
  if (!previous || previous.url !== key) return { action: "write", filename, update: true };
  const facts = await remoteFacts(item.url);
  const etagMatch = !!(facts.etag && previous.etag && facts.etag === previous.etag);
  const headSizeMatch = facts.size != null && local.size === facts.size;
  const savedSizeMatch = previous.size != null && local.size === previous.size;
  const headAgrees = headSizeMatch && (!facts.etag || !previous.etag || etagMatch);
  const headUnknown = !facts.etag && facts.size == null && savedSizeMatch;
  if (etagMatch || headAgrees || headUnknown) return { action: "skip", filename, facts };
  return { action: "write", filename, facts, update: true };
}
