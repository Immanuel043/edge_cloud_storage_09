/**
 * Summary Service — Document summarization API calls
 */
import { API_URL } from '../config/constants';

export interface FileSummary {
  file_id: string;
  summary: string;
  word_count: number;
  model_used: string;
  created_at: string;
}

/**
 * Get cached summary for a file
 */
export async function getFileSummary(fileId: string): Promise<FileSummary> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/summary`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch summary: ${res.status}`);
  return res.json();
}

/**
 * Generate a new summary (synchronous). 409 = ineligible file.
 */
export async function generateFileSummary(fileId: string): Promise<FileSummary> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/summary/generate`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.status === 409) {
    const data = await res.json();
    throw new Error(`INELIGIBLE: ${data.detail}`);
  }
  if (!res.ok) throw new Error(`Failed to generate summary: ${res.status}`);
  return res.json();
}

/**
 * Delete cached summary and regenerate
 */
export async function regenerateFileSummary(fileId: string): Promise<FileSummary> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/summary/regenerate`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.status === 409) {
    const data = await res.json();
    throw new Error(`INELIGIBLE: ${data.detail}`);
  }
  if (!res.ok) throw new Error(`Failed to regenerate summary: ${res.status}`);
  return res.json();
}
