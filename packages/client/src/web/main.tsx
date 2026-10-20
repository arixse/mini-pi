/**
 * Web 前端入口。
 *
 * 只做"挂到 #root 上"这一件事：状态、动作、事件流都在 `App.tsx` 与
 * `controller.ts` 里，这里放不下也不该放业务逻辑。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

const host = document.getElementById("root") ?? document.body;
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
