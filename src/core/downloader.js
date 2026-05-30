import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import cliProgress from 'cli-progress';
import { MAX_RETRIES, RETRY_DELAY_MS, DOWNLOAD_CHUNK_SIZE } from './config.js';
import { sanitizeFilename, formatBytes, formatSpeed } from '../utils.js';
import { getHeaders } from '../userAgent.js';

export class SmartDownloader {
  constructor(outputDir) {
    this.outputDir = outputDir;
  }

  async download(url, epNum, overallBar, title, onProgress, abortSignal) {
    const dir = path.resolve(this.outputDir);
    await fsp.mkdir(dir, { recursive: true });

    const filename = title
      ? `${sanitizeFilename(title)}.mp4`
      : `ep${String(epNum).padStart(2, '0')}.mp4`;
    const filePath = path.join(dir, filename);

    // If already aborted, bail immediately
    if (abortSignal?.aborted) return { path: filePath, skipped: false, error: 'Cancelled' };

    let retries = 0;
    while (retries <= MAX_RETRIES) {
      try {
        return await this._attemptDownload(url, filePath, epNum, overallBar, onProgress, abortSignal);
      } catch (err) {
        // Don't retry if cancelled
        if (err.name === 'CanceledError' || err.message === 'Cancelled') {
          return { path: filePath, skipped: false, error: 'Cancelled' };
        }
        retries++;
        if (retries > MAX_RETRIES) {
          console.error(`\n✖ Episode ${epNum} failed after ${MAX_RETRIES} retries: ${err.message}`);
          return { path: filePath, skipped: false, error: err.message };
        }
        console.error(`\n⚠ Episode ${epNum} error (retry ${retries}/${MAX_RETRIES}): ${err.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  async _attemptDownload(url, filePath, epNum, overallBar, onProgress, abortSignal) {
    const reqHeaders = getHeaders('https://voir-anime.to/');

    // HEAD request to get remote file info
    let headResponse;
    try {
      headResponse = await axios.head(url, { timeout: 30000, headers: reqHeaders });
    } catch (err) {
      // Some CDNs reject HEAD — skip resume/skip logic, download fresh
      return this._downloadStream(url, filePath, epNum, 0, 'w', 0, overallBar, onProgress, abortSignal);
    }

    const remoteSize = parseInt(headResponse.headers['content-length'] || '0', 10);
    const acceptsRanges = headResponse.headers['accept-ranges'] === 'bytes';
    let fileSize = 0;

    // Check existing file
    try {
      const stat = await fsp.stat(filePath);
      fileSize = stat.size;
    } catch {
      fileSize = 0;
    }

    if (fileSize > 0 && fileSize === remoteSize) {
      if (overallBar) overallBar.increment();
      return { path: filePath, skipped: true };
    }

    let startFrom = 0;
    let writeMode = 'w';

    if (fileSize > 0 && fileSize < remoteSize && acceptsRanges) {
      startFrom = fileSize;
      writeMode = 'a';
    }

    const streamLength = remoteSize - startFrom;
    return this._downloadStream(url, filePath, epNum, startFrom, writeMode, streamLength, overallBar, onProgress, abortSignal);
  }

  async _downloadStream(url, filePath, epNum, startFrom, writeMode, streamLength, overallBar, onProgress, abortSignal) {
    const headers = getHeaders('https://voir-anime.to/');

    const downloadOptions = {
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 60000,
      headers,
      signal: abortSignal,
    };

    if (startFrom > 0) {
      downloadOptions.headers.Range = `bytes=${startFrom}-`;
    }

    const response = await axios(downloadOptions);
    const contentLength = parseInt(response.headers['content-length'] || '0', 10);
    const actualTotal = contentLength > 0 ? contentLength : streamLength;

    return new Promise((resolve, reject) => {
      // Abort mid-stream if cancel is called
      const onAbort = () => {
        writeStream.destroy();
        response.data.destroy();
        reject(new Error('Cancelled'));
      };
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      const writeStream = fs.createWriteStream(filePath, { flags: writeMode });
      let downloaded = startFrom;
      let lastTime = Date.now();
      let lastBytes = downloaded;

      let fileBar = null;
      if (overallBar && actualTotal > 0) {
        fileBar = new cliProgress.SingleBar({
          format: `  ep${String(epNum).padStart(2, '0')} [{bar}] {percentage}% | {valFmt}/{totalFmt} | {speed}`,
          barCompleteChar: '█',
          barIncompleteChar: '░',
          hideCursor: false,
          clearOnComplete: false,
          stopOnComplete: true,
        }, cliProgress.Presets.shades_classic);

        fileBar.start(actualTotal, startFrom, {
          speed: '0 B/s',
          valFmt: formatBytes(startFrom),
          totalFmt: formatBytes(actualTotal),
        });
      }

      response.data.on('data', (chunk) => {
        downloaded += chunk.length;
        writeStream.write(chunk);

        if (fileBar) {
          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.25) {
            const bytesDelta = downloaded - lastBytes;
            const speed = bytesDelta / elapsed;
            fileBar.update(downloaded, { speed: formatSpeed(speed), valFmt: formatBytes(downloaded) });
            lastTime = now;
            lastBytes = downloaded;
            if (onProgress) onProgress({ bytes: downloaded, total: actualTotal, speed, percent: (downloaded / actualTotal) * 100 });
          } else {
            fileBar.update(downloaded, { valFmt: formatBytes(downloaded) });
            if (onProgress) onProgress({ bytes: downloaded, total: actualTotal, speed: 0, percent: (downloaded / actualTotal) * 100 });
          }
        }
      });

      const cleanup = () => {
        abortSignal?.removeEventListener('abort', onAbort);
      };

      response.data.on('end', () => {
        if (fileBar) {
          fileBar.update(actualTotal, { valFmt: formatBytes(actualTotal) });
          fileBar.stop();
        }
        writeStream.end();
      });

      writeStream.on('finish', () => {
        cleanup();
        if (overallBar) overallBar.increment();
        resolve({ path: filePath, skipped: false });
      });

      writeStream.on('error', (err) => {
        cleanup();
        if (fileBar) fileBar.stop();
        reject(new Error(`Write error: ${err.message}`));
      });

      response.data.on('error', (err) => {
        cleanup();
        if (fileBar) fileBar.stop();
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }
}
