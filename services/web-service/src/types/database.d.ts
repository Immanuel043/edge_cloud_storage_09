export interface User {
  id: string;
  email: string;
  username: string;
  user_type: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface FileRecord {
  id: string;
  user_id: string;
  name: string;
  size: number;
  mime_type: string;
  created_at: Date;
  updated_at: Date;
}

export interface ShareLink {
  id: string;
  file_id: string;
  token: string;
  expires_at?: Date;
  password?: string;
  max_downloads?: number;
  download_count: number;
  created_at: Date;
}
