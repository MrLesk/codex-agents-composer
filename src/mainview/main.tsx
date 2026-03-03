import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

const EDITABLE_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
  "email",
  "number",
]);

function isEditableInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  const type = (target.type || "text").toLowerCase();
  return EDITABLE_INPUT_TYPES.has(type);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (isEditableInput(target)) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function installClipboardShortcutFallback(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return;
      if (event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (!isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();

      if (key === "a") {
        event.preventDefault();
        document.execCommand("selectAll");
        return;
      }

      // Keep native browser behavior for copy/cut.
      if (key === "c" || key === "x") {
        return;
      }

      if (key === "v") {
        event.preventDefault();
        document.execCommand("paste");
      }
    },
    true,
  );
}

installClipboardShortcutFallback();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
