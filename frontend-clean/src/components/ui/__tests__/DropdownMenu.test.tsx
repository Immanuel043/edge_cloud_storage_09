import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../DropdownMenu';

const renderMenu = (onShare = vi.fn(), onDelete = vi.fn()) => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>
        <button>Actions</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onShare}>Share</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDelete}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return { onShare, onDelete };
};

describe('DropdownMenu', () => {
  it('is closed by default and opens on trigger click', async () => {
    renderMenu();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share' })).toBeInTheDocument();
  });

  it('fires onSelect and closes when an item is clicked', async () => {
    const { onShare } = renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onShare).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('ArrowDown cycles focus through menu items', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const share = screen.getByRole('menuitem', { name: 'Share' });
    const del = screen.getByRole('menuitem', { name: 'Delete' });
    // First item gets focus asynchronously after positioning rAF (fix #1 in review).
    await waitFor(() => expect(document.activeElement).toBe(share));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(del);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(share); // wraps
  });
});
