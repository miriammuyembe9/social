// ═══════════════ UPLOAD MIDDLEWARE ═══════════════
// Uses multer memoryStorage — files never touch disk.
// Controllers call uploadFile() from cloudinary.js to push buffer to Cloudinary.
const multer = require('multer');

const ALLOWED_MIME = [
  'image/jpeg','image/png','image/gif','image/webp',
  'video/mp4','video/webm','video/quicktime',
  'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Unsupported file type: ' + file.mimetype), false);
};

// Memory storage — no disk write, buffer goes straight to Cloudinary
module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 200 * 1024 * 1024 },
});