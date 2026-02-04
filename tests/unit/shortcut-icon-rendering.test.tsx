import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRepositories } from '../../core/storage/repository';
import { ShortcutIcon } from '../../entrypoints/newtab/components/ShortcutIcon';
import { ShortcutIconCacheProvider, useShortcutIconCache } from '../../entrypoints/newtab/components/ShortcutIconCache';

afterEach(() => vi.restoreAllMocks());

describe('shortcut icon cache rendering', () => {
  it('refreshes only the uploaded shortcut and keeps its former object URL through the dissolve', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:initial-a').mockReturnValueOnce('blob:initial-b').mockReturnValueOnce('blob:updated-a');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(appRepositories.assets, 'getShortcutIcons').mockResolvedValue(new Map([
      ['a', new Blob(['a'])],
      ['b', new Blob(['b'])],
    ]));
    vi.spyOn(appRepositories.assets, 'getShortcutIcon').mockResolvedValue(new Blob(['new-a']));

    const { result, rerender } = renderHook(({ refresh }) => useShortcutIconCache(['a', 'b'], refresh), { initialProps: { refresh: undefined as { shortcutId: string; version: number } | undefined } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const untouchedUrl = result.current.urls.get('b');

    await act(async () => rerender({ refresh: { shortcutId: 'a', version: 1 } }));
    await waitFor(() => expect(result.current.urls.get('a')).toBe('blob:updated-a'));
    expect(result.current.urls.get('b')).toBe(untouchedUrl);
    expect(revokeUrl).not.toHaveBeenCalledWith('blob:initial-a');
    expect(createUrl).toHaveBeenCalledTimes(3);
  });

  it('renders an initial cache hit directly and dissolves a later cache replacement', async () => {
    const highResolutionAvailable = vi.fn();
    const renderIcon = (cachedUrl: string) => <ShortcutIconCacheProvider urls={new Map([['shortcut', cachedUrl]])}>
      <ShortcutIcon shortcutId="shortcut" url="https://example.com" onHighResolutionAvailable={highResolutionAvailable} />
    </ShortcutIconCacheProvider>;
    const { container, rerender } = render(renderIcon('blob:initial'));

    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:initial');
    expect(highResolutionAvailable).not.toHaveBeenCalled();

    rerender(renderIcon('blob:replacement'));
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    const incoming = container.querySelector('.shortcutIconMedia--incoming')!;
    expect(incoming.getAttribute('src')).toBe('blob:replacement');
    expect(highResolutionAvailable).toHaveBeenCalledTimes(1);

  });
});
