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
      <p class="sub">API: <code>/api/jrm?url=...</code></p>
    </div>
    <div class="card">
      <div class="hero">
        <h2>YouTube Downloader, Pinoy style.</h2>
        <p>Paste any YouTube URL. Click search. Pick MP4 or MP3 quality and download.</p>
      </div>
      <div class="search">
        <input id="yt" value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
        <button id="run">Search</button>
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
          <div class="dual">
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
          <div class="footer-note">Buttons call <code>/api/jrm/download</code> and generate fresh link per click.</div>
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
  const downloadsMp4El = document.getElementById('downloadsMp4');
  const downloadsMp3El = document.getElementById('downloadsMp3');
  const warnEl = document.getElementById('warn');
  const badgeExtractor = document.getElementById('badgeExtractor');
  const badgeMode = document.getElementById('badgeMode');

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
    list.slice(0, 12).forEach((item) => {
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
      renderDownloads(data);
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
