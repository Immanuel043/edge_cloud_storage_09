import React, { useState, useEffect } from 'react';
import {
  Shield,
  ShieldCheck,
  Lock,
  User,
  Mail,
  Key,
  AlertTriangle,
  CheckCircle,
  HardDrive,
  Database,
  Search,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { ZK_STORAGE } from '../../config/constants';
import RecoverySettings from '../settings/RecoverySettings';
import type { SettingsViewProps, IndexStatus, ReindexResult } from './types';
import { getErrorMessage } from './types';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Card, CardContent, Progress } from '@/components/ui';

/**
 * SettingsView — account + encryption + search-index + storage-usage
 * settings panel. Rebuilt on Signal primitives (Card sections, Progress
 * meter, Badge for status dots, Button with loading state for reindex,
 * Banner for reindex success/failure). Business logic preserved: index
 * status fetch, reindex POST, ZK KDF readout from localStorage.
 */

interface ZKData {
  kdfSalt?: string;
  encryptedMasterKey?: string;
  kdfAlgorithm?: string;
  kdfIterations?: number;
  kdfMemory?: number;
  masterKeyIV?: string;
}

function getKdfDisplayString(): string {
  try {
    const zkDataStr = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
    if (zkDataStr) {
      const zkData = JSON.parse(zkDataStr) as ZKData;
      const algorithm = zkData.kdfAlgorithm || 'argon2id';
      const iterations = zkData.kdfIterations || 3;
      const memory = zkData.kdfMemory || 65536;

      if (algorithm === 'argon2id') {
        const memoryMB = Math.round(memory / 1024);
        return `Argon2id key derivation (${memoryMB}MB memory, ${iterations} iterations)`;
      } else {
        const iterationsK = Math.round(iterations / 1000);
        return `PBKDF2 key derivation (${iterationsK.toLocaleString()}K iterations)`;
      }
    }
  } catch (e: unknown) {
    console.warn('Failed to read ZK data:', e);
  }
  return 'Argon2id key derivation (64MB memory, 3 iterations)';
}

