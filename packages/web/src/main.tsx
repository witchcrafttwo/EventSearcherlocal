import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Admin } from "./Admin";
import "./styles.css";
import "./enavi.css";

const isAdmin = window.location.pathname.replace(/\/$/, "").endsWith("/admin");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isAdmin ? <Admin /> : <App />}
  </React.StrictMode>
);
