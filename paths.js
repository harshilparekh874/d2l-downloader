function trimWords(text, max) {
  const clean = String(text || "").replace(/[. ]+$/g, "");
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const space = slice.lastIndexOf(" ");
  const cut = space >= 20 ? slice.slice(0, space) : slice;
  return cut.replace(/[. ,;:!?-]+$/g, "") || "file";
}

export function sanitizeSegment(input, max = 80) {
  let text = String(input ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff\u00ad\u2060]/g, " ");
  text = text.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^[. ]+|[. ]+$/g, "");
  if (!text || text === "." || text === "..") text = "untitled";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(text)) text = `_${text}`;
  if (text.length > max) text = trimWords(text, max);
  return text || "untitled";
}

export function limitFileName(name, max = 80) {
  const clean = sanitizeSegment(name, Math.max(max, 180));
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 9 ? clean.slice(dot).toLowerCase() : "";
  const stem = ext ? clean.slice(0, dot) : clean;
  const room = Math.max(8, max - ext.length);
  return `${trimWords(stem, room) || "file"}${ext}`;
}

export function fileLeaf({ label, filename, url } = {}) {
  const current = String(filename || "").split(/[\\/]/).pop() || "file";
  const fromCurrent = current.match(/(\.[a-z0-9]{1,8})$/i);
  const fromUrl = String(url || "").match(/(\.[a-z0-9]{1,8})(?:$|[?#])/i);
  const ext = (fromCurrent || fromUrl || [])[1]?.toLowerCase() || "";
  const prefix = (current.match(/^(\d{2,}\s+)/) || [])[1] || "";
  let stem = sanitizeSegment(label || current, 160);
  stem = stem.replace(/\.[a-z0-9]{1,8}$/i, "");
  if (prefix && !stem.startsWith(prefix.trim())) stem = `${prefix}${stem}`;
  return limitFileName(`${stem}${ext}`, 90);
}

export function safeRelativePath(relativePath, limits = {}) {
  const maxDir = limits.maxDir ?? 60;
  const maxFile = limits.maxFile ?? 90;
  const maxTotal = limits.maxTotal ?? 400;
  const parts = String(relativePath || "").split(/[\\/]/).filter(Boolean);
  if (!parts.length) return "file";
  const file = limitFileName(parts.pop(), maxFile);
  const dirs = parts.map((part) => sanitizeSegment(part, maxDir));
  while (dirs.length && [...dirs, file].join("/").length > maxTotal) dirs.pop();
  let path = [...dirs, file].join("/");
  if (path.length > maxTotal) path = limitFileName(file, maxTotal);
  return path || "file";
}

export function pathAttempts(relativePath) {
  const leaf = String(relativePath || "").split(/[\\/]/).pop() || "file";
  return [...new Set([
    safeRelativePath(relativePath),
    safeRelativePath(relativePath, { maxDir: 32, maxFile: 48, maxTotal: 100 }),
    safeRelativePath(leaf, { maxFile: 40, maxTotal: 40 }),
  ].filter(Boolean))];
}
