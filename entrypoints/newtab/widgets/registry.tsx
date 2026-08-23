import type { AppConfig, SearchHistorySource, SearchPreferences, Shortcut, ShortcutGroup } from '../../../core/domain/types';
import type { SystemWidgetId, WidgetPosition } from '../../../core/domain/widgets';
import type { ReactNode } from 'react';
import { ClockWidget } from '../components/ClockWidget';
import { DailyQuote } from '../components/DailyQuote';
import { FocusTimer } from '../components/FocusTimer';
import { GreetingWidget } from '../components/GreetingWidget';
import { QuickNote } from '../components/QuickNote';
import { SearchWidget } from '../components/SearchWidget';
import { WeatherWidget } from '../components/WeatherWidget';

export type DashboardWidgetContext = {
  now: Date;
  config: AppConfig;
  searchPreferences: SearchPreferences;
  searchHistorySource: SearchHistorySource;
  onAddShortcut(position?: WidgetPosition): void;
  onAddGroup(position?: WidgetPosition): void;
  onEditShortcut(shortcut: Shortcut): void;
  onDeleteShortcut(id: string): Promise<void>;
  onRenameGroup(group: ShortcutGroup): void;
  onDeleteGroup(group: ShortcutGroup): Promise<void>;
  onMoveShortcut(id: string, groupId: string, beforeId?: string, afterId?: string, position?: WidgetPosition, commit?: import('../../../core/domain/desktop').DesktopCommit): Promise<void>;
  onMoveGroup(id: string, beforeId?: string, afterId?: string): Promise<void>;
  onSetWidgetEnabled?(id: SystemWidgetId, enabled: boolean): Promise<void>;
  onSetWidgetSize?(id: SystemWidgetId, preset: import('../../../core/domain/widgets').WidgetSizePreset): Promise<void>;
};

type WidgetDefinition = {
  id: SystemWidgetId;
  labelKey: string;
  render(context: DashboardWidgetContext): ReactNode;
};

export const WIDGET_REGISTRY: Record<SystemWidgetId, WidgetDefinition> = {
  clock: { id: 'clock', labelKey: 'widgetClock', render: ({ now }) => <ClockWidget now={now} /> },
  greeting: { id: 'greeting', labelKey: 'widgetGreeting', render: ({ now }) => <GreetingWidget now={now} /> },
  focusTimer: { id: 'focusTimer', labelKey: 'focusTimer', render: () => <FocusTimer /> },
  search: { id: 'search', labelKey: 'widgetSearch', render: (context) => <SearchWidget preferences={context.searchPreferences} historySource={context.searchHistorySource} /> },
  quickNote: { id: 'quickNote', labelKey: 'quickNote', render: () => <QuickNote /> },
  dailyQuote: { id: 'dailyQuote', labelKey: 'widgetDailyQuote', render: ({ now }) => <DailyQuote now={now} /> },
  weather: { id: 'weather', labelKey: 'widgetWeather', render: () => <WeatherWidget /> },
};
