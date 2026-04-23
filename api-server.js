const express = require('express');
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

app.use(express.json());

function getYoutubeUrlFromRequest(req) {
  const fromNamedParams = req.query.url || req.query.link || req.query.yt || req.query.v;
  if (fromNamedParams) return String(fromNamedParams).trim();

  // Supports pattern like /api/jrm?=https://youtube.com/watch?v=...
  const originalUrl = req.originalUrl || '';
  const idx = originalUrl.indexOf('?=');
  if (idx >= 0) {
    const raw = originalUrl.slice(idx + 2);
    return decodeURIComponent(raw).trim();
  }

  return '';
}

function normalizeYoutubeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Try direct valid URL first.
  if (ytdl.validateURL(raw)) {
    const id = ytdl.getURLVideoID(raw);
    return `https://www.youtube.com/watch?v=${id}`;
  }

  // Try decoding, then parse ID from messy links.
  const decoded = decodeURIComponent(raw);
  try {
    const id = ytdl.getURLVideoID(decoded);
    return `https://www.youtube.com/watch?v=${id}`;
  } catch (_) {
    // fallback below
  }

  // Last fallback: extract 11-char video ID.
  const idMatch = decoded.match(/([a-zA-Z0-9_-]{11})/);
  if (idMatch) {
    return `https://www.youtube.com/watch?v=${idMatch[1]}`;
  }

  return null;
}

function bytesToMB(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return 0;
  return Math.round((Number(bytes) / (1024 * 1024)) * 100) / 100;
}

function bytesToMBText(bytes) {
  return `${bytesToMB(bytes)} MB`;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function guessResolutionFromQuality(qualityLabel) {
  const map = {
    '2160p': '3840x2160',
    '1440p': '2560x1440',
    '1080p': '1920x1080',
    '720p': '1280x720',
    '480p': '854x480',
    '360p': '640x360',
    '240p': '426x240',
    '144p': '256x144'
  };
  return map[qualityLabel] || null;
}

function getResolutionText(format) {
  if (format && format.width && format.height) {
    return `${format.width}x${format.height}`;
  }
  return guessResolutionFromQuality(format?.qualityLabel || format?.quality) || null;
}

function toDownloadApi(normalizedUrl, itag, type) {
  return `/api/jrm/download?url=${encodeURIComponent(normalizedUrl)}&itag=${encodeURIComponent(itag)}&type=${encodeURIComponent(type)}`;
}

function toSupabaseSaveApi(normalizedUrl, itag, type) {
  return `/api/jrm/save-supabase?url=${encodeURIComponent(normalizedUrl)}&itag=${encodeURIComponent(itag)}&type=${encodeURIComponent(type)}`;
}

function toCloudDownloadApi(normalizedUrl, itag, type) {
  return `/api/jrm/cloud-download?url=${encodeURIComponent(normalizedUrl)}&itag=${encodeURIComponent(itag)}&type=${encodeURIComponent(type)}`;
}

function sanitizeFileBaseName(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'video';
}

function extensionFromFormat(format, typeHint) {
  const mime = String(format?.mimeType || '').toLowerCase();
  if (typeHint === 'mp3') return 'mp3';
  if (mime.includes('video/mp4')) return 'mp4';
  if (mime.includes('audio/mp4')) return 'm4a';
  if (mime.includes('audio/webm') || mime.includes('video/webm')) return 'webm';
  return typeHint === 'mp4' ? 'mp4' : 'bin';
}

async function resolveFormatSizeBytes(format) {
  const fromField = Number(format?.contentLength || 0);
  if (fromField > 0) return fromField;

  try {
    const head = await axios.head(format.url, {
      maxRedirects: 5,
      timeout: 15000,
      headers: getBaseRequestOptions().headers
    });
    const len = Number(head.headers['content-length'] || 0);
    return Number.isFinite(len) ? len : 0;
  } catch (_) {
    return 0;
  }
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const bucket = process.env.SUPABASE_BUCKET || 'videos';
  return { url, serviceRoleKey, bucket };
}

function getSupabaseClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function buildSupabaseRecommendations(info, type, maxBytes) {
  const source = (info?.formats || []).filter((f) => f.url);
  const mapped = type === 'mp3'
    ? source
      .filter((f) => f.hasAudio && !f.hasVideo)
      .map((f) => {
        const sizeBytes = Number(f.contentLength || 0);
        return {
          itag: f.itag,
          type: 'mp3',
          quality: `${f.audioBitrate || 0}kbps`,
          resolution: null,
          sizeBytes,
          sizeMB: bytesToMB(sizeBytes)
        };
      })
    : source
      .filter((f) => (f.mimeType || '').includes('video/mp4'))
      .map((f) => {
        const sizeBytes = Number(f.contentLength || 0);
        return {
          itag: f.itag,
          type: 'mp4',
          quality: f.qualityLabel || f.quality || 'unknown',
          resolution: getResolutionText(f),
          sizeBytes,
          sizeMB: bytesToMB(sizeBytes)
        };
      });

  return mapped
    .filter((x) => x.sizeBytes > 0 && x.sizeBytes <= maxBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function getVideoIdFromWatchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('v') || '';
  } catch (_) {
    return '';
  }
}

function parseCookieHeaderToYtdlCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return [];
  return cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return null;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: '.youtube.com',
        path: '/',
        secure: true,
        httpOnly: false
      };
    })
    .filter(Boolean);
}

