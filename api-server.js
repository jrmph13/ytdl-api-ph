const express = require('express');
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

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

  const variants = [
    { name: 'ANDROID', options: { playerClients: ['ANDROID'] } },
    { name: 'IOS', options: { playerClients: ['IOS'] } },
    { name: 'TV', options: { playerClients: ['TV'] } },
    { name: 'WEB', options: { playerClients: ['WEB'] } },
    { name: 'ANDROID+WEB', options: { playerClients: ['ANDROID', 'WEB'] } }
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      const info = await ytdl.getInfo(normalizedUrl, {
        ...variant.options,
        requestOptions: getBaseRequestOptions(),
        ...(agent ? { agent } : {})
      });
      return { info, strategy: variant.name };
    } catch (err) {
      lastError = err;
      attempts.push({
        strategy: variant.name,
        error: err && err.message ? String(err.message) : 'Unknown error'
      });
    }
  }

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
    warning: 'Limited data only. YouTube blocked direct stream extraction for this video on current server IP. Add YT_COOKIE env var in Render to improve success rate.',
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
  <title>JRM YTDL API</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #111827;
      --line: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #06b6d4;
      --accent2: #0ea5e9;
      --good: #22c55e;
      --bad: #ef4444;
      --gold: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top right, #1e293b, var(--bg) 55%);
      min-height: 100vh;
      padding: 24px;
    }
    .wrap { max-width: 920px; margin: 0 auto; }
    .card {
      background: linear-gradient(180deg, #111827 0%, #0b1220 100%);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 8px; font-size: 30px; }
    p { color: var(--muted); margin-top: 0; }
    .hero-note {
      border: 1px dashed #1e3a8a;
      border-radius: 10px;
      padding: 10px;
      margin: 10px 0 16px;
      color: #bfdbfe;
      background: rgba(30, 58, 138, .15);
      font-size: 13px;
    }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    input {
      flex: 1;
      min-width: 280px;
      border: 1px solid var(--line);
      background: #0b1220;
      color: var(--text);
      border-radius: 10px;
      padding: 12px;
      font-size: 14px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 12px 16px;
      font-weight: 600;
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: #03121a;
    }
    .meta { margin: 14px 0; display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 10px; }
    .chip { border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: #0b1220; }
    .chip b { display: block; font-size: 13px; color: var(--muted); margin-bottom: 3px; }
    .preview {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b1220;
      padding: 12px;
      display: grid;
      grid-template-columns: 260px 1fr;
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
    .dl-head { margin: 16px 0 8px; font-weight: 700; }
    .dl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
    .dl-btn b { display: block; color: #7dd3fc; margin-bottom: 3px; }
    .small { color: var(--muted); font-size: 12px; }
    .hidden { display: none; }
    .warn {
      margin-top: 10px;
      color: #fcd34d;
      font-size: 12px;
      border: 1px solid rgba(245, 158, 11, .35);
      background: rgba(245, 158, 11, .12);
      border-radius: 8px;
      padding: 8px;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      border: 1px solid #1f2937;
      background: #0a1428;
      color: #93c5fd;
      font-size: 12px;
      margin-right: 6px;
    }
    @media (max-width: 760px) {
      .preview { grid-template-columns: 1fr; }
    }
    .ok { color: var(--good); }
    .err { color: var(--bad); }
    code { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>JRM YTDL API</h1>
      <p>Paste YouTube URL, then get fresh download buttons.</p>
      <div class="hero-note">
        Download buttons now use backend endpoint <code>/api/jrm/download</code> so each click generates a fresh stream link.
      </div>
      <div class="row">
        <input id="yt" value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
        <button id="run">Test API</button>
      </div>
      <div class="meta">
        <div class="chip"><b>Status</b><span id="status">Ready</span></div>
        <div class="chip"><b>Service</b><span>Render-ready Node API</span></div>
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
          <div class="dl-head">Download Links</div>
          <div id="downloads" class="dl-grid"></div>
          <div id="warn" class="warn hidden"></div>
        </div>
      </div>
    </div>
  </div>
<script>
  const runBtn = document.getElementById('run');
  const input = document.getElementById('yt');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  const thumbEl = document.getElementById('thumb');
  const titleEl = document.getElementById('title');
  const descEl = document.getElementById('desc');
  const videoIdEl = document.getElementById('videoId');
  const durationEl = document.getElementById('duration');
  const viewsEl = document.getElementById('views');
  const channelEl = document.getElementById('channel');
  const downloadsEl = document.getElementById('downloads');
  const warnEl = document.getElementById('warn');
  const badgeExtractor = document.getElementById('badgeExtractor');
  const badgeMode = document.getElementById('badgeMode');

  function fmtViews(n) {
    const num = Number(n || 0);
    if (!num) return '0';
    return num.toLocaleString();
  }

  function renderDownloads(downloads, data) {
    downloadsEl.innerHTML = '';
    if (!downloads || !downloads.length) {
      const warn = data && data.warning ? data.warning : 'No direct download links available for this video right now.';
      downloadsEl.innerHTML = '<div class="small">' + warn + '</div>';
      return;
    }
    downloads.slice(0, 20).forEach((item) => {
      const a = document.createElement('a');
      a.className = 'dl-btn';
      a.href = item.downloadApi || item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const res = item.resolution || '-';
      const size = item.sizeMB ? item.sizeMB + ' MB' : '-';
      a.innerHTML = '<b>' + item.type.toUpperCase() + ' ' + (item.quality || '') + '</b>' +
        '<div class="small">Resolution: ' + res + '</div>' +
        '<div class="small">Size: ' + size + '</div>' +
        '<div class="small">Open download link</div>';
      downloadsEl.appendChild(a);
    });
  }

  runBtn.addEventListener('click', async () => {
    const link = input.value.trim();
    if (!link) return;
    statusEl.textContent = 'Loading...';
    statusEl.className = '';
    resultEl.classList.add('hidden');
    try {
      const res = await fetch('/api/jrm?url=' + encodeURIComponent(link));
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
      renderDownloads(data.downloads || [], data);
      if (data.warning) {
        warnEl.textContent = data.warning;
        warnEl.classList.remove('hidden');
      }
      resultEl.classList.remove('hidden');
    } catch (err) {
      statusEl.textContent = 'Network error';
      statusEl.className = 'err';
    }
  });
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'ytdl-api',
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
      .filter((f) => (f.mimeType || '').includes('video/mp4') && f.url)
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
          url: f.url,
          downloadApi: toDownloadApi(normalizedUrl, f.itag, 'mp4')
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
          url: f.url,
          downloadApi: toDownloadApi(normalizedUrl, f.itag, 'mp3')
        };
      })
      .sort((a, b) => b.audioBitrate - a.audioBitrate || b.sizeBytes - a.sizeBytes);

    const bestMp4 = mp4Formats[0] || null;
    const downloads = [...mp4Formats, ...mp3Formats];

    res.json({
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
        bestMp4Bytes: bestMp4 ? bestMp4.sizeBytes : 0,
        bestMp4MB: bestMp4 ? bestMp4.sizeMB : 0
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

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

module.exports = app;
