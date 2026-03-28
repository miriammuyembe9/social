// ═══════════════ CLOUDINARY INTEGRATION ═══════════════
// All media (images, videos, audio) goes through Cloudinary.
// Supabase stores only the Cloudinary public_id (not the full URL).
// This module owns the full URL → public_id → optimized URL lifecycle.
//
// ENV vars required in .env:
//   CLOUDINARY_CLOUD_NAME=your_cloud_name
//   CLOUDINARY_API_KEY=your_api_key
//   CLOUDINARY_API_SECRET=your_api_secret

const cloudinary = require('cloudinary').v2;
const fs         = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,   // always HTTPS
});

// ── Folder mapping ────────────────────────────────────────────────────────────
// Keeps Cloudinary organised and enables folder-level transforms
const FOLDERS = {
  avatar:        'vibe/avatars',
  cover:         'vibe/covers',
  post_image:    'vibe/posts/images',
  post_video:    'vibe/posts/videos',
  story_image:   'vibe/stories/images',
  story_video:   'vibe/stories/videos',
  video:         'vibe/videos',         // dedicated videos page
  message_image: 'vibe/messages/images',
  voice:         'vibe/voice',
  audio_temp:    'vibe/audio_temp',
};

// ── Upload transforms applied AT UPLOAD TIME ──────────────────────────────────
// These are baked into the stored asset — Cloudinary processes once, serves forever.
const UPLOAD_TRANSFORMS = {
  // Avatars: square crop, WebP, 400px max, quality auto
  avatar: [
    { width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto:good', fetch_format: 'auto' }
  ],
  // Cover photos: 1200×400 letterbox, WebP
  cover: [
    { width: 1200, height: 400, crop: 'fill', gravity: 'auto', quality: 'auto:good', fetch_format: 'auto' }
  ],
  // Post images: max 1080px wide, auto quality, WebP
  post_image: [
    { width: 1080, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }
  ],
  // Post videos: transcode to h264/720p, auto quality
  post_video: [
    { width: 720, crop: 'limit', quality: 'auto:good', video_codec: 'h264' }
  ],
  // Story images: 1080×1920 portrait fill
  story_image: [
    { width: 1080, height: 1920, crop: 'fill', gravity: 'auto', quality: 'auto:good', fetch_format: 'auto' }
  ],
  // Story videos: vertical 720p h264
  story_video: [
    { width: 720, height: 1280, crop: 'fill', quality: 'auto:good', video_codec: 'h264' }
  ],
  // Dedicated videos page: up to 1080p h264
  video: [
    { width: 1080, crop: 'limit', quality: 'auto:good', video_codec: 'h264' }
  ],
  // Message images: 800px max
  message_image: [
    { width: 800, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }
  ],
  // Voice/audio: no transform (passthrough)
  voice: [],
};

// ── Upload a local file to Cloudinary ────────────────────────────────────────
// type: one of the keys in FOLDERS
// Returns { public_id, secure_url, resource_type, duration? }
const uploadFile = async (localPath, type, options = {}) => {
  const folder    = FOLDERS[type] || 'vibe/misc';
  const transform = UPLOAD_TRANSFORMS[type] || [];
  const isVideo   = type.includes('video') || type === 'voice';
  const isAudio   = type === 'voice';

  const uploadOpts = {
    folder,
    resource_type:    isAudio ? 'video' : (isVideo ? 'video' : 'image'),
    use_filename:     false,
    unique_filename:  true,
    overwrite:        false,
    // Eager transforms: Cloudinary processes these immediately on upload
    // so the first user request is already served from CDN cache
    eager: transform.length ? transform : undefined,
    eager_async: false,  // process synchronously so we get dimensions back
    // CDN cache: 1 year for immutable media
    invalidate: false,
    ...options,
  };

  const result = await cloudinary.uploader.upload(localPath, uploadOpts);

  // Clean up local temp file immediately after successful upload
  try { fs.unlinkSync(localPath); } catch (_) {}

  return {
    public_id:     result.public_id,
    secure_url:    result.secure_url,
    resource_type: result.resource_type,
    width:         result.width,
    height:        result.height,
    duration:      result.duration || null,
    format:        result.format,
    bytes:         result.bytes,
  };
};

// ── Delete a Cloudinary asset ─────────────────────────────────────────────────
const deleteFile = async (publicId, resourceType = 'image') => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (e) {
    console.warn('[Cloudinary] delete failed for', publicId, e.message);
  }
};

