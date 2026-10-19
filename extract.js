// Runs inside the open Brightspace tab so the existing login session is reused.
export async function scanCourse() {
  const FILE_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|zip|rar|7z|png|jpe?g|gif|webp|svg|mp4|m4v|mov|avi|wmv|mp3|wav|m4a|txt|rtf|ipynb|py|java|c|cpp|h|js|css|json|xml|tex|md|ppt|doc|xls)(?=$|[?#])/i;

  function report(text) {
    try {
      chrome.runtime.sendMessage({ type: "SCAN_STATUS", text });
    } catch {
      /* Popup may have closed. */
    }
  }

  function trimWords(text, max) {
    const clean = String(text || "").replace(/[. ]+$/g, "");
    if (clean.length <= max) return clean || "file";
    const slice = clean.slice(0, max);
    const space = slice.lastIndexOf(" ");
    const cut = space >= 20 ? slice.slice(0, space) : slice;
    return cut.replace(/[. ,;:!?-]+$/g, "") || "file";
  }

  function sanitize(input, max = 60) {
    let s = String(input ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff\u00ad\u2060]/g, " ");
    s = s.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/^[. ]+|[. ]+$/g, "");
    if (!s || s === "." || s === "..") s = "untitled";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) s = `_${s}`;
    if (s.length > max) s = trimWords(s, max);
    return s || "untitled";
  }

  function pad(n, width) {
    return String(n).padStart(Math.max(width, 2), "0");
  }

  function readCsrf() {
    const match = document.cookie.match(/(?:^|;\s*)d2lSecureSessionVal=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function apiGet(path) {
    const headers = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    const token = readCsrf();
    if (token) headers["X-Csrf-Token"] = token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(path, { credentials: "include", headers, signal: controller.signal });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { ok: res.ok, status: res.status, data, url: res.url || "" };
    } catch (err) {
      return { ok: false, status: 0, data: null, url: "", timedOut: err?.name === "AbortError" };
    } finally {
      clearTimeout(timer);
    }
  }

  function orgUnitId() {
    const patterns = [
      /\/d2l\/home\/(\d+)/,
      /\/d2l\/le\/(?:content|lessons|calendar|news|grades|dropbox|discussions|schedule|classlist|awards)\/(\d+)/,
      /[?&](?:ou|orgUnitId)=(\d+)/,
    ];
    for (const pattern of patterns) {
      const match = location.href.match(pattern);
      if (match) return match[1];
    }
    const link = document.querySelector("a[href*='/d2l/home/']");
    const href = link?.href || link?.getAttribute?.("href") || "";
    const fromLink = String(href).match(/\/d2l\/home\/(\d+)/);
    return fromLink ? fromLink[1] : "";
  }

  function isD2LPage() {
    return /\/d2l\//.test(location.pathname) || !!document.querySelector("d2l-navigation, [class*='d2l-']");
  }

  function courseTitleFromPage(ou) {
    const junk = /^(content|lessons|course home|home|brightspace|calendar|grades|discussions|assignments|dropbox|quizzes|classlist|announcements|checklist|surveys|awards|media library|select a course|my courses|course content|content browser)$/i;
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const ok = (value) => {
      const text = clean(value);
      return text.length > 1 && text.length < 180 && !junk.test(text);
    };

    const homeNames = [];
    const visit = (root, depth) => {
      if (!root?.querySelectorAll || depth > 5) return;
      for (const el of root.querySelectorAll(`a[href*="/d2l/home/${ou}"]`)) {
        const text = clean(el.getAttribute("title") || el.getAttribute("text") || el.textContent);
        if (ok(text)) homeNames.push(text);
      }
      if (homeNames.length) return;
      for (const el of root.querySelectorAll("d2l-navigation, d2l-navigation-main-header, d2l-navigation-link, d2l-dropdown, d2l-dropdown-content, d2l-menu")) {
        if (!el.shadowRoot) continue;
        visit(el.shadowRoot, depth + 1);
        if (homeNames.length) return;
      }
    };
    visit(document, 0);
    homeNames.sort((a, b) => b.length - a.length);
    const parts = document.title.split(/\s[-–|•]\s/).map(clean).filter(Boolean);
    let fromTitle = "";
    if (parts.length >= 2 && junk.test(parts[0]) && ok(parts[1])) fromTitle = parts[1];
    else if (ok(parts[0])) fromTitle = parts[0];
    if (homeNames[0] && fromTitle.length > homeNames[0].length && fromTitle.toLowerCase().includes(homeNames[0].toLowerCase())) {
      return fromTitle;
    }
    if (homeNames[0]) return homeNames[0];
    if (fromTitle) return fromTitle;

    for (const el of document.querySelectorAll("h1, .d2l-page-title, .d2l-heading-title")) {
      const text = clean(el.textContent);
      if (ok(text)) return text;
    }
    return "";
  }

  function extensionFromUrl(url) {
    try {
      const base = decodeURIComponent(new URL(url, location.origin).pathname.split("/").pop() || "");
      const match = base.match(/(\.[a-z0-9]{1,8})$/i);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function isCourseFilePath(pathname) {
    const path = pathname.toLowerCase();
    if (path.startsWith("/content/")) return path.split("/").pop() !== "";
    return path.includes("d2lfile") || path.includes("/d2l/lp/files/");
  }

  function isLibraryFile(name) {
    const file = String(name || "").toLowerCase();
    if (/context-provider-host-factory|font-?awesome|highlight(?:\.min)?\.js|require(?:\.min)?\.js/.test(file)) return true;
    return /(?:^|\/)(?:jquery|bootstrap|popper|mathjax|prism)[-.\d]/.test(file)
      || /(?:^|\/)(?:embeds|creator|scripts|styles|custom|all)(?:\.min)?\.(?:js|css)$/.test(file);
  }

  function isFormattingAsset(el, url) {
    const tag = String(el.tagName || "").toUpperCase();
    const ext = extensionFromUrl(url);
    let name = "";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch {
      name = "";
    }
    if (tag === "SCRIPT") return true;
    if (tag === "LINK") {
      const rel = String(el.getAttribute("rel") || "").toLowerCase();
      const as = String(el.getAttribute("as") || "").toLowerCase();
      if (/stylesheet|icon|preload|modulepreload/.test(rel) || ["script", "style", "font"].includes(as)) return true;
      if (ext === ".css" || ext === ".js") return true;
    }
    if ([".map", ".woff", ".woff2", ".ttf", ".eot", ".otf"].includes(ext)) return true;
    if (isLibraryFile(name)) return true;
    return false;
  }

  function isDirectFileUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.origin === location.origin && isCourseFilePath(parsed.pathname)) return true;
      return FILE_EXT.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function resolveUrl(url) {
    if (!url) return "";
    try {
      return new URL(url, location.origin).href;
    } catch {
      return "";
    }
  }

  function htmlOf(description) {
    if (!description) return "";
    if (typeof description === "string") return description;
    return description.Html || description.html || "";
  }

  function topicKind(topic) {
    if (topic.IsBroken) return "broken";
    const name = String(topic.TypeIdentifier || "").toLowerCase();
    const activity = Number(topic.ActivityType);
    const topicType = Number(topic.TopicType);
    if (name === "file" || activity === 1 || topicType === 1) return "file";
    const abs = resolveUrl(topic.Url);
    if (abs && isDirectFileUrl(abs)) return "file";
    if (name === "link" || activity === 2 || topicType === 3 || abs) return "link";
    return "other";
  }

  function normalizeTopic(raw, index) {
    return {
      TopicId: raw.TopicId ?? raw.Id,
      Title: raw.Title || "Untitled",
      Url: raw.Url || "",
      SortOrder: raw.SortOrder ?? index,
      IsHidden: !!raw.IsHidden,
      IsBroken: !!raw.IsBroken,
      TypeIdentifier: raw.TypeIdentifier || "",
      ActivityType: raw.ActivityType,
      TopicType: raw.TopicType,
      Description: raw.Description,
    };
  }

  async function detectVersions() {
    let lp = "1.43";
    let le = "1.67";
    const versions = await apiGet("/d2l/api/versions/");
    const list = Array.isArray(versions.data)
      ? versions.data
      : versions.data?.Versions || versions.data?.versions || [];
    for (const item of list) {
      const code = String(item.ProductCode || item.productCode || "").toLowerCase();
      const ver = item.LatestVersion || item.latestVersion;
      if (!ver) continue;
      if (code === "lp") lp = String(ver);
      if (code === "le") le = String(ver);
    }
    return { lp, le };
  }

  async function firstJson(paths) {
    let lastStatus = 0;
    for (const path of paths) {
      const res = await apiGet(path);
      lastStatus = res.status;
      if (res.ok && res.data) return res.data;
      if (/\/d2l\/login/i.test(res.url)) {
        throw new Error("Brightspace asked you to sign in again. Reload the course page, then scan.");
      }
    }
    const error = new Error(`Brightspace returned ${lastStatus || "an error"} for the course content.`);
    error.status = lastStatus;
    throw error;
  }

  function basename(url) {
    try {
      const base = decodeURIComponent(new URL(url, location.origin).pathname.split("/").pop() || "file");
      return sanitize(base, 80);
    } catch {
      return "file";
    }
  }

  try {
    if (!isD2LPage()) {
      return { ok: false, error: "Open a Brightspace course page first, then click the extension." };
    }

    const ou = orgUnitId();
    if (!ou) {
      return { ok: false, error: "Open a course (home or content), then scan again. This page has no course id." };
    }

    report("Reading the course outline…");
    const versions = await detectVersions();
    const leCandidates = [...new Set([versions.le, "1.75", "1.67", "1.62", "1.53", "1.42"])];
    const lpCandidates = [...new Set([versions.lp, "1.43", "1.35", "1.30"])];

    let course = null;
    try {
      course = await firstJson(lpCandidates.map((ver) => `/d2l/api/lp/${ver}/courses/${ou}`));
    } catch {
      try {
        course = await firstJson(lpCandidates.map((ver) => `/d2l/api/lp/${ver}/orgstructure/${ou}`));
      } catch {
        course = null;
      }
    }

    let courseTitle = courseTitleFromPage(ou);
    if (!courseTitle) {
      try {
        const enrollment = await firstJson(
          lpCandidates.map((ver) => `/d2l/api/lp/${ver}/enrollments/myenrollments/${ou}`),
        );
        courseTitle = enrollment?.OrgUnit?.Name || "";
      } catch {
        courseTitle = "";
      }
    }
    if (!courseTitle) courseTitle = course?.Name || "";
    const courseFolder = sanitize(courseTitle || "D2L Course", 100);
    report("Loading the module list…");

    let leVersion = leCandidates[0];
    let modules = null;
    let rootTopics = [];
    let lastError = null;

    const expandedIds = new Set();

    function childIsModule(child) {
      if (child.TopicId != null || child.Type === 1 || child.Url) return false;
      return child.Type === 0 || (!!child.ModuleId && child.TopicId == null);
    }

    async function expandModule(ver, orgId, mod, index) {
      const id = mod.ModuleId || mod.Id;
      const empty = {
        ModuleId: id,
        Title: mod.Title || "Module",
        SortOrder: mod.SortOrder ?? index,
        IsHidden: !!mod.IsHidden,
        Modules: [],
        Topics: [],
      };
      if (id == null || expandedIds.has(String(id))) return empty;
      expandedIds.add(String(id));
      const structure = await apiGet(`/d2l/api/le/${ver}/${orgId}/content/modules/${id}/structure/`);
      const children = Array.isArray(structure.data) ? structure.data : mod.Structure || [];
      const nested = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (childIsModule(child)) nested.push(await expandModule(ver, orgId, child, i));
        else empty.Topics.push(normalizeTopic(child, i));
      }
      empty.Modules = nested;
      return empty;
    }

    for (const ver of leCandidates) {
      const toc = await apiGet(`/d2l/api/le/${ver}/${ou}/content/toc`);
      if (toc.ok && toc.data && (toc.data.Modules || toc.data.modules)) {
        leVersion = ver;
        modules = toc.data.Modules || toc.data.modules || [];
        rootTopics = toc.data.Topics || toc.data.topics || [];
        lastError = null;
        break;
      }
      lastError = toc;
    }

    if (!modules) {
      let loaded = null;
      for (const ver of leCandidates) {
        const root = await apiGet(`/d2l/api/le/${ver}/${ou}/content/root/`);
        const list = Array.isArray(root.data) ? root.data : null;
        if (!root.ok || !list) {
          lastError = root;
          continue;
        }
        leVersion = ver;
        loaded = await Promise.all(list.map((mod, index) => expandModule(ver, ou, mod, index)));
        break;
      }
      if (!loaded) {
        const status = lastError?.status;
        if (lastError?.timedOut || status === 0) {
          return { ok: false, error: "Brightspace didn't answer. Reload the course page, then scan again." };
        }
        if (status === 401 || status === 403) {
          return { ok: false, error: "Brightspace refused the content request. Reload the course while signed in, then scan again." };
        }
        if (status === 404) {
          return { ok: false, error: "No content outline was found for this course." };
        }
        return { ok: false, error: `Could not read the course outline (HTTP ${status || "error"}).` };
      }
      modules = loaded;
    }

    const files = [];
    const links = [];
    const warnings = [];
    let skippedBroken = 0;
    const moduleFolders = [];
    const urlsInFolder = new Map();
    const namesInFolder = new Map();

    function allocName(folder, desired) {
      if (!namesInFolder.has(folder)) namesInFolder.set(folder, new Set());
      const used = namesInFolder.get(folder);
      let name = desired;
      let n = 2;
      while (used.has(name.toLowerCase())) {
        const dot = desired.lastIndexOf(".");
        name = dot > 0 ? `${desired.slice(0, dot)} (${n})${desired.slice(dot)}` : `${desired} (${n})`;
        n++;
      }
      used.add(name.toLowerCase());
      return `${folder}/${name}`;
    }

    function addRemote(folder, url, desiredName, hidden, label, place = {}) {
      const absolute = resolveUrl(url);
      if (!absolute) return;
      const key = absolute.split("#")[0];
      if (!urlsInFolder.has(folder)) urlsInFolder.set(folder, new Set());
      const seen = urlsInFolder.get(folder);
      if (seen.has(key)) return;
      seen.add(key);
      if (place.topicId != null) foundTopicIds.add(String(place.topicId));
      const filename = allocName(folder, desiredName);
      files.push({
        kind: "remote",
        url: absolute,
        filename,
        hidden: !!hidden,
        label: label || desiredName,
        module: place.module || "",
        topic: place.topic || "",
        leaf: filename.split("/").pop(),
      });
    }

    function fileTopicUrl(topic) {
      const abs = resolveUrl(topic.Url);
      if (abs && isDirectFileUrl(abs)) return abs;
      const id = topic.TopicId;
      if (id != null && topicKind(topic) === "file") {
        return `${location.origin}/d2l/api/le/${leVersion}/${ou}/content/topics/${id}/file`;
      }
      return abs;
    }

    const htmlJobs = [];
    const foundTopicIds = new Set();

    function collectFromHtml(html, baseUrl, folder, hidden, labelPrefix, place) {
      if (!html) return;
      htmlJobs.push({ html, baseUrl: baseUrl || location.origin, folder, hidden, label: labelPrefix, place });
    }

    function isHtmlName(url) {
      return /\.html?(?:$|[?#])/i.test(String(url || ""));
    }

    function fileNameFrom(url, linkText) {
      const ext = extensionFromUrl(url);
      const fromUrl = basename(url);
      if (fromUrl && ext && fromUrl.length > ext.length + 1 && !/^(view|viewer|file|content|download)\.[a-z0-9]+$/i.test(fromUrl)) {
        return fromUrl;
      }
      const text = sanitize(String(linkText || "").replace(/\s+/g, " "), 90);
      if (text && text.length > 1 && !/^https?:/i.test(text)) return withExtension(text, ext);
      return fromUrl;
    }

    function pushFound(raw, baseUrl, bucket) {
      if (!raw || /^(mailto:|javascript:|#|data:)/i.test(String(raw).trim())) return;
      let absolute = "";
      try {
        absolute = new URL(String(raw).replace(/&amp;/g, "&"), baseUrl || location.origin).href;
      } catch {
        return;
      }
      if (/quickLink\.d2l/i.test(absolute)) {
        if (/[?&]type=(?:content|file|link)\b/i.test(absolute)) bucket.quick.add(absolute.split("#")[0]);
        return;
      }
      if (isDirectFileUrl(absolute) && !isFormattingAsset({ tagName: "" }, absolute) && !isHtmlName(absolute)) {
        bucket.files.add(absolute.split("#")[0]);
      }
    }

    async function fetchText(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { credentials: "include", signal: controller.signal });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") || "";
        if (type && !/html|text|json|xml|octet-stream/i.test(type)) {
          if (isDirectFileUrl(res.url) && !isHtmlName(res.url)) return { fileUrl: res.url };
          return null;
        }
        const reader = res.body?.getReader?.();
        if (!reader) {
          const text = await res.text();
          return { html: text.slice(0, 250000), url: res.url || url };
        }
        const decoder = new TextDecoder();
        let html = "";
        while (html.length < 250000) {
          const step = await reader.read();
          if (step.done) break;
          html += decoder.decode(step.value, { stream: true });
        }
        reader.cancel().catch(() => {});
        return { html, url: res.url || url };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    async function collectEmbedded(html, baseUrl, folder, hidden, label, place, depth) {
      if (!html || depth > 1) return;
      const bucket = { files: new Set(), quick: new Set() };
      const decoded = html.replace(/&amp;/g, "&").replace(/\\\//g, "/");
      const fileRe = /(?:https?:\/\/[^"'<>\s]+)?\/content\/[^"'<>\s]+?\.(?:pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|gif|webp|mp4|txt|rtf)/gi;
      let match;
      while ((match = fileRe.exec(decoded))) pushFound(match[0], baseUrl, bucket);
      if (bucket.files.size === 0 && depth === 0 && place?.topicId != null) {
        const quickRe = /\/d2l\/common\/dialogs\/quickLink\/quickLink\.d2l\?[^"'<>\s]+/gi;
        while ((match = quickRe.exec(decoded))) pushFound(match[0], baseUrl, bucket);
      }
      for (const fileUrl of bucket.files) {
        addRemote(folder, fileUrl, fileNameFrom(fileUrl, label), hidden, label || fileNameFrom(fileUrl, ""), place);
      }
      if (bucket.files.size || depth > 0) return;
      const quickUrls = [...bucket.quick].slice(0, 2);
      await Promise.all(quickUrls.map(async (quickUrl) => {
        const loaded = await fetchText(quickUrl);
        if (!loaded) return;
        if (loaded.fileUrl) {
          addRemote(folder, loaded.fileUrl, fileNameFrom(loaded.fileUrl, label), hidden, label || basename(loaded.fileUrl), place);
          return;
        }
        await collectEmbedded(loaded.html, loaded.url || quickUrl, folder, hidden, label, place, depth + 1);
      }));
    }

    function splitStructure(mod) {
      const explicitModules = mod.Modules || mod.modules || [];
      const explicitTopics = mod.Topics || mod.topics || [];
      if (explicitModules.length || explicitTopics.length) {
        return { modules: explicitModules, topics: explicitTopics.map((topic, index) => normalizeTopic(topic, index)) };
      }
      const structure = mod.Structure || mod.structure || [];
      const modules = [];
      const topics = [];
      structure.forEach((child, index) => {
        const isModule = child.Type === 0 || (child.ModuleId && !child.TopicId && child.Type !== 1);
        if (isModule) modules.push(child);
        else topics.push(normalizeTopic(child, index));
      });
      return { modules, topics };
    }

    function placeEntries(childModules, topics) {
      return [
        ...childModules.map((child, index) => ({
          kind: "module",
          sort: child.SortOrder ?? index,
          item: child,
        })),
        ...topics.map((child, index) => ({
          kind: "topic",
          sort: child.SortOrder ?? index,
          item: child,
        })),
      ].sort((a, b) => a.sort - b.sort || (a.kind === "module" ? -1 : 1));
    }

    function walkEntries(entries, parts, folder, hidden, modulePath) {
      const width = String(Math.max(entries.length, 1)).length;
      entries.forEach((entry, index) => {
        const childPrefix = pad(index + 1, width);
        if (entry.kind === "module") {
          walkModule(entry.item, parts, hidden, childPrefix);
          return;
        }
        addTopic(entry.item, folder, hidden, childPrefix, modulePath);
      });
    }

    function walkModule(mod, parentParts, inheritedHidden, prefix) {
      const hidden = inheritedHidden || !!mod.IsHidden;
      const folderName = `${prefix} ${sanitize(mod.Title || "Module", 70)}`.trim();
      const parts = [...parentParts, folderName];
      const folder = parts.join("/");
      const modulePath = parts.slice(1).join("/");
      const id = mod.ModuleId || mod.Id;
      const split = splitStructure(mod);
      const entries = placeEntries(split.modules, split.topics);
      if (id != null) {
        moduleFolders.push({
          id,
          folder,
          hidden,
          module: modulePath,
          parts,
          hadChildren: entries.length > 0,
        });
      }

      walkEntries(entries, parts, folder, hidden, modulePath);

      collectFromHtml(htmlOf(mod.Description), location.origin, folder, hidden, mod.Title || "Module", {
        module: modulePath,
        topic: "",
      });
    }

    const pendingTopics = [];

    function rememberLink(topic, folder, hidden, prefix, modulePath) {
      const label = topic.Title || "Untitled";
      const filename = `${folder}/${prefix} ${sanitize(label, 70)}`.trim();
      links.push({
        folder,
        filename,
        title: label,
        url: resolveUrl(topic.Url),
        hidden,
        selected: true,
        module: modulePath || "",
        topic: label,
      });
    }

    function addTopic(topic, folder, inheritedHidden, prefix, modulePath) {
      const hidden = inheritedHidden || !!topic.IsHidden;
      const kind = topicKind(topic);
      const label = topic.Title || "Untitled";
      if (kind === "broken") {
        skippedBroken += 1;
        return;
      }
      const direct = resolveUrl(topic.Url);
      if (kind === "file" && direct && isDirectFileUrl(direct) && !isHtmlName(direct)) {
        const ext = extensionFromUrl(direct);
        const desired = `${prefix} ${withExtension(sanitize(label, 90), ext)}`;
        addRemote(folder, direct, desired, hidden, label, { module: modulePath || "", topic: label });
        return;
      }
      pendingTopics.push({ topic, folder, hidden, prefix, modulePath });
    }

    async function enrichTopic(topic) {
      if (topic.TopicId == null) return topic;
      const detail = await apiGet(`/d2l/api/le/${leVersion}/${ou}/content/topics/${topic.TopicId}`);
      if (!detail.ok || !detail.data) return topic;
      return normalizeTopic({ ...topic, ...detail.data, TopicId: topic.TopicId }, 0);
    }

    function withExtension(title, ext) {
      if (!ext) return title;
      return title.toLowerCase().endsWith(ext) ? title : `${title}${ext}`;
    }

    const sortedRoot = [...modules].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0));
    const rootWidth = String(Math.max(sortedRoot.length, 1)).length;
    sortedRoot.forEach((mod, index) => {
      walkModule(mod, [courseFolder], false, pad(index + 1, rootWidth));
    });

    rootTopics.forEach((topic, index) => {
      addTopic(normalizeTopic(topic, index), courseFolder, !!topic.IsHidden, pad(index + 1, String(rootTopics.length).length));
    });

    const shallowModules = moduleFolders.filter((mod) => !mod.hadChildren);
    if (shallowModules.length) {
      report(`Opening ${shallowModules.length} modules for their topics…`);
      await pool(shallowModules, 8, async (mod) => {
        const structure = await apiGet(`/d2l/api/le/${leVersion}/${ou}/content/modules/${mod.id}/structure/`);
        const list = Array.isArray(structure.data) ? structure.data : [];
        if (!list.length) return;
        const split = splitStructure({ Structure: list });
        walkEntries(placeEntries(split.modules, split.topics), mod.parts, mod.folder, mod.hidden, mod.module);
      });
    }

    const pageJobs = [];
    if (pendingTopics.length) {
      report(`Reading ${pendingTopics.length} lessons…`);
      await pool(pendingTopics, 8, async (item) => {
        const topic = await enrichTopic(item.topic);
        const kind = topicKind(topic);
        const label = topic.Title || "Untitled";
        const topicId = topic.TopicId ?? item.topic.TopicId;
        const place = { module: item.modulePath || "", topic: label, topicId };
        if (kind === "broken") {
          skippedBroken += 1;
          return;
        }
        const described = htmlOf(topic.Description);
        if (described) await collectEmbedded(described, location.origin, item.folder, item.hidden, label, place, 0);
        if (topicId != null && foundTopicIds.has(String(topicId))) return;
        if (kind === "file") {
          const ext = extensionFromUrl(topic.Url) || "";
          if (ext !== ".html" && ext !== ".htm") {
            const url = fileTopicUrl(topic);
            const desired = `${item.prefix} ${withExtension(sanitize(label, 90), ext || extensionFromUrl(url) || "")}`;
            addRemote(item.folder, url, desired, item.hidden, label, place);
            return;
          }
        } else {
          rememberLink(topic, item.folder, item.hidden, item.prefix, item.modulePath);
        }
        const lessonUrl = resolveUrl(topic.Url);
        const external = lessonUrl && !lessonUrl.startsWith(location.origin);
        const activity = /dropbox|quiz|discussion|survey|checklist|chat|scorm/i.test(String(topic.TypeIdentifier || ""));
        if (external || activity) return;
        const url = kind === "file" && isHtmlName(topic.Url)
          ? fileTopicUrl(topic)
          : topicId != null
            ? `${location.origin}/d2l/le/content/${ou}/viewContent/${topicId}/View`
            : "";
        if (url) pageJobs.push({ url, folder: item.folder, hidden: item.hidden, label, place });
      });
    }

    for (const job of htmlJobs) {
      await collectEmbedded(job.html, job.baseUrl, job.folder, job.hidden, job.label, job.place, 0);
    }

    if (pageJobs.length) {
      report(`Opening ${pageJobs.length} lesson pages…`);
      let opened = 0;
      await pool(pageJobs, 6, async (page) => {
        try {
          const loaded = await fetchText(page.url);
          opened += 1;
          if (opened === pageJobs.length || opened % 4 === 0) report(`Opening lesson pages… ${opened} of ${pageJobs.length}`);
          if (!loaded) return;
          if (loaded.fileUrl) {
            addRemote(page.folder, loaded.fileUrl, fileNameFrom(loaded.fileUrl, page.label), page.hidden, page.label, page.place);
            return;
          }
          await collectEmbedded(loaded.html, loaded.url, page.folder, page.hidden, page.label, page.place, 0);
        } catch {
          warnings.push(`Could not read files inside ${page.label}.`);
        }
      });
    }

    const visibleCount = files.filter((file) => !file.hidden).length;
    report(files.length ? `Found ${files.length} files.` : "No files found.");

    return {
      ok: true,
      courseName: courseTitle || courseFolder,
      courseFolder,
      orgUnitId: ou,
      originOu: orgUnitId() || ou,
      host: location.host,
      files,
      links,
      folders: moduleFolders.map((mod) => ({ folder: mod.folder, hidden: !!mod.hidden })),
      skippedBroken,
      warnings,
      hiddenCount: files.filter((file) => file.hidden).length,
      visibleCount,
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Could not read this course." };
  }

  async function pool(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          await worker(items[index], index);
        } catch {
          /* Individual module/page failures should not cancel the scan. */
        }
      }
    });
    await Promise.all(runners);
  }
}
