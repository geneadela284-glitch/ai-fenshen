import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { getValidationPageOptions } from './lib/keyProviderValidationPageState.js';

async function mount() {
  const search = new URLSearchParams(window.location.search);
  const prototypeId = search.get('uiPrototype');
  const validationPage = getValidationPageOptions(window.location.search, import.meta.env);
  const isKeyProviderValidation = validationPage.enabled;
  const isAIFenshenPrototype = import.meta.env.DEV && prototypeId === 'ai-fenshen-v2';
  const RootApp = isAIFenshenPrototype
    ? (await import('./prototypes/aiFenshen/AIFenshenPrototypeApp.jsx')).default
    : (await import('./prototypes/aiFenshen/AIFenshenRealApp.jsx')).default;
  const RoutedRootApp = isKeyProviderValidation
    ? (await import('./components/ProductionKeyProviderValidationPage.jsx')).default
    : RootApp;

  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <RoutedRootApp secondDeviceRecovery={validationPage.secondDeviceRecovery} />
    </React.StrictMode>
  );
}

mount();
