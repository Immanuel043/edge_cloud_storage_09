import React from 'react';
import { Shield, Cloud } from 'lucide-react';
import { Badge } from '@/components/ui';

interface ServiceModeBadgeProps {
  isZKMode: boolean;
  darkMode?: boolean;
}

/**
 * ServiceModeBadge — header indicator for the active service mode.
 * Green "ZK Encrypted" chip for zero-knowledge, blue "Standard Storage"
 * chip otherwise.
 */
const ServiceModeBadge: React.FC<ServiceModeBadgeProps> = ({ isZKMode }) => {
  if (isZKMode) {
    return (
      <Badge variant="success" size="sm">
        <Shield size={14} />
        ZK Encrypted
      </Badge>
    );
  }

  return (
    <Badge variant="info" size="sm">
      <Cloud size={14} />
      Standard Storage
    </Badge>
  );
};

export default ServiceModeBadge;
