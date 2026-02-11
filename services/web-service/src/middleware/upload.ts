import multer from 'multer';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 70 * 1024 * 1024, // 70MB per chunk (total file up to 20GB via chunked upload)
    files: 1
  }
});
