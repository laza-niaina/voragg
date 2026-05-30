import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/jobs');

export class JobStore {
  constructor() {
    this._ready = this._ensureDir();
  }

  async _ensureDir() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  }

  async save(jobData) {
    await this._ready;
    const filePath = path.join(DATA_DIR, `${jobData.jobId}.json`);
    await fsp.writeFile(filePath, JSON.stringify(jobData, null, 2), 'utf-8');
  }

  async load(jobId) {
    await this._ready;
    try {
      const filePath = path.join(DATA_DIR, `${jobId}.json`);
      const data = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async loadAll() {
    await this._ready;
    const files = await fsp.readdir(DATA_DIR).catch(() => []);
    const jobs = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fsp.readFile(path.join(DATA_DIR, file), 'utf-8');
        jobs.push(JSON.parse(data));
      } catch { /* skip corrupt files */ }
    }
    return jobs;
  }

  async delete(jobId) {
    await this._ready;
    try {
      await fsp.unlink(path.join(DATA_DIR, `${jobId}.json`));
    } catch { /* ignore if not found */ }
  }
}
