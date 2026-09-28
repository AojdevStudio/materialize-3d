import React from "react";
import ReactDOM from "react-dom/client";
import './monaco-env'
import App from "./App";
import { installTauriBrowserMock } from "./dev/tauriBrowserMock";

if (import.meta.env.DEV) {
  installTauriBrowserMock()
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
