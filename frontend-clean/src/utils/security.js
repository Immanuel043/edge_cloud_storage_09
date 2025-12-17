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

/**
 * Validates password strength and returns detailed feedback
 * @param {string} password - The password to validate
 * @returns {Object} { score: 0-4, strength: string, feedback: string[], isValid: boolean, requirements: Object }
 */
export const validatePasswordStrength = (password) => {
  const requirements = {
    minLength: password.length >= 8,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasNumber: /[0-9]/.test(password),
    hasSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password),
  };

  const feedback = [];
  if (!requirements.minLength) feedback.push('At least 8 characters');
  if (!requirements.hasUppercase) feedback.push('One uppercase letter');
  if (!requirements.hasLowercase) feedback.push('One lowercase letter');
  if (!requirements.hasNumber) feedback.push('One number');
  if (!requirements.hasSpecial) feedback.push('One special character (!@#$%^&*...)');

  // Calculate score (0-4)
  const metRequirements = Object.values(requirements).filter(Boolean).length;
  let score = 0;
  let strength = 'weak';

  if (metRequirements >= 5) {
    score = 4;
    strength = 'strong';
  } else if (metRequirements >= 4) {
    score = 3;
    strength = 'good';
  } else if (metRequirements >= 3) {
    score = 2;
    strength = 'fair';
  } else if (metRequirements >= 2) {
    score = 1;
    strength = 'weak';
  }

  // Bonus for longer passwords
  if (password.length >= 12 && score < 4) {
    score = Math.min(score + 1, 4);
    if (score >= 3) strength = 'good';
    if (score >= 4) strength = 'strong';
  }

  return {
    score,
    strength,
    feedback,
    isValid: metRequirements >= 4, // Require at least 4 of 5 requirements
    requirements,
  };
};