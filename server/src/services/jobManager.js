import crypto from 'node:crypto';
import { DownloadJob } from './downloadJob.js';
import { JobStore } from './jobStore.js';

export class JobManager {
  constructor(sseManager) {
    this.jobs = new Map();
    this.sseManager = sseManager;
    this.store = new JobStore();

    // Load persisted jobs that may have survived a restart
    this._loadPersistedJobs();
  }

  async _loadPersistedJobs() {
    try {
      const stored = await this.store.loadAll();
      for (const data of stored) {
        // If job was running and has options, recreate a real DownloadJob to resume
        if (data.status === 'running' && data.options && data.episodes?.length > 0) {
          const hasUrls = data.episodes.some(e => e.url);
          if (!hasUrls) {
            // No URLs in stored data (old format) — keep as static stub
            this._createStaticStub(data);
            continue;
          }
          const job = new DownloadJob({
            jobId: data.jobId,
            episodes: data.episodes.map(e => ({
              number: e.number,
              title: e.title,
              url: e.url,
            })),
            options: data.options,
            sseManager: this.sseManager,
          });
          // Restore file paths and completed status from stored data
          for (const ep of job.episodes) {
            const stored = data.episodes.find(e => e.number === ep.number);
            if (stored) {
              if (stored.status === 'completed' || stored.status === 'skipped') {
                ep.status = stored.status;
                ep.phase = stored.status;
                ep.filePath = stored.path || null;
              }
              if (stored.progress) {
                ep.progress = { ...stored.progress };
              }
            }
          }
          this.jobs.set(data.jobId, job);
          console.log(`[JobManager] Resuming job ${data.jobId.slice(0, 8)}...`);
          job.start().catch(err => {
            console.error(`[JobManager] Resume failed for ${data.jobId}: ${err.message}`);
          });
        } else {
          this._createStaticStub(data);
        }
      }
      if (stored.length > 0) {
        console.log(`[JobManager] Restored ${stored.length} persisted job(s)`);
      }
    } catch (err) {
      console.error(`[JobManager] Failed to load persisted jobs: ${err.message}`);
    }
  }

  _createStaticStub(data) {
    this.jobs.set(data.jobId, {
      jobId: data.jobId,
      status: data.status,
      createdAt: data.createdAt,
      completedAt: data.completedAt,
      episodeCount: data.episodeCount || data.episodes?.length || 0,
      completedCount: data.completedCount || 0,
      errorCount: data.errorCount || 0,
      _restored: true,
      toJSON() {
        return {
          jobId: this.jobId,
          status: this.status,
          episodes: (data.episodes || []).map(e => ({
            number: e.number,
            title: e.title,
            status: e.status,
            progress: e.progress || { bytes: 0, total: 0, speed: 0, percent: 0 },
            error: e.error || null,
            path: e.path || null,
          })),
          episodeCount: this.episodeCount,
          completedCount: this.completedCount,
          errorCount: this.errorCount,
          createdAt: this.createdAt,
          completedAt: this.completedAt,
        };
      },
    });
  }

  createJob(episodes, options) {
    const jobId = crypto.randomUUID();
    const job = new DownloadJob({ jobId, episodes, options, sseManager: this.sseManager });
    this.jobs.set(jobId, job);
    // Start without awaiting — runs in background
    job.start().catch(err => {
      console.error(`Job ${jobId} failed: ${err.message}`);
    });
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  getAllJobs() {
    return Array.from(this.jobs.values()).map(j => j.toJSON());
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (typeof job.cancel === 'function') {
      job.cancel();
    } else {
      // Restored job — mark cancelled in store
      this.store.save({
        ...job.toJSON(),
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      }).catch(() => {});
      job.status = 'cancelled';
    }
    return job;
  }
}
