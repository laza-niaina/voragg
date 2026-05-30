import axios from 'axios';
import { VideoPlayer } from '../../core/base.js';
import { getHeaders } from '../../userAgent.js';
export class StreamtapePlayer extends VideoPlayer {
  get name() {
    return 'streamtape';
  }

  async extractDirectUrl(url) {
    const response = await axios.get(url, {
      headers: getHeaders('https://voir-anime.to/'),
    });

    const html = response.data;


    // Find the obfuscated botlink pattern:
    // document.getElementById('botlink').innerHTML = 'PREFIX' + ('TOKEN').substring(OFFSET)
    const regex = /document\.getElementById\('botlink'\)\.innerHTML\s*=\s*'([^']*)'\s*\+\s*\('([^']*)'\)\.substring\((\d+)\)/;
    const match = html.match(regex);
    if (!match) {
      // Fallback: try alternate pattern without quotes around botlink
      const altRegex = /document\.getElementById\(\"botlink\"\)\.innerHTML\s*=\s*'([^']*)'\s*\+\s*\('([^']*)'\)\.substring\((\d+)\)/;
      const altMatch = html.match(altRegex);
      if (!altMatch) {
        throw new Error('Could not find streamtape botlink pattern');
      }
      return this._buildUrl(altMatch, url);
    }

    return this._buildUrl(match, url);
  }

  async _buildUrl(match, originalUrl) {
    const prefix = match[1];
    const tokenString = match[2];
    const offset = parseInt(match[3], 10);

    const suffix = tokenString.substring(offset);
    let result = prefix + suffix;

    // Handle various URL formats
    if (result.startsWith('//')) {
      result = 'https:' + result;
    } else if (result.startsWith('/')) {
      result = 'https://streamtape.com' + result;
    }

    // Append stream=1 to trigger redirect
    const separator = result.includes('?') ? '&' : '?';
    result = `${result}${separator}stream=1`;

    // Follow the redirect to get the actual content URL
    const redirectResponse = await axios.get(result, {
      headers: getHeaders(originalUrl),
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const location = redirectResponse.headers['location'];
    if (!location) {
      throw new Error('No redirect location from streamtape');
    }

    return location;
  }
}
