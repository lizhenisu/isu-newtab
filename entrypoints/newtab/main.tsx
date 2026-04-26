import React from 'react';
import ReactDOM from 'react-dom/client';
import { t } from '../../core/browser/i18n';
import { App } from './App';
import './style.css';
import './settings.css';
import './folder.css';
import './modal-theme.css';

document.title = t('newTabTitle');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
