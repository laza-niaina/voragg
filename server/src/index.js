import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { getConfig, updateConfig } from './config.js';
import { SseManager } from './services/sseManager.js';
import { JobManager } from './services/jobManager.js';
import { VoirAnimePlatform } from '../../src/extractors/platforms/voiranime.js';
import { extractEpisodeNumber } from '../../src/utils.js';

// Local scraping tool — some target sites have self-signed or non-standard TLS certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Prevent crash on unhandled errors — log and continue
process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${err.stack}`);
});

// --- Globals ---
const sseManager = new SseManager();
const jobManager = new JobManager(sseManager);
const config = getConfig();

// --- Helpers ---
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.replace(/\/$/,'').split('/').filter(Boolean);
  return { url, parts, query: url.searchParams };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// --- Route handlers ---

async function handleSeries(req, res, query) {
  const seriesUrl = query.get('url');
  if (!seriesUrl) return sendJson(res, 400, { error: "Missing 'url' query parameter" });

  const platform = new VoirAnimePlatform();
  const episodes = await platform.getEpisodes(seriesUrl);
  sendJson(res, 200, {
    series: { url: seriesUrl },
    episodes: episodes.map(ep => ({ number: ep.number, title: ep.name, url: ep.url })),
  });
}

async function handleCreateDownload(req, res) {
  const body = await readBody(req);
  const { episodes, outputDir, player, quality, maxConcurrent } = body;
  if (!episodes || !Array.isArray(episodes) || episodes.length === 0)
    return sendJson(res, 400, { error: "Missing episodes array" });

  const job = jobManager.createJob(episodes, { outputDir, player, quality, maxConcurrent });
  sendJson(res, 202, { jobId: job.jobId, status: job.status, episodeCount: episodes.length, createdAt: job.createdAt });
}

async function handleSingleDownload(req, res) {
  const body = await readBody(req);
  const { url, outputDir, player, quality } = body;
  if (!url) return sendJson(res, 400, { error: "Missing 'url' field" });

  const epNum = extractEpisodeNumber(url);
  const job = jobManager.createJob([{
    number: epNum,
    title: `Episode ${epNum}`,
    url,
  }], { outputDir, player, quality, maxConcurrent: 1 });
  sendJson(res, 202, { jobId: job.jobId, status: job.status, episodeCount: 1, createdAt: job.createdAt });
}

function handleListDownloads(req, res) {
  sendJson(res, 200, { jobs: jobManager.getAllJobs() });
}

function handleGetDownload(req, res, parts) {
  const jobId = parts[2];
  const job = jobManager.getJob(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  sendJson(res, 200, job.toJSON());
}

function handleCancelDownload(req, res, parts) {
  const jobId = parts[2];
  const job = jobManager.cancelJob(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  sendJson(res, 200, { jobId: job.jobId, status: job.status });
}

function handleDeleteFile(req, res, parts) {
  const jobId = parts[2];
  const episodeNumber = parseInt(parts[4], 10);
  const job = jobManager.getJob(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  const result = job.deleteFile(episodeNumber);
  if (result.error) return sendJson(res, 400, { error: result.error });
  sendJson(res, 200, { jobId, episode: episodeNumber, path: result.path, status: 'deleted' });
}

function handleSseProgress(req, res, parts) {
  const jobId = parts[2];
  const job = jobManager.getJob(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`event: connected\ndata: {"jobId":"${jobId}"}\n\n`);

  const heartbeat = setInterval(() => {
    try { if (!res.writableEnded) res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30000);

  sseManager.addClient(jobId, res);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
}

function handleGetConfig(req, res) {
  sendJson(res, 200, getConfig());
}

async function handleUpdateConfig(req, res) {
  const body = await readBody(req);
  const updated = updateConfig(body);
  sendJson(res, 200, updated);
}

function handleHealth(req, res) {
  sendJson(res, 200, { status: 'ok', version: '1.0.0' });
}

// --- Router ---

async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const { parts, query } = parseUrl(req);
    const method = req.method;

    // GET /api/health
    if (method === 'GET' && parts[1] === 'health' && parts.length === 2)
      return handleHealth(req, res);

    // /api/series/*
    if (parts[1] === 'series' && parts[2] === 'episodes' && method === 'GET')
      return await handleSeries(req, res, query);

    // /api/download — single episode URL
    if (parts[1] === 'download' && parts.length === 2 && method === 'POST')
      return await handleSingleDownload(req, res);

    // /api/downloads/:jobId/progress (SSE — must be before /api/downloads/:jobId)
    if (parts[1] === 'downloads' && parts.length === 4 && parts[3] === 'progress' && method === 'GET')
      return handleSseProgress(req, res, parts);

    // /api/downloads/:jobId/files/:episode
    if (parts[1] === 'downloads' && parts.length === 5 && parts[3] === 'files' && method === 'DELETE')
      return handleDeleteFile(req, res, parts);

    // /api/downloads/:jobId
    if (parts[1] === 'downloads' && parts.length === 3) {
      if (method === 'GET') return handleGetDownload(req, res, parts);
      if (method === 'DELETE') return handleCancelDownload(req, res, parts);
    }

    // /api/downloads
    if (parts[1] === 'downloads' && parts.length === 2) {
      if (method === 'POST') return await handleCreateDownload(req, res);
      if (method === 'GET') return handleListDownloads(req, res);
    }

    // /api/config
    if (parts[1] === 'config' && parts.length === 2) {
      if (method === 'GET') return handleGetConfig(req, res);
      if (method === 'PUT') return await handleUpdateConfig(req, res);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}: ${err.message}`);
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
}

// --- Start ---
const server = http.createServer(handler);
server.listen(config.port, () => {
  console.log(`voragg API server running on http://localhost:${config.port}`);
  console.log(`  Health: http://localhost:${config.port}/api/health`);
  console.log(`  SSE:    http://localhost:${config.port}/api/downloads/<jobId>/progress`);
  console.log('---');
});
