import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock lazy-loaded children so we test the shell only
vi.mock('../zk/ZKDashboard', () => ({
  default: () => <div data-testid="zk-dashboard">ZKDashboard</div>,
}));
vi.mock('../normal/Dashboard', () => ({
  default: () => <div data-testid="normal-dashboard">NormalDashboard</div>,
}));
vi.mock('../../auth/SessionUnlockModal', () => ({
  default: () => <div data-testid="session-unlock-modal">SessionUnlockModal</div>,
}));

// Mock contexts
const mockAuth = {
  user: { username: 'test' },
  logout: vi.fn(),
  zkEnabled: false,
  zkSessionUnlocked: false,
  lockSession: vi.fn(),
  showUnlockModal: false,
  isAuthenticated: true,
  loading: false,
};

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ darkMode: false, toggleTheme: vi.fn() }),
}));

vi.mock('../../../contexts/StorageContext', () => ({
  useStorage: () => ({
    files: [],
    folders: [],
    currentFolder: null,
    currentFolderName: null,
    storageStats: null,
    selectedFiles: new Set(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    deleteFile: vi.fn(),
    createFolder: vi.fn(),
    navigateToFolder: vi.fn(),
    selectFile: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    refreshFiles: vi.fn(),
    lastSyncedAt: null,
  }),
}));

describe('Dashboard Shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.zkEnabled = false;
    mockAuth.zkSessionUnlocked = false;
    mockAuth.showUnlockModal = false;
  });

  it('renders NormalDashboard when zkEnabled is false', async () => {
    const Dashboard = (await import('../Dashboard')).default;
    render(<Dashboard />);
    // Wait for lazy component to resolve through Suspense
    await waitFor(() => {
      expect(screen.getByTestId('normal-dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('zk-dashboard')).not.toBeInTheDocument();
  });

  it('renders ZKDashboard when zkEnabled and zkSessionUnlocked', async () => {
    mockAuth.zkEnabled = true;
    mockAuth.zkSessionUnlocked = true;
    const Dashboard = (await import('../Dashboard')).default;
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('zk-dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('normal-dashboard')).not.toBeInTheDocument();
  });

  it('renders SessionUnlockModal when showUnlockModal is true', async () => {
    mockAuth.showUnlockModal = true;
    const Dashboard = (await import('../Dashboard')).default;
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('session-unlock-modal')).toBeInTheDocument();
    });
  });

  it('does not render SessionUnlockModal when showUnlockModal is false', async () => {
    mockAuth.showUnlockModal = false;
    const Dashboard = (await import('../Dashboard')).default;
    render(<Dashboard />);
    // Wait for lazy dashboard to render, then confirm no unlock modal
    await waitFor(() => {
      expect(screen.getByTestId('normal-dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('session-unlock-modal')).not.toBeInTheDocument();
  });
});
