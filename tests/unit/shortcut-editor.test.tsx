import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutEditor } from '../../entrypoints/newtab/components/ShortcutEditor';

afterEach(cleanup);

describe('ShortcutEditor', () => {
  it('submits a shortcut with its selected group', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ShortcutEditor groups={[{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision: { counter: 1, deviceId: 'a' } }]} defaultGroupId="default" onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveClass('modal--editor');
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Example' } });
    fireEvent.change(screen.getByLabelText('url'), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Example', url: 'example.com', groupId: 'default' }));
  });

  it('uses the shared SVG plus icon for an empty local-icon picker', () => {
    render(<ShortcutEditor groups={[{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision: { counter: 1, deviceId: 'a' } }]} defaultGroupId="default" onSave={vi.fn()} onClose={vi.fn()} />);
    const chooseButton = screen.getByRole('button', { name: 'shortcutIconChoose' });
    expect(chooseButton.querySelector('svg.shortcutIconPicker__plus path')).toHaveAttribute('d', 'M12 5v14M5 12h14');
    expect(chooseButton).not.toHaveTextContent('＋');
  });

  it('previews a selected local icon and submits it with the shortcut', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { getByLabelText, getByRole, getByTitle } = render(<ShortcutEditor groups={[{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision: { counter: 1, deviceId: 'a' } }]} defaultGroupId="default" onSave={onSave} onClose={vi.fn()} />);
    const icon = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'example-icon.svg', { type: 'image/svg+xml' });
    fireEvent.change(getByLabelText('name'), { target: { value: 'Example' } });
    fireEvent.change(getByLabelText('url'), { target: { value: 'example.com' } });
    fireEvent.change(getByLabelText('shortcutIconChoose'), { target: { files: [icon] } });
    await vi.waitFor(() => expect(getByTitle('example-icon.svg')).toBeInTheDocument());
    const clearButton = getByRole('button', { name: 'shortcutIconClear' });
    expect(clearButton).toHaveClass('shortcutIconPicker__clear');
    expect(clearButton.querySelector('svg[aria-hidden="true"] path')).toHaveAttribute('d', 'm7 7 10 10M17 7 7 17');
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    fireEvent.click(getByRole('button', { name: 'save' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Example', url: 'example.com', groupId: 'default' }, icon));
  });

  it('clears a selected local icon and blocks saving after invalid selection', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ShortcutEditor groups={[{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision: { counter: 1, deviceId: 'a' } }]} defaultGroupId="default" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Example' } });
    fireEvent.change(screen.getByLabelText('url'), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText('shortcutIconChoose'), { target: { files: [new File(['not an image'], 'icon.txt', { type: 'text/plain' })] } });
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('shortcutIconInvalid'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave).not.toHaveBeenCalled();

    const icon = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'example-icon.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByLabelText('shortcutIconChoose'), { target: { files: [icon] } });
    await vi.waitFor(() => expect(screen.getByTitle('example-icon.svg')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'shortcutIconClear' }));
    expect(screen.queryByTitle('example-icon.svg')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Example', url: 'example.com', groupId: 'default' }));
  });
});
