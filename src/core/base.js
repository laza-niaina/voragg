/**
 * Base classes that define the interface for platforms and players.
 * Subclasses must implement the documented methods.
 */

export class VideoPlayer {
  get name() {
    throw new Error('Subclass must implement get name()');
  }

  async extractDirectUrl(url) {
    throw new Error('Subclass must implement extractDirectUrl()');
  }
}

export class BaseEpisode {
  constructor({ number, name, url }) {
    this.number = number;
    this.name = name;
    this.url = url;
  }

  async getPlayerUrl() {
    throw new Error('Subclass must implement getPlayerUrl()');
  }
}

export class Platform {
  get name() {
    throw new Error('Subclass must implement get name()');
  }

  async getEpisodes(seriesUrl) {
    throw new Error('Subclass must implement getEpisodes()');
  }
}
