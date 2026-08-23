import type { SearchEngine } from '../domain/types';

function isChinese(language: string): boolean {
  return language.toLocaleLowerCase().startsWith('zh');
}

export function buildTextSearchTarget(engine: SearchEngine, query: string, language: string): string {
  const target = new URL(engine === 'google' ? 'https://www.google.com/search' : 'https://www.bing.com/search');
  target.searchParams.set('q', query.trim());
  target.searchParams.set(engine === 'google' ? 'hl' : 'setlang', engine === 'google' ? (isChinese(language) ? 'zh-CN' : 'en') : (isChinese(language) ? 'zh-Hans' : 'en-US'));
  return target.toString();
}

export function buildVisualSearchTarget(engine: SearchEngine, language: string): string {
  const target = new URL(engine === 'google' ? 'https://images.google.com/' : 'https://www.bing.com/images');
  target.searchParams.set(engine === 'google' ? 'hl' : 'setlang', engine === 'google' ? (isChinese(language) ? 'zh-CN' : 'en') : (isChinese(language) ? 'zh-Hans' : 'en-US'));
  return target.toString();
}
