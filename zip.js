const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function createZipWriter(sink) {
  const entries = [];
  const used = new Set();
  let offset = 0;

  function uniqueName(path) {
    const clean = String(path || "file").replace(/\\/g, "/").replace(/^\/+/, "") || "file";
    if (!used.has(clean)) {
      used.add(clean);
      return clean;
    }
    const slash = clean.lastIndexOf("/");
    const dir = slash >= 0 ? clean.slice(0, slash + 1) : "";
    const base = slash >= 0 ? clean.slice(slash + 1) : clean;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let n = 2;
    let next = "";
    do {
      next = `${dir}${stem} (${n})${ext}`;
      n += 1;
    } while (used.has(next));
    used.add(next);
    return next;
  }

  return {
    get count() {
      return entries.length;
    },
    async add(path, data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const name = uniqueName(path);
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(bytes);
      const { time, day } = dosStamp(new Date());
      const local = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, time, true);
      view.setUint16(12, day, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, bytes.length, true);
      view.setUint32(22, bytes.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      await sink.write(local);
      await sink.write(bytes);
      entries.push({ nameBytes, crc, size: bytes.length, offset, time, day });
      offset += local.length + bytes.length;
    },
    async close() {
      const centralStart = offset;
      for (const entry of entries) {
        const central = new Uint8Array(46 + entry.nameBytes.length);
        const view = new DataView(central.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0x0800, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, entry.time, true);
        view.setUint16(14, entry.day, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.size, true);
        view.setUint32(24, entry.size, true);
        view.setUint16(28, entry.nameBytes.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, entry.offset, true);
        central.set(entry.nameBytes, 46);
        await sink.write(central);
        offset += central.length;
      }
      const end = new Uint8Array(22);
      const view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(4, 0, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, entries.length, true);
      view.setUint16(10, entries.length, true);
      view.setUint32(12, offset - centralStart, true);
      view.setUint32(16, centralStart, true);
      view.setUint16(20, 0, true);
      await sink.write(end);
      await sink.close();
    },
    abort() {
      return sink.abort?.();
    },
  };
}
