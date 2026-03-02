/* @refresh reload */
import { render } from "solid-js/web";
import "./styles/app.css";
import App from "./App";

const ua = navigator.userAgent.toLowerCase();
const platform = navigator.platform.toLowerCase();
const isMacOs = ua.includes("mac") || platform.includes("mac");

document.documentElement.dataset.platform = isMacOs ? "macos" : "non-macos";

render(() => <App />, document.getElementById("root") as HTMLElement);
