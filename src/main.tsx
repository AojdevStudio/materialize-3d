import React from "react";
import ReactDOM from "react-dom/client";
import PopOut, { popOutFile } from "./studio/PopOut";
import StudioApp from "./studio/StudioApp";

const popOut = popOutFile(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {popOut === null ? <StudioApp /> : <PopOut {...popOut} />}
  </React.StrictMode>,
);
