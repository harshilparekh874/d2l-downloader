(() => {
  if (globalThis.__d2lFetchBridge) return;
  globalThis.__d2lFetchBridge = true;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "d2l-file") return;
    const jobs = new Map();

    const failAll = (reason) => {
      for (const job of jobs.values()) {
        job.controller.abort();
        job.fail?.(reason);
      }
    };

    port.onMessage.addListener((msg) => {
      if (msg.type === "pause") {
        for (const job of jobs.values()) job.paused = true;
        return;
      }
      if (msg.type === "resume") {
        for (const job of jobs.values()) {
          job.paused = false;
          job.resume?.();
        }
        return;
      }
      if (msg.type === "abort" || msg.type === "abort-all") {
        if (msg.type === "abort-all") failAll("cancelled");
        else jobs.get(msg.id)?.controller.abort();
        return;
      }
      if (msg.type === "ack") {
        const job = jobs.get(msg.id);
        if (!job) return;
        const waiter = job.waiters.shift();
        if (waiter) waiter();
        else job.acks += 1;
        return;
      }
      if (msg.type === "fetch") startFetch(port, jobs, msg);
    });

    port.onDisconnect.addListener(() => failAll("retry"));
  });

  function csrf() {
    const match = document.cookie.match(/(?:^|;\s*)d2lSecureSessionVal=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function waitAck(job) {
    if (job.acks > 0) {
      job.acks -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => job.waiters.push(resolve));
  }

  async function startFetch(port, jobs, msg) {
    const controller = new AbortController();
    const job = {
      controller,
      paused: false,
      resume: null,
      acks: 0,
      waiters: [],
      fail: null,
    };
    jobs.set(msg.id, job);
    try {
      const headers = { "X-Requested-With": "XMLHttpRequest" };
      const token = csrf();
      if (token) headers["X-Csrf-Token"] = token;
      const res = await fetch(msg.url, { credentials: "include", headers, signal: controller.signal });
      if (!res.ok || !res.body) {
        port.postMessage({ type: "error", id: msg.id, reason: `HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      while (true) {
        while (job.paused && !controller.signal.aborted) {
          await new Promise((resolve) => {
            job.resume = resolve;
          });
        }
        const { done, value } = await reader.read();
        if (done) {
          port.postMessage({ type: "end", id: msg.id });
          break;
        }
        port.postMessage({ type: "chunk", id: msg.id, bytes: value });
        await waitAck(job);
      }
    } catch (err) {
      const reason = controller.signal.aborted ? "cancelled" : err?.message || "Download failed";
      try {
        port.postMessage({ type: "error", id: msg.id, reason });
      } catch {
        /* Port already closed. */
      }
    } finally {
      jobs.delete(msg.id);
    }
  }
})();
