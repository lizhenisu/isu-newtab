export interface GoogleDriveTokenProvider {
  getToken(interactive?: boolean): Promise<string>;
  invalidate(token: string): Promise<void>;
  clearCredentials(): Promise<void>;
}

export type ChromeGoogleDriveTokenApi = {
  getAuthToken(details?: chrome.identity.TokenDetails): Promise<chrome.identity.GetAuthTokenResult>;
  removeCachedAuthToken(details: chrome.identity.InvalidTokenDetails): Promise<void>;
};

/** Keeps Chrome access tokens inside the browser-managed identity cache. */
export class ChromeGoogleDriveTokenProvider implements GoogleDriveTokenProvider {
  constructor(private readonly identity: ChromeGoogleDriveTokenApi = chrome.identity) {}

  async getToken(interactive = false): Promise<string> {
    try {
      const result = await this.identity.getAuthToken({ interactive });
      if (result.token) return result.token;
      throw new Error(interactive ? 'GOOGLE_DRIVE_AUTH_CANCELLED' : 'GOOGLE_DRIVE_AUTH_REQUIRED');
    } catch (error) {
      const message = errorMessage(error);
      if (/cancel|denied|not signed|login|required|oauth/i.test(message)) {
        throw new Error(interactive ? 'GOOGLE_DRIVE_AUTH_CANCELLED' : 'GOOGLE_DRIVE_AUTH_REQUIRED');
      }
      throw error;
    }
  }

  async invalidate(token: string): Promise<void> {
    await this.identity.removeCachedAuthToken({ token });
  }

  async clearCredentials(): Promise<void> {
    // Chrome owns the durable grant. A local mode switch must not revoke a
    // Google grant which may also be in use by another browser installation.
  }
}

export function createGoogleDriveTokenProvider(): GoogleDriveTokenProvider {
  return new ChromeGoogleDriveTokenProvider();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
