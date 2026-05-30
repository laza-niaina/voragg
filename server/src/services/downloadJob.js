import fs from 'node:fs';
import { VoirAnimeEpisode } from '../../../src/extractors/platforms/voiranime.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import { Logger } from '../../../src/utils.js';
import { JobStore } from './jobStore.js';

export class DownloadJob {
  constructor({ jobId, episodes, options, sseManager }) {
    this.jobId = jobId;
    this.episodes = episodes.map(ep => ({
      number: ep.number,
      title: ep.title || `Episode ${ep.number}`,
      url: ep.url,
      status: 'pending',
      phase: 'pending',
      progress: { bytes: 0, total: 0, speed: 0, percent: 0 },
      error: null,
      filePath: null,
    }));
    this.options = options;
    this.sseManager = sseManager;
    this.store = new JobStore();
    this.status = 'pending';
    this.cancelled = false;
    this.createdAt = new Date().toISOString();
    this.completedAt = null;

    // Persist initial state
    this._save();
  }

  _save() {
    this.store.save({
      jobId: this.jobId,
      status: this.status,
      options: this.options,
      episodes: this.episodes.map(e => ({
        number: e.number,
        title: e.title,
        url: e.url,
        status: e.status,
        phase: e.phase,
        progress: { ...e.progress },
        error: e.error,
        path: e.filePath,
      })),
      episodeCount: this.episodes.length,
      completedCount: this.episodes.filter(e => e.status === 'completed' || e.status === 'skipped').length,
      errorCount: this.episodes.filter(e => e.status === 'error').length,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
    }).catch(err => console.error(`[JobStore] Save error for ${this.jobId}: ${err.message}`));
  }

  _sendProgress(ep, data) {
    this.sseManager.send(this.jobId, 'progress', {
      jobId: this.jobId,
      episode: ep.number,
      phase: ep.phase,
      ...data,
    });
  }

  async start() {
    this.status = 'running';
    this._save();

    const { outputDir, player, quality, maxConcurrent } = this.options;
    const logger = new Logger();

    const abortController = new AbortController();
    this._abortController = abortController;

    const orchestrator = new Orchestrator({
      outputDir: outputDir || '.',
      maxConcurrent: maxConcurrent || 3,
      playerCode: player || 'streamtape',
      quality: quality,
      logger,
    });
    orchestrator.setAbortSignal(abortController.signal);

    for (const ep of this.episodes) {
      if (this.cancelled) break;

      // Resume: skip episodes already completed or skipped
      if (ep.status === 'completed' || ep.status === 'skipped') {
        this.sseManager.send(this.jobId, 'episode-skip', {
          jobId: this.jobId, episode: ep.number, path: ep.filePath, skipped: true,
        });
        continue;
      }

      // Reset interrupted episodes so they re-process
      ep.status = 'pending';
      ep.phase = 'pending';

      // --- Phase: resolving URL ---
      ep.status = 'fetching';
      ep.phase = 'resolving_url';
      ep.progress = { bytes: 0, total: 0, speed: 0, percent: 0 };
      this.sseManager.send(this.jobId, 'episode-start', {
        jobId: this.jobId, episode: ep.number, phase: ep.phase,
      });
      this._save();

      try {
        const episode = new VoirAnimeEpisode({
          number: ep.number,
          name: ep.title,
          url: ep.url,
        });

        // We wrap orchestrator.downloadEpisode with a progress callback that
        // also tracks the phase transitions happening inside the orchestrator.
        const result = await orchestrator.downloadEpisode(episode, null, (progress) => {
          ep.progress = {
            bytes: progress.bytes || 0,
            total: progress.total || 0,
            speed: progress.speed || 0,
            percent: progress.percent || 0,
          };
          if (progress.phase) ep.phase = progress.phase;

          // Once we enter "downloading" phase, reflect it in status
          if (ep.phase === 'downloading' && ep.status !== 'downloading') {
            ep.status = 'downloading';
          }

          this._sendProgress(ep, {
            bytes: ep.progress.bytes,
            total: ep.progress.total,
            speed: ep.progress.speed,
            percent: ep.progress.percent,
          });
        });

        if (result.error) {
          if (result.error === 'Cancelled') {
            ep.status = 'cancelled';
            ep.phase = 'cancelled';
          } else {
            ep.status = 'error';
            ep.phase = 'error';
            ep.error = result.error;
            this.sseManager.send(this.jobId, 'episode-error', {
              jobId: this.jobId, episode: ep.number, error: result.error,
            });
          }
        } else {
          ep.status = result.skipped ? 'skipped' : 'completed';
          ep.phase = result.skipped ? 'skipped' : 'completed';
          ep.filePath = result.path;
          this.sseManager.send(this.jobId, 'episode-complete', {
            jobId: this.jobId, episode: ep.number, path: result.path, skipped: !!result.skipped,
          });
        }
      } catch (err) {
        if (err.name === 'CanceledError' || err.message === 'Cancelled' || this.cancelled) {
          ep.status = 'cancelled';
          ep.phase = 'cancelled';
        } else {
          ep.status = 'error';
          ep.phase = 'error';
          ep.error = err.message;
          this.sseManager.send(this.jobId, 'episode-error', {
            jobId: this.jobId, episode: ep.number, error: err.message,
          });
        }
      }

      this._save();
    }

    this.status = this.cancelled ? 'cancelled' : 'completed';
    this.completedAt = new Date().toISOString();

    if (!this.cancelled) {
      const completed = this.episodes.filter(e => e.status === 'completed' || e.status === 'skipped').length;
      const errors = this.episodes.filter(e => e.status === 'error').map(e => ({ episode: e.number, error: e.error }));
      this.sseManager.send(this.jobId, 'complete', {
        jobId: this.jobId, totalEpisodes: this.episodes.length,
        successCount: completed, errorCount: errors.length, errors,
      });
    }
    this._save();
    this.sseManager.removeJob(this.jobId);
  }

  cancel() {
    this.cancelled = true;
    this.status = 'cancelled';
    this.completedAt = new Date().toISOString();

    // Abort the current download mid-stream
    if (this._abortController) {
      this._abortController.abort();
    }

    for (const ep of this.episodes) {
      if (ep.status === 'pending' || ep.status === 'fetching' || ep.status === 'downloading') {
        ep.status = 'cancelled';
        ep.phase = 'cancelled';
      }
    }
    this._save();
    this.sseManager.send(this.jobId, 'cancelled', {
      jobId: this.jobId,
    });
    this.sseManager.removeJob(this.jobId);
  }

  deleteFile(episodeNumber) {
    const ep = this.episodes.find(e => e.number === episodeNumber);
    if (!ep) return { error: `Episode ${episodeNumber} not found` };
    if (!ep.filePath) return { error: `No file path for episode ${episodeNumber}` };

    try {
      fs.unlinkSync(ep.filePath);
      const path = ep.filePath;
      ep.filePath = null;
      ep.status = 'pending';
      ep.phase = 'pending';
      this._save();
      return { success: true, path };
    } catch (err) {
      return { error: err.message };
    }
  }

  toJSON() {
    return {
      jobId: this.jobId,
      status: this.status,
      episodes: this.episodes.map(e => ({
        number: e.number,
        title: e.title,
        status: e.status,
        phase: e.phase,
        progress: e.progress,
        error: e.error,
        path: e.filePath,
      })),
      episodeCount: this.episodes.length,
      completedCount: this.episodes.filter(e => e.status === 'completed' || e.status === 'skipped').length,
      errorCount: this.episodes.filter(e => e.status === 'error').length,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
    };
  }
}
