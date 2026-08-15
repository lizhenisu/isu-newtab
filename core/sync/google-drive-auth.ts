export type GoogleDriveTokenApi = {
  getAuthToken(details?: chrome.identity.TokenDetails): Promise<chrome.identity.GetAuthTokenResult>;
  removeCachedAuthToken(details: chrome.identity.InvalidTokenDetails): Promise<void>;
};

/** Keeps OAuth access tokens inside Chrome's identity cache, never IndexedDB. */
export class GoogleDriveTokenProvider {
  constructor(private readonly identity: GoogleDriveTokenApi = chrome.identity) {}

  async getToken(interactive = false): Promise<string> {
    try {
      const result = await this.identity.getAuthToken({ interactive });
      if (result.token) return result.token;
      throw new Error(interactive ? 'GOOGLE_DRIVE_AUTH_CANCELLED' : 'GOOGLE_DRIVE_AUTH_REQUIRED');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel|denied|not signed|login|required|oauth/i.test(message)) {
        throw new Error(interactive ? 'GOOGLE_DRIVE_AUTH_CANCELLED' : 'GOOGLE_DRIVE_AUTH_REQUIRED');
      }
      throw error;
    }
  }

  async invalidate(token: string): Promise<void> {
    await this.identity.removeCachedAuthToken({ token });
  }
}
