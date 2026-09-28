import {
  AppStorage,
  IndexedDBStorageBackend,
  SettingsStore,
  ProviderKeysStore,
  SessionsStore,
  CustomProvidersStore,
  setAppStorage,
} from '@mariozechner/pi-web-ui';

let storage: AppStorage | null = null;

/**
 * Initialize IndexedDB-backed storage for the Pi SDK agent runtime.
 * Must be called before any component that uses ChatPanel or agent APIs.
 */
export async function initAgentStorage(): Promise<AppStorage> {
  if (storage) {
    console.debug('agent:storage-initialized', '(already initialized, returning existing)');
    return storage;
  }

  try {
    const settings = new SettingsStore();
    const providerKeys = new ProviderKeysStore();
    const sessions = new SessionsStore();
    const customProviders = new CustomProvidersStore();

    const backend = new IndexedDBStorageBackend({
      dbName: 'materialize-3d',
      version: 1,
      stores: [
        settings.getConfig(),
        providerKeys.getConfig(),
        sessions.getConfig(),
        SessionsStore.getMetadataConfig(),
        customProviders.getConfig(),
      ],
    });

    settings.setBackend(backend);
    providerKeys.setBackend(backend);
    sessions.setBackend(backend);
    customProviders.setBackend(backend);

    storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
    setAppStorage(storage);

    console.debug('agent:storage-initialized');
    return storage;
  } catch (error) {
    console.error('agent:storage-init-failed', error);
    throw error;
  }
}

/**
 * Get the initialized storage instance.
 * Throws if `initAgentStorage()` has not been called yet.
 */
export function getAgentStorage(): AppStorage {
  if (!storage) {
    throw new Error(
      'Agent storage not initialized. Call initAgentStorage() before accessing storage.'
    );
  }
  return storage;
}
