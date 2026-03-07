import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveTokenProvider } from '../../core/sync/google-drive-auth';

describe('GoogleDriveTokenProvider', () => {
  it('uses Chrome-managed tokens without persisting them', async () => {
    const identity = {
      getAuthToken: vi.fn().mockResolvedValue({ token: 'token-from-chrome' }),
      removeCachedAuthToken: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new GoogleDriveTokenProvider(identity);

    await expect(provider.getToken()).resolves.toBe('token-from-chrome');
    await provider.invalidate('token-from-chrome');

    expect(identity.getAuthToken).toHaveBeenCalledWith({ interactive: false });
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: 'token-from-chrome' });
  });

  it('maps a missing silent token to an authorization-required state', async () => {
    const provider = new GoogleDriveTokenProvider({
      getAuthToken: vi.fn().mockResolvedValue({}),
      removeCachedAuthToken: vi.fn(),
    });
    await expect(provider.getToken()).rejects.toThrow('GOOGLE_DRIVE_AUTH_REQUIRED');
  });
});
