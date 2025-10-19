import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import StorageOptimization from './StorageOptimization';

const mockSuggestions = [
  {
    id: 1,
    suggestion_type: 'tier_migration',
    priority: 'high',
    estimated_savings_bytes: 2 * 1024 ** 3,
    title: 'Move old files to cold storage',
    description: '10 files haven\'t been accessed in 60 days',
    action_data: { file_ids: [1, 2, 3], target_tier: 'cold' },
  },
  {
    id: 2,
    suggestion_type: 'compression',
    priority: 'medium',
    estimated_savings_bytes: 500 * 1024 ** 2,
    title: 'Compress large text files',
    description: 'Save 500MB by compressing 5 large documents',
    action_data: { file_ids: [4, 5] },
  },
];

describe('StorageOptimization Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders optimization suggestions', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ suggestions: mockSuggestions }),
    });

    render(
      <BrowserRouter>
        <StorageOptimization />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/move old files to cold storage/i)).toBeInTheDocument();
      expect(screen.getByText(/compress large text files/i)).toBeInTheDocument();
    });
  });

  it('displays savings estimate', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ suggestions: mockSuggestions }),
    });

    render(
      <BrowserRouter>
        <StorageOptimization />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/2.*GB/i)).toBeInTheDocument();
    });
  });

  it('applies optimization suggestion on button click', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ suggestions: mockSuggestions }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    render(
      <BrowserRouter>
        <StorageOptimization />
      </BrowserRouter>
    );

    await waitFor(() => {
      const applyButton = screen.getAllByText(/apply/i)[0];
      fireEvent.click(applyButton);
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('dismisses suggestion', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ suggestions: mockSuggestions }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dismissed: true }),
      });

    render(
      <BrowserRouter>
        <StorageOptimization />
      </BrowserRouter>
    );

    await waitFor(() => {
      const dismissButton = screen.getAllByText(/dismiss/i)[0];
      fireEvent.click(dismissButton);
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('filters suggestions by priority', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ suggestions: mockSuggestions }),
    });

    render(
      <BrowserRouter>
        <StorageOptimization />
      </BrowserRouter>
    );

    await waitFor(() => {
      const filterSelect = screen.getByLabelText(/priority/i);
      fireEvent.change(filterSelect, { target: { value: 'high' } });
    });

    await waitFor(() => {
      expect(screen.getByText(/move old files/i)).toBeInTheDocument();
      expect(screen.queryByText(/compress large text/i)).not.toBeInTheDocument();
    });
  });
});