function getBaseRequestOptions() {
  return {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };
}

async function getInfoWithRetries(normalizedUrl) {
  const attempts = [];
  const cookieHeader = process.env.YT_COOKIE || '';
  const cookies = parseCookieHeaderToYtdlCookies(cookieHeader);
  const agent = cookies.length ? ytdl.createAgent(cookies) : null;

  console.log(`[DEBUG] Fetching info for ${normalizedUrl}, cookies present: ${!!cookieHeader}`);

  const variants = [
    { name: 'ANDROID', options: { playerClients: ['ANDROID'] } },
    { name: 'ANDROID_EMBED', options: { playerClients: ['ANDROID_EMBED'] } },
    { name: 'IOS', options: { playerClients: ['IOS'] } },
    { name: 'IOS_EMBED', options: { playerClients: ['IOS_EMBED'] } },
    { name: 'TV', options: { playerClients: ['TV'] } },
    { name: 'WEB', options: { playerClients: ['WEB'] } },
    { name: 'WEB_EMBED', options: { playerClients: ['WEB_EMBED'] } },
    { name: 'MWEB', options: { playerClients: ['MWEB'] } },
    { name: 'ANDROID+WEB', options: { playerClients: ['ANDROID', 'WEB'] } }
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      console.log(`[DEBUG] Trying strategy: ${variant.name}`);
      const info = await ytdl.getInfo(normalizedUrl, {
        ...variant.options,
        requestOptions: getBaseRequestOptions(),
        ...(agent ? { agent } : {})
      });
      console.log(`[DEBUG] Success with strategy: ${variant.name}, formats: ${(info.formats || []).length}`);
      return { info, strategy: variant.name };
    } catch (err) {
      console.log(`[DEBUG] Failed strategy ${variant.name}: ${err && err.message ? String(err.message) : 'Unknown error'}`);
      lastError = err;
      attempts.push({
        strategy: variant.name,
        error: err && err.message ? String(err.message) : 'Unknown error'
      });
    }
  }

  console.log(`[DEBUG] All strategies failed, attempts:`, attempts);
  if (lastError) {
    lastError.attempts = attempts;
  }
  throw lastError || new Error('Failed to fetch video info');
}