// ── Build an optimized delivery URL from a public_id ─────────────────────────
// This is what you store in the DB — reconstruct URL on demand with transforms.
// For images: auto format (WebP/AVIF), auto quality, responsive width.
// For videos: auto format, auto quality, streaming-friendly.
const buildUrl = (publicId, resourceType = 'image', opts = {}) => {
  if (!publicId) return '';
  // If already a full URL (legacy /uploads/ path), return as-is
  if (publicId.startsWith('http')) return publicId;

  const transforms = [];

  if (resourceType === 'image') {
    transforms.push({
      fetch_format: 'auto',
      quality: 'auto:good',
      ...(opts.width  ? { width: opts.width,  crop: 'limit' } : {}),
      ...(opts.height ? { height: opts.height, crop: opts.crop || 'fill' } : {}),
    });
    // DPR: serve 2x on retina without doubling bytes
    transforms.push({ dpr: 'auto' });
  } else if (resourceType === 'video') {
    transforms.push({
      quality: 'auto:good',
      fetch_format: 'auto',
      ...(opts.width ? { width: opts.width, crop: 'limit' } : {}),
    });
  }

  return cloudinary.url(publicId, {
    resource_type: resourceType,
    secure: true,
    transformation: transforms,
    ...opts.extra,
  });
};

// ── Thumbnail for videos ──────────────────────────────────────────────────────
// Extracts a frame at 1s, converts to WebP, 400px wide
const buildVideoThumb = (publicId) => {
  if (!publicId) return '';
  if (publicId.startsWith('http')) return publicId;
  return cloudinary.url(publicId, {
    resource_type: 'video',
    secure: true,
    transformation: [
      { start_offset: '1', fetch_format: 'webp', quality: 'auto:good', width: 400, crop: 'limit' }
    ],
  });
};

// ── Enrich a post/video/story row with full Cloudinary URLs ──────────────────
// Handles both new (public_id) and legacy (/uploads/...) values transparently
const enrichMediaUrl = (row) => {
  if (!row) return row;
  const r = { ...row };

  if (r.media_url)      r.media_url      = buildUrl(r.media_url,      r.media_resource_type || 'image');
  if (r.video_url)      r.video_url      = buildUrl(r.video_url,      'video');
  if (r.thumbnail_url)  r.thumbnail_url  = buildUrl(r.thumbnail_url,  'image');
  if (r.avatar_url)     r.avatar_url     = buildUrl(r.avatar_url,     'image', { width: 200 });
  if (r.cover_url)      r.cover_url      = buildUrl(r.cover_url,      'image', { width: 1200 });

  // Multi-image posts: media_urls array
  if (r.media_urls && Array.isArray(r.media_urls)) {
    r.media_urls = r.media_urls.map(u => buildUrl(u, 'image'));
  }
  // JSON-encoded array in media_url
  if (r.media_url && r.media_url.startsWith('[')) {
    try {
      const arr = JSON.parse(r.media_url);
      r.media_urls = arr.map(u => buildUrl(u, 'image'));
      r.media_url  = r.media_urls[0] || '';
    } catch (_) {}
  }

  return r;
};

const enrichUser = (user) => {
  if (!user) return user;
  return {
    ...user,
    avatar_url: user.avatar_url ? buildUrl(user.avatar_url, 'image', { width: 200 }) : null,
    cover_url:  user.cover_url  ? buildUrl(user.cover_url,  'image', { width: 1200 }) : null,
  };
};

module.exports = {
  cloudinary,
  uploadFile,
  deleteFile,
  buildUrl,
  buildVideoThumb,
  enrichMediaUrl,
  enrichUser,
  FOLDERS,
};

// ── Upload from memory buffer (multer memoryStorage) ─────────────────────────
// Used by controllers when multer is configured with memoryStorage.
const uploadBuffer = (buffer, mimetype, type, options = {}) => new Promise((resolve, reject) => {
  const folder    = FOLDERS[type] || 'vibe/misc';
  const transform = UPLOAD_TRANSFORMS[type] || [];
  const isVideo   = mimetype.startsWith('video/');
  const isAudio   = mimetype.startsWith('audio/');
  const resourceType = isAudio ? 'video' : (isVideo ? 'video' : 'image');

  const uploadOpts = {
    folder,
    resource_type:    resourceType,
    use_filename:     false,
    unique_filename:  true,
    overwrite:        false,
    eager:            transform.length ? transform : undefined,
    eager_async:      false,
    invalidate:       false,
    ...options,
  };

  const stream = cloudinary.uploader.upload_stream(uploadOpts, (error, result) => {
    if (error) return reject(new Error('Cloudinary upload failed: ' + error.message));
    resolve({
      public_id:     result.public_id,
      secure_url:    result.secure_url,
      resource_type: result.resource_type,
      width:         result.width,
      height:        result.height,
      duration:      result.duration || null,
      format:        result.format,
      bytes:         result.bytes,
    });
  });

  stream.end(buffer);
});

module.exports.uploadBuffer = uploadBuffer;