import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

vi.mock('wxt/browser', () => ({
  browser: (() => {
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const port = () => ({ name: 'mock-port', sender: undefined, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: event(), onDisconnect: event() });
    return {
    i18n: { getMessage: (key: string) => key },
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(() => port()),
      getURL: vi.fn((path = '') => `chrome-extension://test${path.startsWith('/') ? path : `/${path}`}`),
      onInstalled: event(),
      onConnect: event(),
    },
    contextMenus: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      removeAll: vi.fn().mockResolvedValue(undefined),
      onClicked: event(),
    },
    history: { search: vi.fn().mockResolvedValue([]) },
    permissions: {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(true),
      onRemoved: event(),
    },
    search: { query: vi.fn().mockResolvedValue(undefined) },
    tabs: { create: vi.fn().mockResolvedValue({}) },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  })(),
}));
