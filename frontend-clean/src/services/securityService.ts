/**
 * Security Service — Security alerts API calls
 */
import { API_URL } from '../config/constants';

export interface SecurityAlert {
  id: string;
  alert_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  title: string;
  description: string;
  risk_score: number;
  evidence: Record<string, unknown>;
  trigger_pattern: string;
  first_seen: string | null;
  last_seen: string | null;
  detected_at: string | null;
  resolved_at: string | null;
}

export interface AlertsSummary {
  total: number;
  by_severity: Record<string, number>;
}

export async function getAlerts(params?: {
  status?: string;
  severity?: string;
  limit?: number;
}): Promise<{ count: number; alerts: SecurityAlert[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.severity) qs.set('severity', params.severity);
  if (params?.limit) qs.set('limit', params.limit.toString());

  const res = await fetch(`${API_URL}/api/v1/audit/security/alerts?${qs}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch alerts: ${res.status}`);
  return res.json();
}

export async function dismissAlert(alertId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/audit/security/alerts/${alertId}/dismiss`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to dismiss alert: ${res.status}`);
}

export async function getAlertsSummary(): Promise<AlertsSummary> {
  const res = await fetch(`${API_URL}/api/v1/audit/security/alerts/summary`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch summary: ${res.status}`);
  return res.json();
}
