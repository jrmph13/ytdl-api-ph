const express = require('express');
const ytdl = require('./lib');
const rateLimit = require('express-rate-limit');
const app = express();
const port = process.env.PORT || 3000;

// Rate limiting for anti-scrape protection
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
    message: 'Rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'YouTube Video API',
    version: '1.0.0',
    rateLimit: '100 requests per 15 minutes'
  });
});

/**
 * API endpoint to get YouTube video information
 * Usage: /api/jrm?url=youtube-link-url
 * 
 * @param {string} url - YouTube video URL
 * @returns {object} Video information including thumbnail, size, formats, and details
 */
app.get('/api/jrm', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'YouTube URL is required',
        message: 'Please provide a YouTube URL parameter (e.g., ?url=https://youtube.com/watch?v=VIDEO_ID)'
      });
    }

    // Validate YouTube URL
    const isValidUrl = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|.+?[?&]v=)|youtu\.be\/)[^\s&?#]+/i;
    if (!isValidUrl.test(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL',
        message: 'The provided URL is not a valid YouTube video URL'
      });
    }

    console.log(`[${new Date().toISOString()}] Processing YouTube URL: ${url}`);
    
    // Get video information using ytdl-core
    const info = await ytdl.getInfo(url);
    
    // Extract and format video information
    const videoDetails = info.videoDetails;
    const playerResponse = info.player_response;
    
    // Get MP4 formats
    const mp4Formats = info.formats.filter(format => 
      format.mimeType && format.mimeType.includes('video/mp4')
    ).map(format => ({
      quality: format.qualityLabel || 'unknown',
      size: format.contentLength || 0,
      url: format.url,
      mimeType: format.mimeType,
      itag: format.itag,
      qualityLabel: format.qualityLabel,
      averageBitrate: format.averageBitrate
    }));
    
    // Sort MP4 formats by quality (highest first)
    mp4Formats.sort((a, b) => {
      const qualityOrder = { '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1, '480p': 0 };
      return (qualityOrder[b.quality] || 0) - (qualityOrder[a.quality] || 0);
    });
    
    // Build comprehensive response
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      
      // Basic video information
      videoId: videoDetails.videoId,
      title: videoDetails.title,
      description: videoDetails.description,
      
      // Thumbnail information
      thumbnail: {
        default: videoDetails.thumbnails[0]?.url || '',
        medium: videoDetails.thumbnails[1]?.url || '',
        high: videoDetails.thumbnails[2]?.url || '',
        standard: videoDetails.thumbnails[3]?.url || '',
        maxres: videoDetails.thumbnails[4]?.url || '',
        width: videoDetails.thumbnails[0]?.width || 0,
        height: videoDetails.thumbnails[0]?.height || 0
      },
      
      // Size information
      size: {
        available: true,
        formatsCount: info.formats.length,
        estimatedSize: mp4Formats.length > 0 ? mp4Formats[0].size : 0
      },
      
      // MP4 format information
      mp4: {
        available: mp4Formats.length > 0,
        formats: mp4Formats,
        bestQuality: mp4Formats.length > 0 ? mp4Formats[0] : null,
        has4K: mp4Formats.some(f => f.quality === '2160p'),
        has1080p: mp4Formats.some(f => f.quality === '1080p')
      },
      
      // Made by Jhames Martin information
      madebyJhamesMartin: {
        name: 'Jhames Martin',
        api: 'ytdl-core',
        version: ytdl.version,
        timestamp: new Date().toISOString(),
        developer: 'Jhames Martin',
        repository: 'https://github.com/fent/node-ytdl-core'
      },
      
      // Detailed video information
      details: {
        duration: videoDetails.lengthSeconds,
        durationFormatted: formatDuration(videoDetails.lengthSeconds),
        viewCount: videoDetails.viewCount,
        likeCount: videoDetails.likeCount,
        dislikeCount: videoDetails.dislikeCount,
        commentCount: videoDetails.commentCount,
        uploadDate: videoDetails.uploadDate,
        uploadDateISO: new Date(videoDetails.uploadDate).toISOString(),
        category: videoDetails.category,
        categoryId: videoDetails.categoryId,
        tags: videoDetails.tags || [],
        channelTitle: videoDetails.channelTitle,
        channelId: videoDetails.channelId,
        channelUrl: `https://www.youtube.com/channel/${videoDetails.channelId}`,
        isLive: videoDetails.isLiveContent,
        isUpcoming: videoDetails.isUpcoming,
        definition: videoDetails.definition,
        projectType: videoDetails.projectType,
        videoType: videoDetails.videoType,
        defaultLanguage: videoDetails.defaultLanguage,
        captionAvailable: videoDetails.captionAvailable
      },
      
      // Player and streaming information
      metadata: {
        playerResponse: playerResponse,
        playerVersion: playerResponse?.playerConfig?.playerVersion || 'unknown',
        formatsCount: info.formats.length,
        adaptiveFormatsCount: info.adaptiveFormats?.length || 0,
        hasDASH: !!playerResponse?.streamingData?.dashManifestUrl,
        hasHLS: !!playerResponse?.streamingData?.hlsManifestUrl,
        dashManifestUrl: playerResponse?.streamingData?.dashManifestUrl || null,
        hlsManifestUrl: playerResponse?.streamingData?.hlsManifestUrl || null,
        streamingData: playerResponse?.streamingData || null,
        isAvailable: info.formats.length > 0,
        isPlayable: info.playable || false
      },
      
      // Additional metadata for advanced usage
      advanced: {
        videoAge: calculateVideoAge(videoDetails.uploadDate),
        engagementRate: calculateEngagementRate(videoDetails),
        categoryName: getCategoryName(videoDetails.categoryId)
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing video:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve video information',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Format duration in seconds to HH:MM:SS format
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Calculate video age in days
 */
function calculateVideoAge(uploadDate) {
  if (!uploadDate) return null;
  const upload = new Date(uploadDate);
  const now = new Date();
  const diffTime = Math.abs(now - upload);
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Calculate engagement rate (likes + comments / views)
 */
function calculateEngagementRate(videoDetails) {
  if (!videoDetails.viewCount || videoDetails.viewCount === 0) return 0;
  const engagement = (videoDetails.likeCount + videoDetails.commentCount) / videoDetails.viewCount;
  return Math.round(engagement * 10000) / 100; // Return as percentage with 2 decimal places
}

/**
 * Get category name from category ID
 */
function getCategoryName(categoryId) {
  const categories = {
    '1': 'Film & Animation',
    '2': 'Autos & Vehicles',
    '3': 'Music',
    '4': 'Pets & Animals',
    '5': 'Sports',
    '6': 'Short Movies',
    '7': 'Gaming',
    '8': 'Videoblogging',
    '9': 'People & Blogs',
    '10': 'Comedy',
    '11': 'Entertainment',
    '12': 'News & Politics',
    '13': 'Howto & Style',
    '14': 'Education',
    '15': 'Science & Technology',
    '16': 'Nonprofits & Activism',
    '17': 'Events',
    '18': 'Gaming',
    '19': 'Videoblogging',
    '20': 'People & Blogs',
    '22': 'Comedy',
    '23': 'Entertainment',
    '24': 'News & Politics',
    '25': 'Howto & Style',
    '26': 'Education',
    '27': 'Science & Technology',
    '28': 'Nonprofits & Activism',
    '29': 'Events',
    '30': 'Gaming'
  };
  return categories[categoryId] || 'Unknown';
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: 'Something went wrong while processing your request'
  });
});

// Start server
app.listen(port, () => {
  console.log(`\n========================================`);
  console.log(`YouTube Video API Server`);
  console.log(`========================================`);
  console.log(`Server running on port: ${port}`);
  console.log(`API endpoint: GET /api/jrm?url=<youtube-url>`);
  console.log(`Health check: GET /health`);
  console.log(`Rate limit: 100 requests per 15 minutes`);
  console.log(`========================================\n`);
});

module.exports = app;