import axios from 'axios';
import { VideoPlayer } from '../../core/base.js';
import { getHeaders } from '../../userAgent.js';

export class VidmolyPlayer extends VideoPlayer {
  get name() {
    return 'vidmoly';
  }

  async extractDirectUrl(url, quality) {
    const qualities = await this.getAvailableQualities(url);

    if (qualities.length === 0) {
      throw new Error('Could not find any video source in vidmoly page');
    }

    if (!quality || quality === 'best') {
      return qualities[qualities.length - 1].url;
    }

    // Match by label (e.g. "720", "720p", "1080", "1080p")
    const target = String(quality).toLowerCase().replace(/p$/, '');
    const match = qualities.find(q =>
      q.label.toLowerCase().replace(/p$/, '') === target
    );
    if (match) return match.url;

    // Quality not found — silently use best
    return qualities[qualities.length - 1].url;
  }

  async getAvailableQualities(url) {
    const response = await axios.get(url, {
      headers: getHeaders('https://voir-anime.to/'),
    });

    const html = response.data;
    let qualities = [];

    // Pattern 1: sources array with file+label objects
    // e.g. sources:[{file:"URL",label:"720p"},{file:"URL",label:"1080p"}]
    const sourcesMatch = html.match(/sources\s*:\s*\[([\s\S]*?)\]/);
    if (sourcesMatch) {
      const fileRegex = /["']file["']\s*[:=]\s*["']([^"']+)["']/g;
      const labelRegex = /["']label["']\s*[:=]\s*["']([^"']+)["']/g;
      const files = [...sourcesMatch[1].matchAll(fileRegex)].map(m => m[1]);
      const labels = [...sourcesMatch[1].matchAll(labelRegex)].map(m => m[1]);
      for (let i = 0; i < files.length; i++) {
        qualities.push({
          url: files[i],
          label: labels[i] || `quality${i}`,
        });
      }
    }

    // Pattern 2: multiple file:"URL" with preceding quality labels
    // e.g. "720p": {file:"URL"}, "1080p": {file:"URL"}
    if (qualities.length === 0) {
      const qualityBlockRegex = /["'](\d+p)["']\s*:\s*\{[\s\S]*?["']file["']\s*[:=]\s*["']([^"']+)["']/g;
      let match;
      while ((match = qualityBlockRegex.exec(html)) !== null) {
        qualities.push({ url: match[2], label: match[1] });
      }
    }

    // Pattern 3: var s\d+ = 'URL' (numbered vars — older pattern)
    if (qualities.length === 0) {
      const varRegex = /var\s+s\d+\s*=\s*['"](https?:\/\/[^"']+)['"]/g;
      const urls = [];
      let varMatch;
      while ((varMatch = varRegex.exec(html)) !== null) {
        urls.push(varMatch[1]);
      }
      qualities = urls.map((url, i) => ({ url, label: `quality${i}` }));
    }

    // Pattern 4: file:"URL" without labels
    if (qualities.length === 0) {
      const fileRegex = /["']file["']\s*[:=]\s*["']([^"']+)["']/g;
      const urls = [];
      let match;
      while ((match = fileRegex.exec(html)) !== null) {
        urls.push(match[1]);
      }
      if (urls.length === 1) {
        qualities = urls.map((url, i) => ({ url, label: `quality${i}` }));
      }
    }

    // Pattern 5: direct .m3u8 or vmeas.cloud URL as single source
    if (qualities.length === 0) {
      const directMatch =
        html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/) ||
        html.match(/https?:\/\/[^"'\s<>]*vmeas\.cloud[^"'\s<>]*/);
      if (directMatch) {
        qualities.push({ url: directMatch[0], label: 'auto' });
      }
    }

    // Sort by resolution (extract number from label), lowest first
    qualities.sort((a, b) => {
      const na = parseInt(a.label, 10) || 0;
      const nb = parseInt(b.label, 10) || 0;
      return na - nb;
    });

    return qualities;
  }
}
