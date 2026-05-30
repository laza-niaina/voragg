let config = {
  port: parseInt(process.env.PORT || '3000', 10),
  defaultOutputDir: '.',
  defaultPlayer: 'streamtape',
  defaultMaxConcurrent: 3,
  quality: null,
};

export function getConfig() {
  return { ...config };
}

export function updateConfig(partial) {
  if (partial.defaultOutputDir !== undefined) config.defaultOutputDir = partial.defaultOutputDir;
  if (partial.defaultPlayer !== undefined) config.defaultPlayer = partial.defaultPlayer;
  if (partial.defaultMaxConcurrent !== undefined) config.defaultMaxConcurrent = partial.defaultMaxConcurrent;
  if (partial.quality !== undefined) config.quality = partial.quality;
  if (partial.port !== undefined && !isNaN(partial.port)) config.port = partial.port;
  return getConfig();
}
