import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FilePreview from '../FilePreview';

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { username: 'test' },
    zkEnabled: false,
    zkSessionUnlocked: false,
  }),
}));

vi.mock('../../../config/constants', () => ({
  API_URL: 'http://api.test',
  ZK_SERVICE_URL: 'http://zk.test',
}));

const FILE_ID = 'f25ea4da-6581-4c3f-9494-1a554531af02';

const REJECTED_PAYLOAD = {
  status: 'rejected',
  reason: 'size_or_duration',
  duration_seconds: 12816.04,
  size_bytes: 67_000_000_000,
  max_size_gib: 2,
  max_duration_minutes: 30,
  message:
    'Video is too long or too large for the in-page player. Use Open Original to play it directly in your browser.',
  file_id: FILE_ID,
};

describe('FilePreview – transcode rejected', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/transcode/progress')) {
        return new Response(JSON.stringify(REJECTED_PAYLOAD), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Anything else (download, preview, etc.) — fail loudly so we notice if
      // the component goes ahead and tries to load the video stream.
      return new Response('not mocked', { status: 500 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('shows the warning banner, hides the <video>, and offers an Open Original link', async () => {
    render(
      <FilePreview
        file={{
          id: FILE_ID,
          name: 'huge.mp4',
          size: REJECTED_PAYLOAD.size_bytes,
          mime_type: 'video/mp4',
        }}
        onClose={vi.fn()}
        darkMode={false}
      />
    );

    // Warning banner uses role="alert"; wait for it to appear.
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Banner copy explains the why and quotes both actuals + limits.
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toMatch(/too long or too large for the in-page player/i);
    expect(alert.textContent ?? '').toMatch(/3 h 33 min/);
    expect(alert.textContent ?? '').toMatch(/62\.4 GiB/);
    expect(alert.textContent ?? '').toMatch(/30 min/);
    expect(alert.textContent ?? '').toMatch(/2 GiB/);

    // No <video> element should render in this state.
    expect(document.querySelector('video')).toBeNull();

    // Primary CTA points at the original-stream URL with target=_blank.
    const cta = screen.getByRole('link', { name: /open original/i });
    expect(cta).toHaveAttribute(
      'href',
      `http://api.test/api/v1/files/${FILE_ID}/download?inline=true&original=true`
    );
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta).toHaveAttribute('rel', expect.stringMatching(/noopener/));

    // Polling must stop — we should only see the single progress call, not a retry stream.
    const progressCalls = fetchSpy.mock.calls.filter((c) => {
      const u = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
      return u.includes('/transcode/progress');
    });
    expect(progressCalls.length).toBe(1);
  });
});
