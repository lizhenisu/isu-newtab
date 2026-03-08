import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveTokenProvider } from '../../core/sync/google-drive-auth';
import { GoogleDriveRestClient } from '../../core/sync/google-drive-client';

describe('GoogleDriveRestClient', () => {
  it('invalidates one rejected token and retries exactly once', async () => {
    const identity = {
      getAuthToken: vi.fn()
        .mockResolvedValueOnce({ token: 'stale-token' })
        .mockResolvedValueOnce({ token: 'fresh-token' }),
      removeCachedAuthToken: vi.fn().mockResolvedValue(undefined),
    };
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const client = new GoogleDriveRestClient(new GoogleDriveTokenProvider(identity), request);

    await expect(client.list()).resolves.toEqual({ files: [], nextPageToken: undefined });

    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: 'stale-token' });
    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer fresh-token' });
  });

  it('backs off twice for transient Drive responses before reporting a rate limit', async () => {
    const identity = {
      getAuthToken: vi.fn().mockResolvedValue({ token: 'token' }),
      removeCachedAuthToken: vi.fn().mockResolvedValue(undefined),
    };
    const request = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = new GoogleDriveRestClient(new GoogleDriveTokenProvider(identity), request, wait);

    await expect(client.list()).rejects.toThrow('GOOGLE_DRIVE_RATE_LIMIT');
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('lists only private device heads for a lightweight remote probe', async () => {
    const identity = {
      getAuthToken: vi.fn().mockResolvedValue({ token: 'token' }),
      removeCachedAuthToken: vi.fn().mockResolvedValue(undefined),
    };
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const client = new GoogleDriveRestClient(new GoogleDriveTokenProvider(identity), request);

    await client.listHeads('next-page');

    const url = new URL(request.mock.calls[0]![0] as string);
    expect(url.searchParams.get('pageToken')).toBe('next-page');
    expect(url.searchParams.get('q')).toContain("isuSyncKind' and value='head'");
  });

  it('writes appDataFolder parents only when creating a file', async () => {
    const identity = {
      getAuthToken: vi.fn().mockResolvedValue({ token: 'token' }),
      removeCachedAuthToken: vi.fn().mockResolvedValue(undefined),
    };
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1' }), { status: 200 }));
    const client = new GoogleDriveRestClient(new GoogleDriveTokenProvider(identity), request);
    const create = { name: 'isu-head-device.json', mimeType: 'application/json', parents: ['appDataFolder'], appProperties: { isuSyncProtocol: '2' } };
    const update = { name: 'isu-head-device.json', mimeType: 'application/json', appProperties: { isuSyncProtocol: '2' } };

    await client.create(create, '{}');
    await client.update('file-1', update, '{}');

    const createBody = (request.mock.calls[0]![1] as RequestInit).body as string;
    const updateBody = (request.mock.calls[1]![1] as RequestInit).body as string;
    expect(createBody).toContain('"parents":["appDataFolder"]');
    expect(updateBody).not.toContain('"parents"');
  });
});
