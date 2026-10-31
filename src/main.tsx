import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

// Set before the first paint so a light theme does not flash dark on start.
document.documentElement.dataset.theme = localStorage.getItem("dispatch.theme") === "light" ? "light" : "dark";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
