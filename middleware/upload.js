const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'images';
    if (file.mimetype.startsWith('video/'))      folder = 'videos';
    else if (file.mimetype.startsWith('audio/')) folder = 'voice-comments';
    // Avatar and cover fields go to avatars/
    if (file.fieldname === 'avatar')             folder = 'avatars';
    // Background music for video editor — store in temp folder
    if (file.fieldname === 'audio')              folder = 'audio-temp';

    const uploadPath = path.join(__dirname, '../uploads', folder);
    ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg','image/png','image/gif','image/webp',
    'video/mp4','video/webm','video/quicktime',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg'
  ];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Unsupported file type: ' + file.mimetype), false);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024 }
});