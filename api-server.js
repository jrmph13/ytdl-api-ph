const express = require('express');
const ytdl = require('./lib');
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

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'ytdl-api',
    status: 'running',
    madebyJhamesMartin: 'JhamesMartin',
    endpoint: '/api/jrm?url=YOUTUBE_LINK',
    altEndpoint: '/api/jrm?=YOUTUBE_LINK'
  });
});

app.get('/api/jrm', async (req, res) => {
  try {
    const url = getYoutubeUrlFromRequest(req);

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing YouTube URL',
        message: 'Use /api/jrm?url=YOUTUBE_LINK or /api/jrm?=YOUTUBE_LINK'
      });
    }

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL'
      });
    }

    const info = await ytdl.getInfo(url);
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

module.exports = app;