const SettingsView: React.FC<SettingsViewProps> = () => {
  const { user, zkEnabled } = useAuth();
  const { storageStats } = useStorage();

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isReindexing, setIsReindexing] = useState<boolean>(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);

  useEffect(() => {
    const fetchIndexStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_URL}/api/v1/search/reindex/status`, {
          credentials: 'include',
        });
        if (response.ok) {
          const data = (await response.json()) as IndexStatus;
          setIndexStatus(data);
        }
      } catch (e: unknown) {
        console.error('Failed to fetch index status:', e);
      }
    };
    void fetchIndexStatus();
  }, [reindexResult]);

  const handleReindex = async (): Promise<void> => {
    setIsReindexing(true);
    setReindexResult(null);
    try {
      const response = await fetch(`${API_URL}/api/v1/search/reindex`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.ok) {
        const data = (await response.json()) as ReindexResult;
        setReindexResult(data);
      } else {
        const error = (await response.json()) as { detail?: string };
        setReindexResult({ success: false, message: error.detail || 'Re-indexing failed' });
      }
    } catch (e: unknown) {
      setReindexResult({ success: false, message: getErrorMessage(e) });
    } finally {
      setIsReindexing(false);
    }
  };

  const storageUsed = storageStats?.used || 0;
  const storageTotal = storageStats?.total || 107374182400;
  const storagePercent = Math.min(100, (storageUsed / storageTotal) * 100);
  const storageTone: 'primary' | 'warning' | 'danger' =
    storagePercent > 90 ? 'danger' : storagePercent > 70 ? 'warning' : 'primary';

  return (
    <div className="space-y-6">
      <h1 className="text-h1 font-semibold text-fg">Settings</h1>

      {/* Account Information */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <User className="h-5 w-5" />
            Account information
          </h2>
          <div className="space-y-3 text-body-sm text-fg">
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-fg-muted" />
              <span>{user?.email}</span>
            </div>
            <div className="flex items-center gap-3">
              <User className="h-4 w-4 text-fg-muted" />
              <span>{user?.username}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Storage Usage */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <HardDrive className="h-5 w-5" />
            Storage usage
          </h2>
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex justify-between text-body-sm text-fg-muted">
                <span>{formatBytes(storageUsed)} used</span>
                <span>{formatBytes(storageTotal)} total</span>
              </div>
              <Progress value={storagePercent} tone={storageTone} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <StatTile
                icon={<Database className="h-4 w-4 text-primary" />}
                label="Available"
                value={formatBytes(storageTotal - storageUsed)}
              />
              <StatTile
                icon={<HardDrive className="h-4 w-4 text-success" />}
                label="Files"
                value={String(storageStats?.files_count || storageStats?.fileCount || 0)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Search & Indexing (non-ZK only) */}
      {!zkEnabled && (
        <Card variant="bordered">
          <CardContent className="p-6">
            <h2 className="mb-3 flex items-center gap-2 text-h3 font-semibold text-fg">
              <Search className="h-5 w-5" />
              Search & indexing
            </h2>
            <p className="mb-4 text-body-sm text-fg-muted">
              Manage search indexing for your files. Re-index if search is not finding your
              files.
            </p>

            {indexStatus && (
              <div className="mb-4 rounded-lg border border-border bg-surface p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-body-sm">
                  <StatusLine
                    label="Elasticsearch status"
                    value={
                      indexStatus.elasticsearch_status === 'connected'
                        ? 'Connected'
                        : 'Disconnected'
                    }
                    tone={
                      indexStatus.elasticsearch_status === 'connected' ? 'success' : 'danger'
                    }
                  />
                  <StatusLine
                    label="Sync status"
                    value={
                      indexStatus.sync_status === 'synced' ? 'Synced' : 'Out of sync'
                    }
                    tone={indexStatus.sync_status === 'synced' ? 'success' : 'warning'}
                  />
                  <div>
                    <span className="text-fg-muted">Files in database:</span>
                    <span className="ml-2 font-medium text-fg">
                      {String(indexStatus.database_files)}
                    </span>
                  </div>
                  <div>
                    <span className="text-fg-muted">Files indexed:</span>
                    <span className="ml-2 font-medium text-fg">
                      {String(indexStatus.indexed_files)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <Button
              variant="primary"
              size="md"
              onClick={() => void handleReindex()}
              disabled={isReindexing}
              loading={isReindexing}
              leftIcon={isReindexing ? undefined : <RefreshCw className="h-4 w-4" />}
            >
              {isReindexing ? 'Re-indexing...' : 'Re-index all files'}
            </Button>

            {reindexResult && (
              <div className="mt-4">
                <Banner
                  variant={reindexResult.success ? 'success' : 'danger'}
                  icon={
                    reindexResult.success ? <CheckCircle /> : <AlertTriangle />
                  }
                >
                  <div className="font-medium">{reindexResult.message}</div>
                  {reindexResult.success && reindexResult.indexed !== undefined && (
                    <div className="mt-1 text-caption">
                      Indexed: {reindexResult.indexed} · Failed:{' '}
                      {reindexResult.failed || 0} · Total: {reindexResult.total || 0}
                    </div>
                  )}
                </Banner>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Security & Encryption */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <Shield className="h-5 w-5" />
            Security & encryption
          </h2>

          {zkEnabled ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-3">
                <ShieldCheck className="h-6 w-6 flex-shrink-0 text-success" />
                <div>
                  <p className="font-medium text-success">
                    Zero-knowledge encryption enabled
                  </p>
                  <p className="text-body-sm text-fg-muted">
                    Your files are encrypted end-to-end. Only you can decrypt them.
                  </p>
                </div>
              </div>
              <div className="space-y-1 text-body-sm text-fg-muted">
                <p className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  Client-side encryption with AES-256-GCM
                </p>
                <p className="flex items-center gap-2">
                  <Key className="h-4 w-4" />
                  {getKdfDisplayString()}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-3">
                <ShieldCheck className="h-6 w-6 flex-shrink-0 text-success" />
                <div>
                  <p className="font-medium text-success">Server-side encryption active</p>
                  <p className="text-body-sm text-fg-muted">
                    Your files are encrypted at rest with AES-256.
                  </p>
                </div>
              </div>
              <p className="text-body-sm text-fg-muted">
                For zero-knowledge end-to-end encryption, create a separate ZK account from
                the registration page.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {zkEnabled && <RecoverySettings />}
    </div>
  );
};

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactElement;
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <span className="text-caption text-fg-muted">{label}</span>
      </div>
      <p className="font-semibold text-fg">{value}</p>
    </div>
  );
}

function StatusLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger';
}): React.ReactElement {
  return (
    <div>
      <span className="text-fg-muted">{label}:</span>
      <Badge
        variant={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'danger'}
        size="sm"
        className={cn('ml-2')}
      >
        {value}
      </Badge>
    </div>
  );
}

export default SettingsView;
