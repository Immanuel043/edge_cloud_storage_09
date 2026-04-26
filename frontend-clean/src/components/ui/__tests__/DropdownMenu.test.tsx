import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../DropdownMenu';

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalInnerHeight = window.innerHeight;
const originalInnerWidth = window.innerWidth;

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
  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

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

  it('opens upward when there is not enough viewport space below', async () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 300,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 500,
    });
    Element.prototype.getBoundingClientRect = function () {
      if (this.getAttribute('role') === 'menu') {
        return {
          x: 100,
          y: 0,
          top: 0,
          left: 100,
          right: 292,
          bottom: 160,
          width: 192,
          height: 160,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 100,
        y: 260,
        top: 260,
        left: 100,
        right: 124,
        bottom: 284,
        width: 24,
        height: 24,
        toJSON: () => ({}),
      } as DOMRect;
    };

    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));

    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveStyle({
        top: '94px',
        maxHeight: '246px',
      });
    });
  });
});
