import { VoirAnimePlatform } from '../extractors/platforms/voiranime.js';
import { StreamtapePlayer } from '../extractors/players/streamtape.js';
import { VidmolyPlayer } from '../extractors/players/vidmoly.js';
import { SmartDownloader } from './downloader.js';
import { Logger } from '../utils.js';
import cliProgress from 'cli-progress';

export class Orchestrator {
  constructor({ outputDir, maxConcurrent, playerCode, quality, logger }) {
    this.outputDir = outputDir || '.';
    this.maxConcurrent = maxConcurrent || 3;
    this.playerCode = playerCode || 'streamtape';
    this.quality = quality;
    this.logger = logger || new Logger();
    this.platform = new VoirAnimePlatform();
    this.players = [new StreamtapePlayer(), new VidmolyPlayer()];
    this._abortSignal = null;
  }

  setAbortSignal(signal) {
    this._abortSignal = signal;
  }

  async getSeriesEpisodes(seriesUrl) {
    this.logger.info('Fetching episode list...');
    const episodes = await this.platform.getEpisodes(seriesUrl);
    this.logger.info(`Found ${episodes.length} episodes (${episodes[0]?.number || '?'} - ${episodes[episodes.length - 1]?.number || '?'})`);
    return episodes;
  }

  async downloadEpisode(episode, overallBar, onProgress) {
    if (this._abortSignal?.aborted) return { skipped: false, error: 'Cancelled' };
    const epLabel = `Episode ${episode.number}`;

    // --- Phase 1: Resolve player URL ---
    this.logger.debug(`${epLabel}: Getting player URL...`);
    if (onProgress) onProgress({ phase: 'resolving_url', bytes: 0, total: 0, speed: 0, percent: 0 });

    let playerUrl;
    try {
      playerUrl = await episode.getPlayerUrl();
    } catch (err) {
      this.logger.warning(`${epLabel}: Failed to get player URL: ${err.message}`);
      if (overallBar) overallBar.increment();
      return { skipped: false, error: err.message };
    }

    if (!playerUrl) {
      this.logger.warning(`${epLabel}: No player URL found`);
      if (overallBar) overallBar.increment();
      return { skipped: false, error: 'No player URL' };
    }

    if (onProgress) onProgress({ phase: 'resolving_url', bytes: 0, total: 0, speed: 0, percent: 50 });
    if (this._abortSignal?.aborted) return { skipped: false, error: 'Cancelled' };

    // --- Phase 2: Extract direct video URL ---
    this.logger.debug(`${epLabel}: Extracting direct video URL...`);
    if (onProgress) onProgress({ phase: 'extracting_video', bytes: 0, total: 0, speed: 0, percent: 0 });

    let directUrl;
    try {
      directUrl = await this._extractDirectUrl(playerUrl);
    } catch (err) {
      this.logger.warning(`${epLabel}: Failed to extract direct URL: ${err.message}`);
      if (overallBar) overallBar.increment();
      return { skipped: false, error: err.message };
    }

    if (!directUrl) {
      this.logger.warning(`${epLabel}: Could not extract direct video URL`);
      if (overallBar) overallBar.increment();
      return { skipped: false, error: 'No direct URL' };
    }

    if (onProgress) onProgress({ phase: 'extracting_video', bytes: 0, total: 0, speed: 0, percent: 100 });
    if (this._abortSignal?.aborted) return { skipped: false, error: 'Cancelled' };

    // --- Phase 3: Download the file ---
    this.logger.debug(`${epLabel}: Downloading...`);
    if (onProgress) onProgress({ phase: 'downloading', bytes: 0, total: 0, speed: 0, percent: 0 });

    const downloader = new SmartDownloader(this.outputDir);
    const wrappedProgress = onProgress
      ? (p) => onProgress({ phase: 'downloading', ...p })
      : undefined;
    const result = await downloader.download(directUrl, episode.number, overallBar, episode.title, wrappedProgress, this._abortSignal);

    if (result.skipped) {
      this.logger.warning(`${epLabel} already exists.`);
    } else {
      this.logger.success(`${epLabel} finished.`);
    }

    return result;
  }

  async downloadAll(episodes) {
    const total = episodes.length;
    if (total === 0) {
      this.logger.info('No episodes to download.');
      return;
    }

    const multibar = new cliProgress.MultiBar({
      format: 'Progress [{bar}] {percentage}% | {value}/{total} episodes',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
    }, cliProgress.Presets.shades_classic);

    const overallBar = multibar.create(total, 0);

    // Process episodes with concurrency control
    const queue = [...episodes];
    const errors = [];

    async function worker(orchestrator) {
      while (queue.length > 0) {
        const ep = queue.shift();
        try {
          const result = await orchestrator.downloadEpisode(ep, overallBar);
          if (result.error) {
            errors.push({ episode: ep.number, error: result.error });
          }
        } catch (err) {
          errors.push({ episode: ep.number, error: err.message });
          if (overallBar) overallBar.increment();
        }
      }
    }

    const workerCount = Math.min(this.maxConcurrent, episodes.length);
    const workers = Array.from({ length: workerCount }, () => worker(this));
    await Promise.all(workers);

    multibar.stop();

    if (errors.length > 0) {
      this.logger.warning(`\nCompleted with ${errors.length} error(s):`);
      for (const { episode, error } of errors) {
        this.logger.warning(`  Episode ${episode}: ${error}`);
      }
    } else {
      this.logger.success('\nAll episodes downloaded successfully!');
    }
  }

  async _extractDirectUrl(playerUrl) {
    for (const player of this.players) {
      if (playerUrl.toLowerCase().includes(player.name.toLowerCase())) {
        return player.extractDirectUrl(playerUrl, this.quality);
      }
    }
    throw new Error(`No player found for URL: ${playerUrl}`);
  }
}
