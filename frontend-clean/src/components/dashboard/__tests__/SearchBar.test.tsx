import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SearchBar from '../SearchBar';

const mockSmartSearchStatus = {
  semantic_enabled: true,
  index_status: 'ready',
};

describe('SearchBar smart-search fetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSmartSearchStatus,
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not fetch smart-search status on mount', () => {
    render(
      <SearchBar
        onSearch={vi.fn()}
        darkMode={false}
        zkMode={false}
        files={[]}
      />
    );

    // No fetch calls should have been made on mount
    const smartSearchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/search/smart/status')
    );
    expect(smartSearchCalls).toHaveLength(0);
  });

  it('fetches smart-search status on first input focus', async () => {
    render(
      <SearchBar
        onSearch={vi.fn()}
        darkMode={false}
        zkMode={false}
        files={[]}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);

    await waitFor(() => {
      const smartSearchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/search/smart/status')
      );
      expect(smartSearchCalls).toHaveLength(1);
    });
  });

  it('does not re-fetch on subsequent focuses', async () => {
    render(
      <SearchBar
        onSearch={vi.fn()}
        darkMode={false}
        zkMode={false}
        files={[]}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.focus(input);
    await waitFor(() => {
      const smartSearchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/search/smart/status')
      );
      expect(smartSearchCalls).toHaveLength(1);
    });

    fireEvent.blur(input);
    fireEvent.focus(input);

    // Still only 1 call
    const smartSearchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/search/smart/status')
    );
    expect(smartSearchCalls).toHaveLength(1);
  });

  it('skips fetch in ZK mode', () => {
    render(
      <SearchBar
        onSearch={vi.fn()}
        darkMode={false}
        zkMode={true}
        files={[]}
      />
    );

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);

    const smartSearchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/search/smart/status')
    );
    expect(smartSearchCalls).toHaveLength(0);
  });
});
