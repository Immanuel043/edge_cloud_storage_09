/**
 * Name Suggestion Service — Smart file naming API calls
 */
import { API_URL } from '../config/constants';

export interface NameSuggestion {
  file_id: string;
  suggested_name: string;
  reason: string;
  source: string;
  created_at: string;
}

export interface AnalysisStatus {
  status: 'completed' | 'skipped' | 'unknown';
  has_suggestion?: boolean;
}

export interface PendingSuggestionsResponse {
  suggestions: Record<string, { suggested_name: string; reason: string }>;
}

export async function getAnalysisStatus(fileId: string): Promise<AnalysisStatus> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/analysis-status`, {
    credentials: 'include',
  });
  if (!res.ok) return { status: 'unknown' };
  return res.json();
}

export async function getNameSuggestion(fileId: string): Promise<NameSuggestion> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/name-suggestion`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`No suggestion: ${res.status}`);
  return res.json();
}

export async function acceptNameSuggestion(fileId: string): Promise<{ success: boolean; new_name: string }> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/name-suggestion/accept`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Accept failed: ${res.status}`);
  return res.json();
}

export async function dismissNameSuggestion(fileId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/v1/files/${fileId}/name-suggestion/dismiss`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Dismiss failed: ${res.status}`);
  return res.json();
}

export async function getPendingSuggestions(fileIds: string[]): Promise<PendingSuggestionsResponse> {
  if (fileIds.length === 0) return { suggestions: {} };
  const params = new URLSearchParams({ file_ids: fileIds.join(',') });
  const res = await fetch(`${API_URL}/api/v1/files/pending-suggestions/batch?${params}`, {
    credentials: 'include',
  });
  if (!res.ok) return { suggestions: {} };
  return res.json();
}
