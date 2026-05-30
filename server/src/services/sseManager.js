export class SseManager {
  constructor() {
    this.clients = new Map(); // jobId -> Set<Response>
  }

  addClient(jobId, res) {
    if (!this.clients.has(jobId)) {
      this.clients.set(jobId, new Set());
    }
    this.clients.get(jobId).add(res);

    res.on('close', () => {
      const set = this.clients.get(jobId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.clients.delete(jobId);
      }
    });
  }

  send(jobId, eventType, data) {
    const set = this.clients.get(jobId);
    if (!set) return;
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        if (!res.writableEnded) res.write(message);
      } catch {
        set.delete(res);
      }
    }
    if (set.size === 0) this.clients.delete(jobId);
  }

  removeJob(jobId) {
    const set = this.clients.get(jobId);
    if (set) {
      for (const res of set) {
        try { if (!res.writableEnded) res.end(); } catch {}
      }
      this.clients.delete(jobId);
    }
  }
}
