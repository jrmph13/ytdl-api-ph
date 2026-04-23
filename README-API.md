# YouTube Video API (Render Ready)

## Overview
This API provides a simple endpoint to retrieve YouTube video information including thumbnail, MP4 sizes, and video details.

## API Endpoint

### Get Video Information
```
GET /api/jrm?url=<youtube-url>
GET /api/jrm?=<youtube-url>
```

**Example:**
```
GET /api/jrm?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

## Response Structure

The API returns a JSON response with the following structure:

```json
{
  "success": true,
  "videoId": "string",
  "title": "string",
  "description": "string",
  "thumbnail": {
    "default": "url",
    "medium": "url",
    "high": "url",
    "standard": "url",
    "maxres": "url"
  },
  "size": {
    "available": true
  },
  "mp4": {
    "available": true,
    "formats": [
      {
        "quality": "string",
        "size": number,
        "url": "string",
        "mimeType": "string",
        "itag": number
      }
    ]
  },
  "madebyJhamesMartin": {
    "name": "Jhames Martin",
    "api": "ytdl-core",
    "version": "string",
    "timestamp": "ISO8601"
  },
  "details": {
    "duration": number,
    "viewCount": number,
    "likeCount": number,
    "commentCount": number,
    "uploadDate": "string",
    "category": "string",
    "tags": ["string"],
    "channelTitle": "string",
    "channelId": "string",
    "isLive": boolean,
    "definition": "string",
    "projectType": "string"
  },
  "metadata": {
    "playerResponse": "object",
    "formatsCount": number,
    "hasDASH": boolean,
    "hasHLS": boolean,
    "isAvailable": boolean
  }
}
```

## Features

1. **Render-ready**: Uses `process.env.PORT` for free web service hosting
2. **Comprehensive Video Info**: Full video metadata including thumbnail, sizes, and formats
3. **MP4 Format Support**: Detailed MP4 format information with quality and size
4. **Made By Information**: Includes `madebyJhamesMartin`
5. **Detailed Video Details**: Complete video metadata including core properties

## Installation

```bash
npm install
```

## Usage

### Start the API Server
```bash
npm start
```

### Example Request
```bash
curl "http://localhost:3000/api/jrm?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

### Example Response
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "title": "Sample Video",
  "description": "Video description...",
  "thumbnail": {
    "default": "https://...",
    "medium": "https://...",
    "high": "https://...",
    "standard": "https://...",
    "maxres": "https://..."
  },
  "size": {
    "available": true
  },
  "mp4": {
    "available": true,
    "formats": [
      {
        "quality": "1080p",
        "size": 12345678,
        "url": "https://...",
        "mimeType": "video/mp4",
        "itag": 22
      }
    ]
  },
  "madebyJhamesMartin": {
    "name": "Jhames Martin",
    "api": "ytdl-core",
    "version": "1.0.0",
    "timestamp": "2026-04-23T01:07:52.374Z"
  },
  "details": {
    "duration": 180,
    "viewCount": 1000000,
    "likeCount": 50000,
    "commentCount": 2000,
    "uploadDate": "2023-01-01",
    "category": "Music",
    "tags": ["music", "sample"],
    "channelTitle": "Sample Channel",
    "channelId": "UC123456789",
    "isLive": false,
    "definition": "hd",
    "projectType": "original"
  },
  "metadata": {
    "formatsCount": 10,
    "hasDASH": true,
    "hasHLS": true,
    "isAvailable": true
  }
}
```

## Anti-Scrape Features

1. **Request Validation**: Validates YouTube URLs before processing
2. **Simple JSON Output**: Clean fields for frontend/backend usage
3. **Render Compatible**: Works with free Render web services

## Error Handling

The API provides detailed error responses:

```json
{
  "success": false,
  "error": "error message",
  "message": "Human readable description"
}
```

## Available Endpoints

- `GET /api/jrm?url=<youtube-url>` - Get video information
- `GET /health` - Health check endpoint

## Configuration

You can configure the API by setting environment variables:

- `PORT` - Server port (default: 3000)
- `YT_CACHE_TTL` - Cache time-to-live in seconds
- `YT_MAX_RETRIES` - Maximum retry attempts

## License

MIT