async function buildFallbackPayload(url, originalError) {
  const videoId = getVideoIdFromWatchUrl(url);
  let oembed = null;
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await axios.get(endpoint, { timeout: 10000 });
    oembed = resp.data;
  } catch (_) {
    // ignore fallback errors
  }

  return {
    app: 'ytdl-ph',
    success: true,
    partial: true,
    endpoint: '/api/jrm',
    sourceUrl: url,
    normalizedUrl: url,
    thumbnail: oembed?.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''),
    size: {
      totalFormats: 0,
      mp4Formats: 0,
      mp3Formats: 0,
      bestMp4Bytes: 0,
      bestMp4MB: 0
    },
    mp4: [],
    mp3: [],
    downloads: [],
    madebyJhamesMartin: 'JhamesMartin',
    details: {
      videoId,
      title: oembed?.title || '',
      description: '',
      durationSeconds: 0,
      durationText: '0:00',
      views: 0,
      publishDate: null,
      isLive: false,
      channelName: oembed?.author_name || '',
      channelId: '',
      keywords: []
    },
    warning: 'Limited data only. Video source is currently blocked on this server IP. Try another video, lower quality, or set YT_COOKIE environment variable with YouTube cookies.',
    originalError
  };
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YTDL PH</title>
  <style>
    :root {
      --bg: #080a14;
      --bg2: #141827;
      --card: #111428;
      --line: #252a43;
      --text: #f5f7ff;
      --muted: #adb6d9;
      --brand: #ff2d55;
      --brand2: #ff6b6b;
      --ok: #22c55e;
      --err: #ff4d4f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 10% -15%, #3a1e3a, transparent 45%),
        radial-gradient(circle at 90% -15%, #242f6b, transparent 45%),
        linear-gradient(180deg, var(--bg2), var(--bg));
      min-height: 100vh;
      padding: 22px;
    }
    .wrap { max-width: 1060px; margin: 0 auto; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .logo {
      font-weight: 900;
      letter-spacing: .5px;
      font-size: 28px;
      margin: 0;
    }
    .logo span { color: var(--brand); }
    .sub {
      color: var(--muted);
      margin: 0;
      font-size: 13px;
    }
    .card {
      background: linear-gradient(180deg, #131832 0%, #0d1227 100%);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    .hero {
      margin-bottom: 14px;
    }
    .hero h2 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.1;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
    }
    .search {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      margin: 16px 0 10px;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      background: #0a0f22;
      color: var(--text);
      border-radius: 10px;
      padding: 12px;
      font-size: 15px;
    }
    button {
      border: 1px solid #55203b;
      border-radius: 10px;
      padding: 12px 18px;
      font-weight: 700;
      cursor: pointer;
      background: linear-gradient(135deg, var(--brand), var(--brand2));
      color: #fff;
    }
    .btn-secondary {
      background: #111935;
      border: 1px solid #2c3150;
      color: #dbe3ff;
    }
    .btn-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .gen-status {
      font-size: 12px;
      color: var(--muted);
      align-self: center;
    }
    .meta { margin: 14px 0; display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 10px; }
    .chip { border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: #0b1220; }
    .chip b { display: block; font-size: 13px; color: var(--muted); margin-bottom: 3px; }
    .preview {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b1022;
      padding: 12px;
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 14px;
    }
    .thumb {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #020617;
    }
    .title { margin: 0 0 8px; font-size: 20px; }
    .desc { margin: 0; color: var(--muted); line-height: 1.4; font-size: 14px; }
    .section-title { margin: 16px 0 8px; font-weight: 800; letter-spacing:.3px; }
    .dual {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .dl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
    }
    .dl-btn {
      display: block;
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: #020617;
      color: var(--text);
    }
    .dl-btn b { display: block; color: #fda4af; margin-bottom: 3px; }
    .small { color: var(--muted); font-size: 12px; }
    .hidden { display: none; }
    .warn {
      margin-top: 10px;
      color: #ffd584;
      font-size: 12px;
      border: 1px solid rgba(255, 174, 66, .35);
      background: rgba(255, 174, 66, .12);
      border-radius: 8px;
      padding: 8px;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      border: 1px solid #2c3150;
      background: #111935;
      color: #c4b5fd;
      font-size: 12px;
      margin-right: 6px;
    }
    .footer-note {
      margin-top: 10px;
      color: #8893bf;
      font-size: 12px;
    }
    .ok { color: var(--ok); }
    .err { color: var(--err); }
    code { color: #fda4af; }
    @media (max-width: 760px) {
      .search { grid-template-columns: 1fr; }
      .preview { grid-template-columns: 1fr; }
      .dual { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1 class="logo">YTDL <span>PH</span></h1>
        <p class="sub">Fast YouTube downloader interface for MP4/MP3 links</p>
      </div>
      <p class="sub">Secure mode enabled</p>
    </div>
    <div class="card">
      <div class="hero">
        <h2>YouTube Downloader, Pinoy style.</h2>
        <p>Paste any YouTube URL. Click search. Pick MP4 or MP3 quality and download.</p>
      </div>
      <div class="search">
        <input id="yt" value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
        <button id="run">Get Video</button>
      </div>
      <div class="btn-row">
        <button id="generateBtn" class="btn-secondary hidden">Download</button>
        <span id="genStatus" class="gen-status hidden"></span>
      </div>
      <div class="meta">
        <div class="chip"><b>Status</b><span id="status">Ready</span></div>
        <div class="chip"><b>Service</b><span>ytdl-ph</span></div>
        <div class="chip"><b>Made By</b><span>JhamesMartin</span></div>
      </div>
      <div id="result" class="preview hidden">
        <img id="thumb" class="thumb" alt="thumbnail" />
        <div>
          <h2 id="title" class="title"></h2>
          <p id="desc" class="desc"></p>
          <div style="margin-top:10px;">
            <span id="badgeExtractor" class="badge">Extractor: -</span>
            <span id="badgeMode" class="badge">Mode: -</span>
          </div>
          <div class="meta">
            <div class="chip"><b>Video ID</b><span id="videoId">-</span></div>
            <div class="chip"><b>Duration</b><span id="duration">-</span></div>
            <div class="chip"><b>Views</b><span id="views">-</span></div>
            <div class="chip"><b>Channel</b><span id="channel">-</span></div>
          </div>
          <div id="optionsWrap" class="dual hidden">
            <div>
              <div class="section-title">MP4 Downloads</div>
              <div id="downloadsMp4" class="dl-grid"></div>
            </div>
            <div>
              <div class="section-title">MP3 Downloads</div>
              <div id="downloadsMp3" class="dl-grid"></div>
            </div>
          </div>
          <div id="warn" class="warn hidden"></div>
          <div class="footer-note">Each option processes on click, then auto-download starts. Uploaded cloud file is auto-deleted after 1 minute.</div>
        </div>
      </div>
    </div>
  </div>
<script>
  const runBtn = document.getElementById('run');
  const generateBtn = document.getElementById('generateBtn');
  const genStatusEl = document.getElementById('genStatus');
  const input = document.getElementById('yt');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  const optionsWrapEl = document.getElementById('optionsWrap');
  const thumbEl = document.getElementById('thumb');
  const titleEl = document.getElementById('title');
  const descEl = document.getElementById('desc');
  const videoIdEl = document.getElementById('videoId');
  const durationEl = document.getElementById('duration');
  const viewsEl = document.getElementById('views');
  const channelEl = document.getElementById('channel');
  const downloadsMp4El = document.getElementById('downloadsMp4');
  const downloadsMp3El = document.getElementById('downloadsMp3');
  const warnEl = document.getElementById('warn');
  const badgeExtractor = document.getElementById('badgeExtractor');
  const badgeMode = document.getElementById('badgeMode');
  let lastData = null;

  function fmtViews(n) {
    const num = Number(n || 0);
    if (!num) return '0';
    return num.toLocaleString();
  }

  function dedupeWarningText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';

    const lines = raw.split(/\\n+/).map((x) => x.trim()).filter(Boolean);
    if (lines.length > 1) {
      const uniq = [];
      const seen = new Set();
      lines.forEach((line) => {
        if (!seen.has(line)) {
          seen.add(line);
          uniq.push(line);
        }
      });
      return uniq.join(' ');
    }

    if (raw.length % 2 === 0) {
      const half = raw.length / 2;
      const a = raw.slice(0, half).trim();
      const b = raw.slice(half).trim();
      if (a && a === b) return a;
    }

    return raw;
  }

  function renderOne(container, list, emptyText) {
    container.innerHTML = '';
    if (!list || !list.length) {
      container.innerHTML = '<div class="small">' + emptyText + '</div>';
      return;
    }
    const maxUploadBytes = Number(lastData?.size?.maxCloudUploadBytes || 0);
    list.slice(0, 12).forEach((item) => {
      const a = document.createElement('a');
      a.className = 'dl-btn';
      const cloudEligible = !!item.cloudEligible;
      a.href = cloudEligible ? (item.cloudDownloadApi || item.downloadApi || item.url) : '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (cloudEligible) {
        a.addEventListener('click', () => {
          genStatusEl.textContent = 'Processing selected option... upload + download in progress.';
          genStatusEl.classList.remove('hidden');
        });
      }
      const res = item.resolution || '-';
      const size = item.sizeMB ? item.sizeMB + ' MB' : '-';
      const knownSize = Number(item.sizeBytes || 0);
      const tooLarge = maxUploadBytes > 0 && knownSize > maxUploadBytes;
      const saveHint = tooLarge
        ? '<div class="small" style="color:#fda4af">Too large for cloud save limit (50MB). Use lower resolution.</div>'
        : '<div class="small">Cloud process: ready</div>';
      if (!cloudEligible) {
        a.style.pointerEvents = 'none';
        a.style.opacity = '0.65';
      }
      a.innerHTML = '<b>' + item.type.toUpperCase() + ' ' + (item.quality || '') + '</b>' +
        '<div class="small">Resolution: ' + res + '</div>' +
        '<div class="small">Size: ' + size + '</div>' +
        saveHint +
        '<div class="small">' + (cloudEligible ? 'Process and download' : 'Pick lower resolution') + '</div>';
      container.appendChild(a);
    });
  }

  function renderDownloads(data) {
    const mp4 = data.mp4 || [];
    const mp3 = data.mp3 || [];
    const total = mp4.length + mp3.length;

    if (!total && data.warning) {
      renderOne(downloadsMp4El, mp4, 'No MP4 links available right now.');
      renderOne(downloadsMp3El, mp3, 'No MP3 links available right now.');
      return;
    }

    renderOne(downloadsMp4El, mp4, 'No MP4 links available.');
    renderOne(downloadsMp3El, mp3, 'No MP3 links available.');

    const rec = data.storage && data.storage.recommendedMp4 ? data.storage.recommendedMp4 : [];
    if (rec.length) {
      const best = rec[0];
      const recText = best.resolution ? (best.quality + ' (' + best.resolution + ')') : best.quality;
      warnEl.textContent = 'For cloud save (max 50MB), recommended lower option: ' + recText + ' ~ ' + best.sizeMB + ' MB';
      warnEl.classList.remove('hidden');
    }
  }

  runBtn.addEventListener('click', async () => {
    const link = input.value.trim();
    if (!link) return;
    statusEl.textContent = 'Loading...';
    statusEl.className = '';
    resultEl.classList.add('hidden');
    optionsWrapEl.classList.add('hidden');
    generateBtn.classList.add('hidden');
    genStatusEl.classList.add('hidden');
    genStatusEl.textContent = '';
    try {
      const route = '/a' + 'pi/jrm';
      const res = await fetch(route + '?url=' + encodeURIComponent(link));
      const data = await res.json();
      statusEl.textContent = res.ok ? 'Success' : 'Error';
      statusEl.className = res.ok ? 'ok' : 'err';
      if (!data.success) {
        statusEl.textContent = data.error || 'Error';
        return;
      }
      const d = data.details || {};
      warnEl.classList.add('hidden');
      warnEl.textContent = '';
      thumbEl.src = data.thumbnail || '';
      titleEl.textContent = d.title || 'No title';
      descEl.textContent = d.description || 'No description';
      videoIdEl.textContent = d.videoId || '-';
      durationEl.textContent = d.durationText || '0:00';
      viewsEl.textContent = fmtViews(d.views);
      channelEl.textContent = d.channelName || '-';
      badgeExtractor.textContent = 'Extractor: ' + (data.extractor || '-');
      badgeMode.textContent = 'Mode: ' + (data.partial ? 'Partial' : 'Full');
      lastData = data;
      generateBtn.classList.remove('hidden');
      if (data.warning) {
        warnEl.textContent = dedupeWarningText(data.warning);
        warnEl.classList.remove('hidden');
      }
      resultEl.classList.remove('hidden');
    } catch (err) {
      statusEl.textContent = 'Network error';
      statusEl.className = 'err';
    }
  });

  generateBtn.addEventListener('click', async () => {
    if (!lastData) return;
    generateBtn.disabled = true;
    genStatusEl.textContent = 'Generating download options...';
    genStatusEl.classList.remove('hidden');
    optionsWrapEl.classList.add('hidden');

    // Keep UX clear: user sees processing before options appear.
    await new Promise((r) => setTimeout(r, 650));

    renderDownloads(lastData);
    optionsWrapEl.classList.remove('hidden');
    genStatusEl.textContent = 'Options ready.';
    generateBtn.disabled = false;
  });
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'ytdl-ph',
    madebyJhamesMartin: 'JhamesMartin',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/jrm', async (req, res) => {
  try {
    const url = getYoutubeUrlFromRequest(req);
    const normalizedUrl = normalizeYoutubeUrl(url);

    if (!normalizedUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing YouTube URL',
        message: 'Use /api/jrm?url=YOUTUBE_LINK or /api/jrm?=YOUTUBE_LINK'
      });
    }

    const infoResult = await getInfoWithRetries(normalizedUrl);
    const info = infoResult.info;
    const thumbnails = info.videoDetails?.thumbnails || [];
    const bestThumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : '';

    const mp4Formats = (info.formats || [])
      .filter((f) => f.hasVideo && f.url)
      .map((f) => {
        const sizeBytes = Number(f.contentLength || 0);
        return {
          itag: f.itag,
          quality: f.qualityLabel || f.quality || 'unknown',
          type: 'mp4',
          mimeType: f.mimeType || 'video/mp4',
          resolution: getResolutionText(f),
          sizeBytes,
          sizeMB: bytesToMB(sizeBytes),
          fps: f.fps || null,
          hasAudio: !!f.hasAudio,
          hasVideo: !!f.hasVideo,
          supabaseEligible: sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES,
          cloudEligible: sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES,
          url: f.url,
          downloadApi: toDownloadApi(normalizedUrl, f.itag, 'mp4'),
          saveToSupabaseApi: toSupabaseSaveApi(normalizedUrl, f.itag, 'mp4'),
          cloudDownloadApi: toCloudDownloadApi(normalizedUrl, f.itag, 'mp4')
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const mp3Formats = (info.formats || [])
      .filter((f) => f.hasAudio && !f.hasVideo && f.url)
      .map((f) => {
        const sizeBytes = Number(f.contentLength || 0);
        return {
          itag: f.itag,
          quality: `${f.audioBitrate || 0}kbps`,
          type: 'mp3',
          mimeType: f.mimeType || 'audio/mp4',
          resolution: null,
          sizeBytes,
          sizeMB: bytesToMB(sizeBytes),
          audioBitrate: f.audioBitrate || 0,
          supabaseEligible: sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES,
          cloudEligible: sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES,
          url: f.url,
          downloadApi: toDownloadApi(normalizedUrl, f.itag, 'mp3'),
          saveToSupabaseApi: toSupabaseSaveApi(normalizedUrl, f.itag, 'mp3'),
          cloudDownloadApi: toCloudDownloadApi(normalizedUrl, f.itag, 'mp3')
        };
      })
      .sort((a, b) => b.audioBitrate - a.audioBitrate || b.sizeBytes - a.sizeBytes);

    const bestMp4 = mp4Formats[0] || null;
    const downloads = [...mp4Formats, ...mp3Formats];
    const recommendedMp4 = mp4Formats
      .filter((x) => x.sizeBytes > 0 && x.sizeBytes <= MAX_UPLOAD_BYTES)
      .slice()
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .map((x) => ({
        itag: x.itag,
        quality: x.quality,
        resolution: x.resolution,
        sizeBytes: x.sizeBytes,
        sizeMB: x.sizeMB
      }));
    const recommendedMp3 = mp3Formats
      .filter((x) => x.sizeBytes > 0 && x.sizeBytes <= MAX_UPLOAD_BYTES)
      .slice()
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .map((x) => ({
        itag: x.itag,
        quality: x.quality,
        resolution: null,
        sizeBytes: x.sizeBytes,
        sizeMB: x.sizeMB
      }));

    res.json({
      app: 'ytdl-ph',
      success: true,
      endpoint: '/api/jrm',
      queryExample: '/api/jrm?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      sourceUrl: url,
      normalizedUrl,
      extractor: infoResult.strategy,
      thumbnail: bestThumbnail,
      size: {
        totalFormats: (info.formats || []).length,
        mp4Formats: mp4Formats.length,
        mp3Formats: mp3Formats.length,
        maxSupabaseUploadBytes: MAX_UPLOAD_BYTES,
        maxSupabaseUploadMB: bytesToMB(MAX_UPLOAD_BYTES),
        maxCloudUploadBytes: MAX_UPLOAD_BYTES,
        maxCloudUploadMB: bytesToMB(MAX_UPLOAD_BYTES),
        bestMp4Bytes: bestMp4 ? bestMp4.sizeBytes : 0,
        bestMp4MB: bestMp4 ? bestMp4.sizeMB : 0
      },
      storage: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxUploadMB: bytesToMB(MAX_UPLOAD_BYTES),
        recommendedMp4,
        recommendedMp3
      },
      supabase: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxUploadMB: bytesToMB(MAX_UPLOAD_BYTES),
        recommendedMp4,
        recommendedMp3
      },
      mp4: mp4Formats,
      mp3: mp3Formats,
      downloads,
      madebyJhamesMartin: 'JhamesMartin',
      details: {
        videoId: info.videoDetails?.videoId || '',
        title: info.videoDetails?.title || '',
        description: info.videoDetails?.description || '',
        durationSeconds: Number(info.videoDetails?.lengthSeconds || 0),
        durationText: formatDuration(info.videoDetails?.lengthSeconds),
        views: Number(info.videoDetails?.viewCount || 0),
        publishDate: info.videoDetails?.publishDate || null,
        isLive: !!info.videoDetails?.isLiveContent,
        channelName: info.videoDetails?.author?.name || info.videoDetails?.ownerChannelName || '',
        channelId: info.videoDetails?.channelId || '',
        keywords: info.videoDetails?.keywords || []
      }
    });
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'Unknown error';
    const isExtractionBlocked = /not a bot|too many requests|playable formats|status code:\s*(410|429)/i.test(message);
    if (isExtractionBlocked) {
      const raw = getYoutubeUrlFromRequest(req);
      const normalized = normalizeYoutubeUrl(raw) || raw;
      const fallback = await buildFallbackPayload(normalized, message);
      return res.status(200).json(fallback);
    }

    res.status(500).json({
      success: false,
      error: message,
      message: 'Failed to fetch video details'
    });
  }
});

app.get('/api/jrm/download', async (req, res) => {
  try {
    const rawUrl = req.query.url ? String(req.query.url) : '';
    const itag = Number(req.query.itag || 0);
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);

    if (!normalizedUrl || !itag) {
      return res.status(400).json({
        success: false,
        error: 'Missing url/itag',
        message: 'Use /api/jrm/download?url=YOUTUBE_LINK&itag=FORMAT_ITAG&type=mp4|mp3'
      });
    }

    const { info } = await getInfoWithRetries(normalizedUrl);
    const format = (info.formats || []).find((f) => Number(f.itag) === itag && f.url);

    if (!format) {
      return res.status(404).json({
        success: false,
        error: 'Format not found',
        message: 'Requested itag is unavailable for this video now. Refresh and try again.'
      });
    }

    // Redirect to a freshly generated source URL on each click.
    // This avoids stale links without proxying video bytes through Render.
    return res.redirect(format.url);
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'Download failed';
    res.status(500).json({
      success: false,
      error: message,
      message: 'Unable to stream download right now. Please retry.'
    });
  }
});

app.get('/api/jrm/save-supabase', async (req, res) => {
  try {
    const rawUrl = req.query.url ? String(req.query.url) : '';
    const itag = Number(req.query.itag || 0);
    const type = String(req.query.type || '').toLowerCase();
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);

    if (!normalizedUrl || !itag || !['mp4', 'mp3'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid params',
        message: 'Use /api/jrm/save-supabase?url=YOUTUBE_LINK&itag=FORMAT_ITAG&type=mp4|mp3'
      });
    }

    const supabase = getSupabaseClient();
    const { url: supabaseUrl, bucket } = getSupabaseConfig();
    if (!supabase || !supabaseUrl) {
      return res.status(500).json({
        success: false,
        error: 'Supabase not configured',
        message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Render'
      });
    }

    const { info } = await getInfoWithRetries(normalizedUrl);
    const format = (info.formats || []).find((f) => Number(f.itag) === itag && f.url);
    if (!format) {
      return res.status(404).json({
        success: false,
        error: 'Format not found',
        message: 'Refresh video info and try again'
      });
    }

    const sizeBytes = await resolveFormatSizeBytes(format);
    if (!sizeBytes) {
      const recommendedLowerOptions = buildSupabaseRecommendations(info, type, MAX_UPLOAD_BYTES);
      return res.status(400).json({
        success: false,
        error: 'Unknown file size',
        message: `Cannot verify file size. Only files up to ${bytesToMBText(MAX_UPLOAD_BYTES)} are accepted.`,
        recommendedLowerOptions,
        recommendationMessage: recommendedLowerOptions.length
          ? `Pick lower quality (<= ${bytesToMBText(MAX_UPLOAD_BYTES)}).`
          : 'No recommended lower option with known size found.'
      });
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      const recommendedLowerOptions = buildSupabaseRecommendations(info, type, MAX_UPLOAD_BYTES);
      return res.status(400).json({
        success: false,
        error: 'File too large',
        message: `Only files up to ${bytesToMBText(MAX_UPLOAD_BYTES)} are allowed`,
        sizeBytes,
        sizeMB: bytesToMB(sizeBytes),
        recommendedLowerOptions,
        recommendationMessage: recommendedLowerOptions.length
          ? 'Use lower resolution/bitrate. Recommended options included.'
          : 'No smaller known option available right now.'
      });
    }

    const title = sanitizeFileBaseName(info.videoDetails?.title || info.videoDetails?.videoId || 'video');
    const videoId = info.videoDetails?.videoId || 'unknown';
    const ext = extensionFromFormat(format, type);
    const objectPath = `videos/${videoId}/${Date.now()}-${itag}.${ext}`;

    const upstream = await axios.get(format.url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 120000,
      headers: getBaseRequestOptions().headers
    });

    const uploadBuffer = Buffer.from(upstream.data);
    const contentType = format.mimeType ? String(format.mimeType).split(';')[0] : (type === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, uploadBuffer, {
        contentType,
        upsert: false,
        cacheControl: '3600'
      });

    if (uploadError) {
      return res.status(500).json({
        success: false,
        error: uploadError.message || 'Supabase upload failed'
      });
    }

    const { data: signedData, error: signedErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

    const publicUrl = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/${objectPath}`;
    res.json({
      success: true,
      app: 'ytdl-ph',
      provider: 'supabase',
      file: {
        path: objectPath,
        bucket,
        contentType,
        sizeBytes,
        sizeMB: bytesToMB(sizeBytes),
        originalTitle: info.videoDetails?.title || '',
        suggestedName: `${title}.${ext}`
      },
      urls: {
        signed: signedErr ? null : signedData?.signedUrl || null,
        public: publicUrl
      },
      note: 'Signed URL expires in 7 days. Public URL works only if bucket/object is publicly readable.'
    });
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'Failed to upload to Supabase';
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.get('/api/jrm/cloud-download', async (req, res) => {
  try {
    const rawUrl = req.query.url ? String(req.query.url) : '';
    const itag = Number(req.query.itag || 0);
    const type = String(req.query.type || '').toLowerCase();
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);

    if (!normalizedUrl || !itag || !['mp4', 'mp3'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid params',
        message: 'Use /api/jrm/cloud-download?url=YOUTUBE_LINK&itag=FORMAT_ITAG&type=mp4|mp3'
      });
    }

    const supabase = getSupabaseClient();
    const { bucket } = getSupabaseConfig();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Cloud service not configured'
      });
    }

    const { info } = await getInfoWithRetries(normalizedUrl);
    const format = (info.formats || []).find((f) => Number(f.itag) === itag && f.url);
    if (!format) {
      return res.status(404).json({
        success: false,
        error: 'Format not found',
        message: 'Refresh and pick another option.'
      });
    }

    const sizeBytes = await resolveFormatSizeBytes(format);
    if (!sizeBytes) {
      return res.status(400).json({
        success: false,
        error: 'Unknown file size',
        message: 'Cannot process this option now. Try lower resolution.'
      });
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      return res.status(400).json({
        success: false,
        error: 'File too large',
        message: `Choose lower resolution. Max is ${bytesToMBText(MAX_UPLOAD_BYTES)}.`,
        sizeMB: bytesToMB(sizeBytes),
        recommendedLowerOptions: buildSupabaseRecommendations(info, type, MAX_UPLOAD_BYTES)
      });
    }

    const title = sanitizeFileBaseName(info.videoDetails?.title || info.videoDetails?.videoId || 'video');
    const videoId = info.videoDetails?.videoId || 'unknown';
    const ext = extensionFromFormat(format, type);
    const objectPath = `videos/${videoId}/${Date.now()}-${itag}.${ext}`;

    const upstream = await axios.get(format.url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 120000,
      headers: getBaseRequestOptions().headers
    });

    const uploadBuffer = Buffer.from(upstream.data);
    const contentType = format.mimeType ? String(format.mimeType).split(';')[0] : (type === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, uploadBuffer, {
        contentType,
        upsert: false,
        cacheControl: '3600'
      });

    if (uploadError) {
      return res.status(500).json({
        success: false,
        error: uploadError.message || 'Cloud upload failed'
      });
    }

    const suggestedName = `${title}.${ext}`;
    const { data: signedData, error: signedErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectPath, 120, { download: suggestedName });

    if (signedErr || !signedData?.signedUrl) {
      return res.status(500).json({
        success: false,
        error: signedErr?.message || 'Failed to create download URL'
      });
    }

    // Auto-delete uploaded object after 1 minute.
    setTimeout(async () => {
      try {
        await supabase.storage.from(bucket).remove([objectPath]);
      } catch (_) {
        // ignore cleanup errors
      }
    }, 60 * 1000);

    res.setHeader('Cache-Control', 'no-store');
    // Auto-start browser download flow by redirecting to signed URL.
    return res.redirect(signedData.signedUrl);
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'Failed to process cloud download';
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

module.exports = app;
