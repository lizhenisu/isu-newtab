import { z } from 'zod';
import type { SearchEngine } from '../domain/types';

const suggestionResponseSchema = z.array(z.unknown()).min(2);
const BING_CVID = crypto.randomUUID().replaceAll('-', '').toUpperCase();

export async function fetchSearchSuggestions(engine: SearchEngine, query: string, language: string, signal?: AbortSignal): Promise<string[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  return engine === 'bing'
    ? fetchBingSuggestions(normalized, language, signal)
    : fetchGoogleSuggestions(normalized, signal);
}

async function fetchGoogleSuggestions(query: string, signal?: AbortSignal): Promise<string[]> {
  const url = new URL('https://suggestqueries.google.com/complete/search');
  url.searchParams.set('client', 'chrome');
  url.searchParams.set('q', query);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`SEARCH_SUGGESTIONS_HTTP_${response.status}`);
  const parsed = suggestionResponseSchema.parse(await response.json());
  return normalizeSuggestions(z.array(z.string()).parse(parsed[1]));
}

async function fetchBingSuggestions(query: string, language: string, signal?: AbortSignal): Promise<string[]> {
  const url = new URL('https://www.bing.com/AS/Suggestions');
  url.searchParams.set('pt', 'page.home');
  url.searchParams.set('mkt', language.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
  url.searchParams.set('q', query);
  url.searchParams.set('cvid', BING_CVID);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`SEARCH_SUGGESTIONS_HTTP_${response.status}`);
  return parseBingSuggestionFragment(await response.text());
}

/** Bing's web suggestion endpoint returns an HTML fragment despite its JSON content type. */
export function parseBingSuggestionFragment(fragment: string): string[] {
  const document = new DOMParser().parseFromString(fragment, 'text/html');
  return normalizeSuggestions(Array.from(document.querySelectorAll('li[query]'), (item) => item.getAttribute('query') ?? ''));
}

function normalizeSuggestions(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const item of items) {
    const value = item.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(value);
    if (suggestions.length === 8) break;
  }
  return suggestions;
}
