import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

// Mock API responses
const mockQuotaData = {
  current_usage_bytes: 5 * 1024 ** 3,
  quota_bytes: 10 * 1024 ** 3,
  usage_percentage: 50,
};

const mockPrediction = {
  predicted_usage_bytes: 7 * 1024 ** 3,
  confidence_score: 0.85,
  prediction_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  algorithm_used: 'prophet',
};

const mockAlerts = [
  {
    id: 1,
    alert_type: 'warning',
    severity: 'high',
    message: 'Storage will reach 90% capacity in 10 days',
    created_at: new Date().toISOString(),
  },
];

describe('Dashboard Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dashboard layout', () => {
    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>
    );

    expect(screen.getByText(/dashboard/i)).toBeInTheDocument();
  });

  it('displays storage quota information', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockQuotaData,
    });

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/50%/)).toBeInTheDocument();
    });
  });

  it('displays quota predictions', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockQuotaData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPrediction,
      });

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/predicted/i)).toBeInTheDocument();
    });
  });

  it('displays quota alerts', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockQuotaData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ alerts: mockAlerts }),
      });

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/storage will reach 90% capacity/i)).toBeInTheDocument();
    });
  });

  it('handles API errors gracefully', async () => {
    global.fetch.mockRejectedValueOnce(new Error('API Error'));

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });
  });
});
