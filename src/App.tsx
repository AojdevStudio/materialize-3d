import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import AppLayout from './components/AppLayout'
import OnboardingWizard from './components/OnboardingWizard'
import { applyPrinterSnapshot, usePrinterEvents, usePrinterStore } from './stores/printer'
import { applyWorkspaceSnapshot, useWorkspaceEvents, useWorkspaceStore } from './stores/workspace'
import { usePrintHistoryEvents } from './stores/printHistory'
import { useLibraryEvents } from './stores/libraryStore'
import { useOpenScadEvents, useOpenScadStore } from './stores/openscadStore'
import { usePrinterConfigEvents, usePrinterConfigStore, hydratePrinterConfigs } from './stores/printerConfigs'
import { useSettingsEvents, hydrateSettings } from './stores/settings'
import { useDesignsEvents } from './stores/designs'
import { useUiStore } from './stores/ui'
import './styles/global.css'

declare global {
  interface Window {
    __MATERIALIZE_STORES__?: {
      printer: typeof usePrinterStore
      workspace: typeof useWorkspaceStore
      ui: typeof useUiStore
      openscad: typeof useOpenScadStore
      applyPrinterSnapshot: typeof applyPrinterSnapshot
      applyWorkspaceSnapshot: typeof applyWorkspaceSnapshot
    }
  }
}

interface AppStateSnapshot {
  printer: Parameters<typeof applyPrinterSnapshot>[0]
  workspace: Parameters<typeof applyWorkspaceSnapshot>[0]
}

function AppStateBridge() {
  usePrinterEvents()
  useWorkspaceEvents()
  usePrintHistoryEvents()
  useLibraryEvents()
  useOpenScadEvents()
  usePrinterConfigEvents()
  useSettingsEvents()
  useDesignsEvents()

  useEffect(() => {
    const hydrate = async () => {
      try {
        const snapshot = await invoke<AppStateSnapshot>('get_app_state')
        applyPrinterSnapshot(snapshot.printer)
        applyWorkspaceSnapshot(snapshot.workspace)
        // Hydrate selectedPrinterId from backend if present
        if ((snapshot as any).selectedPrinterId) {
          usePrinterConfigStore.getState().setSelectedPrinterId((snapshot as any).selectedPrinterId)
        }
      } catch (error) {
        console.error('failed to hydrate app state', error)
      }
      // Hydrate printer configs separately
      await hydratePrinterConfigs()
      // Hydrate settings
      await hydrateSettings()
    }

    void hydrate()
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') {
      return
    }

    window.__MATERIALIZE_STORES__ = {
      printer: usePrinterStore,
      workspace: useWorkspaceStore,
      ui: useUiStore,
      openscad: useOpenScadStore,
      applyPrinterSnapshot,
      applyWorkspaceSnapshot,
    }

    return () => {
      delete window.__MATERIALIZE_STORES__
    }
  }, [])

  return null
}

function App() {
  // null = checking, false = show wizard, true = show app
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    const checkOnboarding = async () => {
      try {
        // Check SQLite settings for onboarding completion flag (no Keychain prompt)
        const settings = await invoke<Record<string, string>>('get_settings')
        const completed = settings['onboarding.completed'] === 'true'

        if (!cancelled) {
          setOnboardingComplete(completed)
        }
      } catch {
        // On error (e.g. command not available), default to showing wizard
        if (!cancelled) {
          setOnboardingComplete(false)
        }
      }
    }

    void checkOnboarding()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <AppStateBridge />
      {onboardingComplete === null ? null : onboardingComplete ? (
        <AppLayout />
      ) : (
        <OnboardingWizard onComplete={async () => {
          // Persist onboarding completion in SQLite so we don't re-prompt
          try {
            await invoke('update_settings', {
              settings: { 'onboarding.completed': 'true' },
            })
          } catch (err) {
            console.error('failed to persist onboarding completion', err)
          }
          setOnboardingComplete(true)
        }} />
      )}
    </>
  )
}

export default App
