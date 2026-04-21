import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileActionsMenu } from '../shared/FileActionsMenu';
import type { FileItem } from '../types';

const makeFile = (): FileItem => ({
  id: 'f1',
  name: 'plan.pdf',
  size: 1024,
});

const openMenu = async () => {
  // IconButton trigger has aria-label "File actions".
  await userEvent.click(screen.getByRole('button', { name: /file actions/i }));
};

describe('FileActionsMenu', () => {
  it('shows Preview / Download / Share / Version history / Delete by default', async () => {
    render(
      <FileActionsMenu
        file={makeFile()}
        onFilePreview={vi.fn()}
        onFileDownload={vi.fn()}
        onFileShare={vi.fn()}
        onVersionHistory={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /preview/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /share/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /version history/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^delete$/i })).toBeInTheDocument();
    // Optional actions are not rendered when handlers are absent.
    expect(
      screen.queryByRole('menuitem', { name: /make a copy/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('calls onFileDownload with file id + name', async () => {
    const onFileDownload = vi.fn();
    render(
      <FileActionsMenu
        file={makeFile()}
        onFilePreview={vi.fn()}
        onFileDownload={onFileDownload}
        onFileShare={vi.fn()}
        onVersionHistory={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /download/i }));
    expect(onFileDownload).toHaveBeenCalledWith('f1', 'plan.pdf');
  });

  it('in trashedView swaps Delete copy and adds Restore', async () => {
    const onRestore = vi.fn();
    render(
      <FileActionsMenu
        file={makeFile()}
        onFilePreview={vi.fn()}
        onFileDownload={vi.fn()}
        onFileShare={vi.fn()}
        onVersionHistory={vi.fn()}
        onFileDelete={vi.fn()}
        trashedView
        onRestore={onRestore}
      />
    );
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /restore/i })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /delete forever/i })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledWith('f1');
  });
});
