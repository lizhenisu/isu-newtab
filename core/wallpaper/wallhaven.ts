import { z } from 'zod';

const wallpaperSchema = z.object({
  id: z.string(),
  url: z.string().url().refine((url) => url.startsWith('https://wallhaven.cc/')),
  thumbs: z.object({ large: z.string().url().refine((url) => url.startsWith('https://th.wallhaven.cc/')) }),
  path: z.string().url().refine((url) => url.startsWith('https://w.wallhaven.cc/')),
});

const responseSchema = z.object({
  data: z.array(wallpaperSchema),
  meta: z.object({ current_page: z.number(), last_page: z.number() }),
});

export type WallhavenResult = z.infer<typeof wallpaperSchema>;
export type WallhavenPage = { items: WallhavenResult[]; page: number; lastPage: number };

const cache = new Map<string, { expiresAt: number; value: WallhavenPage }>();

export async function searchWallhaven(query: string, page: number, categories = '111', signal?: AbortSignal): Promise<WallhavenPage> {
  const normalizedQuery = query.trim();
  const sorting = normalizedQuery ? 'relevance' : 'date_added';
  const key = `${normalizedQuery}::${page}::${categories}::${sorting}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const params = new URLSearchParams({ page: String(page), categories, purity: '100', sorting });
  if (normalizedQuery) params.set('q', normalizedQuery);
  const response = await fetch(`https://wallhaven.cc/api/v1/search?${params}`, { signal });
  if (response.status === 429) throw new Error('WALLHAVEN_RATE_LIMITED');
  if (!response.ok) throw new Error(`WALLHAVEN_HTTP_${response.status}`);
  const parsed = responseSchema.parse(await response.json());
  const value = { items: parsed.data, page: parsed.meta.current_page, lastPage: parsed.meta.last_page };
  cache.set(key, { expiresAt: Date.now() + 10 * 60 * 1000, value });
  return value;
}

/** Gets a fresh SFW random batch. Random responses intentionally bypass the search cache. */
export async function fetchWallhavenRandom(signal?: AbortSignal): Promise<WallhavenResult[]> {
  const params = new URLSearchParams({ categories: '111', purity: '100', sorting: 'random' });
  const response = await fetch(`https://wallhaven.cc/api/v1/search?${params}`, { signal });
  if (response.status === 429) throw new Error('WALLHAVEN_RATE_LIMITED');
  if (!response.ok) throw new Error(`WALLHAVEN_HTTP_${response.status}`);
  return responseSchema.parse(await response.json()).data;
}
