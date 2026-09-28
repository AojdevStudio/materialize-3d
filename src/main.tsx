import React from "react";
import ReactDOM from "react-dom/client";
import './monaco-env'
import App from "./App";
import { installTauriBrowserMock } from "./dev/tauriBrowserMock";
import { initAgentStorage } from "./agent/storage";
import { registerTauriOAuthProviders } from "./agent/oauth-providers";

if (import.meta.env.DEV) {
  installTauriBrowserMock()
}

// Register Tauri-native OAuth providers before storage init so they're
// available before any agent is created.
registerTauriOAuthProviders()

// Storage must be initialized before any React component that uses
// ChatPanel or agent APIs mounts.
initAgentStorage()
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error('agent:storage-init-failed', error);
    // Render the app anyway so the user sees something, but agent features will be disabled
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
