import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LicenseGate } from "./license/LicenseGate";
import "./styles.css";

try {
  const theme = window.localStorage.getItem("roxwana-theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LicenseGate><App /></LicenseGate>
  </React.StrictMode>,
);
