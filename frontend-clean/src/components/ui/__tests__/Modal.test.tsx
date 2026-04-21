import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ModalBody, ModalFooter } from '../Modal';
import { Button } from '../Button';

describe('Modal', () => {
  it('does not render when open=false', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hello">
        <ModalBody>Body</ModalBody>
      </Modal>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders dialog with title and labelled by heading', () => {
    render(
      <Modal open onClose={() => {}} title="Share file">
        <ModalBody>Body</ModalBody>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent('Share file');
  });

  it('calls onClose when ESC is pressed', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="x">
        <ModalBody>body</ModalBody>
      </Modal>
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="x">
        <ModalBody>
          <Button>Inner</Button>
        </ModalBody>
        <ModalFooter>
          <Button>Footer</Button>
        </ModalFooter>
      </Modal>
    );
    await userEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('respects dismissOnEscape=false', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} dismissOnEscape={false} title="x">
        <ModalBody>body</ModalBody>
      </Modal>
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
