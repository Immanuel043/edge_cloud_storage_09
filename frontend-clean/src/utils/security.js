const ALLOWED_FILE_EXTENSIONS = [
  // Documents
  '.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt',
  // Spreadsheets
  '.xls', '.xlsx', '.csv', '.ods',
  // Presentations
  '.ppt', '.pptx', '.odp',
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico',
  // Videos
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
  // Audio
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma',
  // Archives
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  // Code
  '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.json', '.xml', '.py', '.java', '.cpp', '.c', '.go', '.rs'
];

const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20GB

export const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  
  // Remove HTML tags and scripts
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[<>"']/g, '')
    .trim();
};

export const validateFileType = (file) => {
  const fileName = file.name.toLowerCase();
  const extension = '.' + fileName.split('.').pop();
  return ALLOWED_FILE_EXTENSIONS.includes(extension);
};

export const validateFileSize = (file) => {
  return file.size <= MAX_FILE_SIZE;
};

export const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

export const validatePassword = (password) => {
  return password.length >= 8;
};