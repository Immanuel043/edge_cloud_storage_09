import React from 'react';
import type { FilterPanelProps } from './types';
import { Button, Card, CardContent, FormField, Select } from '@/components/ui';

/**
 * FilterPanel — advanced filter controls for file type, size, and date
 * shown above the file grid/list. Uses Signal tokens + UI primitives.
 */
const FilterPanel: React.FC<FilterPanelProps> = ({ filters, setFilters }) => {
  const hasActiveFilters =
    filters.type !== 'all' || filters.size !== 'all' || filters.date !== 'all';

  return (
    <Card variant="bordered" className="mb-6">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-h3 font-semibold text-fg">Filters</h3>
          {hasActiveFilters && (
            <Button
              variant="link"
              size="sm"
              onClick={() => setFilters({ type: 'all', size: 'all', date: 'all' })}
            >
              Reset filters
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="File type">
            <Select
              value={filters.type}
              onChange={(e) => setFilters({ ...filters, type: e.target.value })}
            >
              <option value="all">All files</option>
              <option value="image">Images</option>
              <option value="document">Documents</option>
              <option value="video">Videos</option>
              <option value="audio">Audio</option>
              <option value="archive">Archives</option>
              <option value="code">Code</option>
            </Select>
          </FormField>

          <FormField label="File size">
            <Select
              value={filters.size}
              onChange={(e) => setFilters({ ...filters, size: e.target.value })}
            >
              <option value="all">All sizes</option>
              <option value="small">Small (&lt; 10MB)</option>
              <option value="medium">Medium (10-100MB)</option>
              <option value="large">Large (&gt; 100MB)</option>
            </Select>
          </FormField>

          <FormField label="Date modified">
            <Select
              value={filters.date}
              onChange={(e) => setFilters({ ...filters, date: e.target.value })}
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </Select>
          </FormField>
        </div>
      </CardContent>
    </Card>
  );
};

export default FilterPanel;
