import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("privacy.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <SiteHeader home={import.meta.env.BASE_URL} label="Materialize 3D, home" solid />
    <main className="privacy" id="main">
      <h1>Privacy</h1>
      <p>
        This page sets no cookies and runs no analytics. It saves your light or dark choice in your browser. Cloudflare
        hosts the page. Downloads come from GitHub.
      </p>
    </main>
    <SiteFooter page="privacy" />
  </StrictMode>,
);
