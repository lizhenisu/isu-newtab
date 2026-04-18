import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../../../core/browser/i18n';
import { useAppStore } from '../../../../core/state/store';
import type { SyncStatusRecord } from '../../../../core/sync/status-store';

type ConflictSummary = { local?: { groups: number; shortcuts: number }; remote?: { groups: number; shortcuts: number }; summary?: { onlyLocal: number; onlyRemote: number; bothModified: number; deleteModifyConflicts: number; estimatedResult: number } };

export function SyncSettings() {
  const syncMode = useAppStore((state) => state.syncMode);
  const setSyncMode = useAppStore((state) => state.setSyncMode);
  const [driveSelected, setDriveSelected] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();

  useEffect(() => { if (syncMode === 'google-drive') setDriveSelected(false); }, [syncMode]);

  const selectMode = async (mode: 'local' | 'chrome' | 'google-drive') => {
    setConnectionError(undefined);
    if (mode === 'google-drive' && syncMode !== 'google-drive') {
      setDriveSelected(true);
      return;
    }
    try {
      await setSyncMode(mode);
      setDriveSelected(false);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  };

  const connectDrive = async () => {
    setConnectionError(undefined);
    try {
      const result = await chrome.identity.getAuthToken({ interactive: true });
      if (!result.token) throw new Error('GOOGLE_DRIVE_AUTH_CANCELLED');
      await setSyncMode('google-drive');
      setDriveSelected(false);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section>
      <h3>{t('sync')}</h3>
      <label>{t('sync')}<select value={driveSelected ? 'google-drive' : syncMode} onChange={(event) => void selectMode(event.target.value as 'local' | 'chrome' | 'google-drive')}>
        <option value="chrome">{t('chromeSync')}</option>
        <option value="google-drive">{t('googleDriveSync')}</option>
        <option value="local">{t('localOnly')}</option>
      </select></label>
      {(driveSelected || syncMode === 'google-drive') && <div className="syncDriveActions">
        {syncMode === 'google-drive'
          ? <button type="button" className="secondary" onClick={() => void selectMode('local')}>{t('disconnectGoogleDrive')}</button>
          : <><p>{t('googleDriveSyncDescription')}</p><button type="button" onClick={() => void connectDrive()}>{t('connectGoogleDrive')}</button></>}
        {connectionError && <p className="syncDriveError" role="status">{syncMessage(connectionError)}</p>}
      </div>}
      <SyncStatus />
    </section>
  );
}

function SyncStatus() {
  const [status, setStatus] = useState<Partial<SyncStatusRecord>>({});
  const [conflict, setConflict] = useState<ConflictSummary>();
  useEffect(() => {
    browser.storage.local.get(['syncStatus', 'syncConflict']).then((value) => {
      setStatus(value.syncStatus as typeof status ?? {});
      setConflict(value.syncConflict as typeof conflict);
    });
    const listener = (changes: Record<string, Browser.storage.StorageChange>) => {
      if (changes.syncStatus) setStatus(changes.syncStatus.newValue as typeof status ?? {});
      if (changes.syncConflict) setConflict(changes.syncConflict.newValue as typeof conflict);
    };
    browser.storage.local.onChanged.addListener(listener);
    return () => browser.storage.local.onChanged.removeListener(listener);
  }, []);
  const resolve = async (choice: 'local-overwrite' | 'remote-replace' | 'external-import') => {
    if (!window.confirm(t('confirmOverwrite'))) return;
    await browser.runtime.sendMessage({ type: 'sync:resolve', choice });
  };
  const completedAt = formatCompletedAt(status.updatedAt);
  const label = status.state === 'syncing'
    ? t('syncing')
    : status.state === 'auth-required'
      ? t('googleDriveAuthorizationRequired')
    : status.state === 'warning'
      ? `${t('syncWarning')} (${Math.round((status.usedBytes ?? 0) / 1024)} KB)${completedAt ? ` · ${t('syncCompleted')} (${completedAt})` : ''}`
      : status.state === 'error' || status.state === 'conflict'
        ? `${t('syncError')}: ${syncMessage(status.message)}`
        : status.state === 'disabled'
          ? t('syncDisabled')
          : status.state === 'idle' && completedAt
            ? `${t('syncCompleted')} (${completedAt})`
            : t('syncIdle');
  return <div className={`syncStatus ${status.state ?? 'idle'}`}><p>{label}</p>{status.state === 'conflict' && conflict && <div className="conflictBox"><small>{t('localData')}: {conflict.local?.groups ?? 0} / {conflict.local?.shortcuts ?? 0}<br />{t('remoteData')}: {conflict.remote?.groups ?? 0} / {conflict.remote?.shortcuts ?? 0}{conflict.summary && <><br />{t('onlyLocal')}: {conflict.summary.onlyLocal} · {t('onlyRemote')}: {conflict.summary.onlyRemote}<br />{t('bothModified')}: {conflict.summary.bothModified} · {t('deleteModifyConflict')}: {conflict.summary.deleteModifyConflicts}<br />{t('estimatedResult')}: {conflict.summary.estimatedResult}</>}</small><div><button type="button" onClick={() => resolve('external-import')}>{t('importRemote')}</button><button type="button" className="secondary" onClick={() => resolve('local-overwrite')}>{t('useLocal')}</button><button type="button" className="secondary" onClick={() => resolve('remote-replace')}>{t('useRemote')}</button></div></div>}</div>;
}

function syncMessage(code?: string): string {
  switch (code) {
    case 'REMOTE_ENVELOPE_CORRUPT':
    case 'REMOTE_GRAPH_CORRUPT': return `${t('syncRecoveryRemoteCorrupt')} (${code})`;
    case 'REMOTE_DATASET_CHANGED': return `${t('syncRecoveryDatasetChanged')} (${code})`;
    case 'REMOTE_GENERATION_CHANGED': return `${t('syncRecoveryGenerationChanged')} (${code})`;
    case 'BASELINE_CORRUPT': return `${t('syncRecoveryBaselineCorrupt')} (${code})`;
    case 'GOOGLE_DRIVE_AUTH_REQUIRED': return t('googleDriveAuthorizationRequired');
    case 'GOOGLE_DRIVE_AUTH_CANCELLED': return t('googleDriveAuthorizationCancelled');
    case 'GOOGLE_DRIVE_ACCESS_DENIED': return t('googleDriveAccessDenied');
    case 'GOOGLE_DRIVE_RATE_LIMIT': return t('googleDriveRateLimited');
    case 'GOOGLE_DRIVE_NETWORK': return t('googleDriveNetworkError');
    case 'GOOGLE_DRIVE_UNAVAILABLE': return t('googleDriveUnavailable');
    default: return code || t('syncRecoveryRequired');
  }
}

function formatCompletedAt(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}
