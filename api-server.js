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

function getVideoIdFromWatchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('v') || '';
  } catch (_) {
    return '';
  }
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
      bestMp4Bytes: 0,
      bestMp4MB: 0
    },
    mp4: [],
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
    warning: 'Limited data only. YouTube blocked direct stream extraction for this video on current server IP.',
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
      --accent: #22d3ee;
      --accent2: #38bdf8;
      --good: #22c55e;
      --bad: #ef4444;
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
      background: linear-gradient(180deg, #111827, #0b1220);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { color: var(--muted); margin-top: 0; }
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
    pre {
      margin: 14px 0 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #020617;
      color: #dbeafe;
      padding: 12px;
      max-height: 380px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
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
      <p>Test endpoint: <code>/api/jrm?url=YOUTUBE_LINK</code> or <code>/api/jrm?=YOUTUBE_LINK</code></p>
      <div class="row">
        <input id="yt" value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
        <button id="run">Test API</button>
      </div>
      <div class="meta">
        <div class="chip"><b>Status</b><span id="status">Ready</span></div>
        <div class="chip"><b>Service</b><span>Render-ready Node API</span></div>
        <div class="chip"><b>Made By</b><span>JhamesMartin</span></div>
      </div>
      <pre id="out">{ "info": "Submit a YouTube link to test JSON output." }</pre>
    </div>
  </div>
<script>
  const runBtn = document.getElementById('run');
  const input = document.getElementById('yt');
  const out = document.getElementById('out');
  const statusEl = document.getElementById('status');
  runBtn.addEventListener('click', async () => {
    const link = input.value.trim();
    if (!link) return;
    statusEl.textContent = 'Loading...';
    statusEl.className = '';
    out.textContent = 'Loading...';
    try {
      const res = await fetch('/api/jrm?url=' + encodeURIComponent(link));
      const data = await res.json();
      statusEl.textContent = res.ok ? 'Success' : 'Error';
      statusEl.className = res.ok ? 'ok' : 'err';
      out.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      statusEl.textContent = 'Network error';
      statusEl.className = 'err';
      out.textContent = JSON.stringify({ success: false, error: err.message }, null, 2);
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

    const info = await ytdl.getInfo(normalizedUrl);
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
          sizeBytes,
          sizeMB: bytesToMB(sizeBytes),
          fps: f.fps || null,
          hasAudio: !!f.hasAudio,
          hasVideo: !!f.hasVideo,
          url: f.url
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const bestMp4 = mp4Formats[0] || null;

    res.json({
      success: true,
      endpoint: '/api/jrm',
      queryExample: '/api/jrm?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      sourceUrl: url,
      normalizedUrl,
      thumbnail: bestThumbnail,
      size: {
        totalFormats: (info.formats || []).length,
        mp4Formats: mp4Formats.length,
        bestMp4Bytes: bestMp4 ? bestMp4.sizeBytes : 0,
        bestMp4MB: bestMp4 ? bestMp4.sizeMB : 0
      },
      mp4: mp4Formats,
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
    const isExtractionBlocked = /not a bot|playable formats|status code:\s*410/i.test(message);
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

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

module.exports = app;
