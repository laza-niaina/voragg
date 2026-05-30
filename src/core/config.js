export const SupportedPlayers = Object.freeze({
  STREAMTAPE: 'streamtape',
  VIDMOLY: 'vidmoly',
});

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_OUTPUT = '.';
export const DEFAULT_PLAYER = SupportedPlayers.STREAMTAPE;
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 5000;
export const DOWNLOAD_CHUNK_SIZE = 8192;
