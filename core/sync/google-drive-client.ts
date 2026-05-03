import { GoogleDriveTokenProvider } from './google-drive-auth';

export type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
};

type GoogleDriveWritableMetadata = Pick<GoogleDriveFile, 'name' | 'appProperties'> & { mimeType: string };

/** Metadata accepted when creating a new private appDataFolder record. */
export type GoogleDriveCreateMetadata = GoogleDriveWritableMetadata & { parents: string[] };

/** Metadata accepted by Drive PATCH; a file's parents are not directly writable. */
export type GoogleDriveUpdateMetadata = GoogleDriveWritableMetadata & { parents?: never };
export type GoogleDriveListResult = { files: GoogleDriveFile[]; nextPageToken?: string };

export interface GoogleDriveClient {
  list(pageToken?: string): Promise<GoogleDriveListResult>;
  listHeads(pageToken?: string): Promise<GoogleDriveListResult>;
  download(fileId: string): Promise<string>;
  create(metadata: GoogleDriveCreateMetadata, content: string): Promise<GoogleDriveFile>;
  update(fileId: string, metadata: GoogleDriveUpdateMetadata, content: string): Promise<GoogleDriveFile>;
  remove(fileId: string): Promise<void>;
}

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOADS = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,name,mimeType,appProperties,modifiedTime';

/** Minimal Drive v3 transport for Isu's private appDataFolder records. */
export class GoogleDriveRestClient implements GoogleDriveClient {
  constructor(
    private readonly tokens = new GoogleDriveTokenProvider(),
    // Service-worker fetch is a Web API method. Keep its global receiver so
    // Chrome cannot reject the request when the transport calls it indirectly.
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async list(pageToken?: string): Promise<GoogleDriveListResult> {
    return this.listRecords("appProperties has { key='isuSyncProtocol' and value='2' }", pageToken);
  }

  async listHeads(pageToken?: string): Promise<GoogleDriveListResult> {
    return this.listRecords("appProperties has { key='isuSyncProtocol' and value='2' } and appProperties has { key='isuSyncKind' and value='head' }", pageToken);
  }

  private async listRecords(filter: string, pageToken?: string): Promise<GoogleDriveListResult> {
    const query = new URLSearchParams({ spaces: 'appDataFolder', q: filter, pageSize: '100', fields: `nextPageToken,files(${FILE_FIELDS})` });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await this.authorized(`${DRIVE_FILES}?${query}`);
    const value = await json(response);
    return { files: Array.isArray(value.files) ? value.files as GoogleDriveFile[] : [], nextPageToken: typeof value.nextPageToken === 'string' ? value.nextPageToken : undefined };
  }

  async download(fileId: string): Promise<string> {
    const response = await this.authorized(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`);
    return response.text();
  }

  async create(metadata: GoogleDriveCreateMetadata, content: string): Promise<GoogleDriveFile> {
    const response = await this.authorized(`${DRIVE_UPLOADS}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      ...multipart(metadata, content),
    });
    return await json(response) as GoogleDriveFile;
  }

  async update(fileId: string, metadata: GoogleDriveUpdateMetadata, content: string): Promise<GoogleDriveFile> {
    const response = await this.authorized(`${DRIVE_UPLOADS}/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'PATCH',
      ...multipart(metadata, content),
    });
    return await json(response) as GoogleDriveFile;
  }

  async remove(fileId: string): Promise<void> {
    await this.authorized(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  }

  private async authorized(url: string, init: RequestInit = {}, tokenRetried = false, attempt = 0): Promise<Response> {
    const token = await this.tokens.getToken(false);
    let response: Response;
    try {
      response = await this.request(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    } catch (error) {
      // The user-facing state remains localized; DevTools gets the native
      // browser reason without exposing the bearer token.
      console.warn('[Isu Google Drive] request failed', {
        url: new URL(url).pathname,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw new Error('GOOGLE_DRIVE_NETWORK');
    }
    if (response.status === 401 && !tokenRetried) {
      await this.tokens.invalidate(token);
      return this.authorized(url, init, true, attempt);
    }
    if (response.ok) return response;
    if (response.status === 401) throw new Error('GOOGLE_DRIVE_AUTH_REQUIRED');
    if (response.status === 403) throw new Error('GOOGLE_DRIVE_ACCESS_DENIED');
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await this.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 250 * (attempt + 1));
      return this.authorized(url, init, tokenRetried, attempt + 1);
    }
    if (response.status === 429) throw new Error('GOOGLE_DRIVE_RATE_LIMIT');
    if (response.status >= 500) throw new Error('GOOGLE_DRIVE_UNAVAILABLE');
    throw new Error(`GOOGLE_DRIVE_HTTP_${response.status}`);
  }
}

function multipart(metadata: GoogleDriveCreateMetadata | GoogleDriveUpdateMetadata, content: string): Pick<RequestInit, 'headers' | 'body'> {
  const boundary = `isu-${crypto.randomUUID()}`;
  return {
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n`,
      `--${boundary}--`,
    ].join(''),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // A successful Drive API response must still contain valid metadata.
  }
  throw new Error('GOOGLE_DRIVE_RESPONSE_INVALID');
}
