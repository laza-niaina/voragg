import axios from 'axios';
import * as cheerio from 'cheerio';
import { Platform, BaseEpisode } from '../../core/base.js';
import { getHeaders } from '../../userAgent.js';

export class VoirAnimeEpisode extends BaseEpisode {
  async getPlayerUrl() {
    const response = await axios.get(this.url, {
      headers: getHeaders('https://voir-anime.to/'),
    });

    const $ = cheerio.load(response.data);

    // Extract page title for filename
    const pageTitle = $('title').first().text().trim();
    if (pageTitle) {
      this.title = pageTitle;
    }

    let iframeSrc = null;

    // Try to find iframe in the active video container
    const videoFrame = $('#chapter-video-frame');
    if (videoFrame.length > 0) {
      const iframe = videoFrame.find('iframe');
      if (iframe.length > 0) {
        iframeSrc = iframe.attr('src');
      }
    }

    // Fallback: find any known player iframe
    if (!iframeSrc) {
      $('iframe').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('streamtape') || src.includes('vidmoly')) {
          iframeSrc = src;
          return false;
        }
      });
    }

    return iframeSrc || null;
  }
}

export class VoirAnimePlatform extends Platform {
  get name() {
    return 'voiranime';
  }

  async getEpisodes(seriesUrl) {
    // Normalize the series URL
    const baseUrl = seriesUrl.endsWith('/') ? seriesUrl : seriesUrl + '/';

    const response = await axios.get(baseUrl, {
      headers: getHeaders(),
    });

    const $ = cheerio.load(response.data);
    const episodes = [];
    const seenUrls = new Set();

    // Find all anchor tags whose href starts with the series URL
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      if (href.startsWith(baseUrl) || href.startsWith(seriesUrl)) {
        // Normalize: ensure we store full URL
        const fullUrl = href.startsWith('http') ? href : `https://voir-anime.to${href.startsWith('/') ? '' : '/'}${href}`;

        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);

        // Extract episode number from URL
        const segments = fullUrl.split('-');
        for (let i = segments.length - 1; i >= 0; i--) {
          const num = parseInt(segments[i], 10);
          if (!isNaN(num)) {
            // Extract episode name from URL path
            const urlPath = new URL(fullUrl).pathname.replace(/\/$/, '');
            const pathParts = urlPath.split('/').filter(Boolean);
            const lastPart = pathParts[pathParts.length - 1] || '';
            // Better name: derive from anime name in URL
            const animeName = pathParts.filter(p => !p.match(/^\d+$/)).pop() || 'Episode';

            const epUrl = new URL(fullUrl);
            epUrl.searchParams.set('host', 'LECTEUR Stape');
            const finalUrl = epUrl.toString();

            episodes.push(new VoirAnimeEpisode({
              number: num,
              name: `${animeName}-${num}`,
              url: finalUrl,
            }));
            break;
          }
        }
      }
    });

    // Deduplicate by episode number and sort
    const seen = new Set();
    const unique = [];
    for (const ep of episodes) {
      if (!seen.has(ep.number)) {
        seen.add(ep.number);
        unique.push(ep);
      }
    }

    unique.sort((a, b) => a.number - b.number);
    return unique;
  }
}
