import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeviceIdentity, createInitialConfig } from '../../core/domain/defaults';
import type { AppConfig } from '../../core/domain/types';
import { useAppStore } from '../../core/state/store';
import { Modal } from '../../entrypoints/newtab/components/Modal';

const originalState = useAppStore.getState();

function setTheme(theme: AppConfig['appearance']['theme']['value']) {
  const config = createInitialConfig(createDeviceIdentity());
  config.appearance.theme.value = theme;
  useAppStore.setState({ ...originalState, config }, true);
}

beforeEach(() => setTheme('system'));
afterEach(() => {
  cleanup();
  useAppStore.setState(originalState, true);
});

describe('Modal theme context', () => {
  it.each(['light', 'dark', 'system'] as const)('applies the saved %s preference to every modal variant', (theme) => {
    setTheme(theme);
    const { unmount } = render(<Modal title="Drawer" onClose={() => undefined} variant="drawer">content</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-theme', theme);
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-theme', theme);
    unmount();

    render(<Modal title="Editor" onClose={() => undefined} variant="editor">content</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-theme', theme);
    cleanup();

    render(<Modal title="Folder" onClose={() => undefined}>content</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-theme', theme);
  });

  it('falls back to the system preference until configuration is available', () => {
    useAppStore.setState({ ...originalState, config: null }, true);
    render(<Modal title="Loading" onClose={() => undefined}>content</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-theme', 'system');
  });
});
