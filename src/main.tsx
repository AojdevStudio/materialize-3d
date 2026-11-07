import React from "react";
import ReactDOM from "react-dom/client";
import StudioApp from "./studio/StudioApp";

// The chat studio is the app. The earlier CAD, printer, and library screens
// stay in the tree, unused, until the MVP settles what comes back.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StudioApp />
  </React.StrictMode>,
);
