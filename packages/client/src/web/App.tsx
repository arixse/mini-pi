/**
 * 装配层：控制器、键盘、走字定时器，全部收在这一处。
 *
 * 组件（Topbar / Sidebar / Timeline / Composer / Settings / Picker）都只
 * 读状态、只调动作，自己不持有业务状态。这样"谁是唯一真值"没有歧义：
 * 状态在 `ClientStore` 里，动作在 `AppController` 里，组件只是它们的投影。
 */

import { useEffect, useRef, useState } from "react";
import { AppController, type ComposerHandle } from "./controller";
import { titleFor } from "./notify";
import { ClientProvider, useActions, useClient } from "./store";
import { Boot } from "./components/Boot";
import { Composer } from "./components/Composer";
import { DiffPanel } from "./components/DiffPanel";
import { FilePreview } from "./components/FilePreview";
import { Picker } from "./components/Picker";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Statusbar } from "./components/Statusbar";
import { Timeline } from "./components/Timeline";
import { Topbar } from "./components/Topbar";

export function App(): React.ReactElement {
  // 控制器在挂载时建一次：它持有事件流与"正在输入什么"以外的全部会话状态
  const [controller] = useState(() => new AppController());
  const value = { store: controller.store, actions: controller.actions };
  return (
    <ClientProvider value={value}>
      <Shell controller={controller} />
    </ClientProvider>
  );
}

function Shell({ controller }: { controller: AppController }): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const composerRef = useRef<ComposerHandle | null>(null);

  useEffect(() => {
    controller.attachComposer(composerRef);
    void controller.boot();
  }, [controller]);

  /*
   * 全局键盘（空态稿公示的三组 + Esc）。
   *
   * - Esc：只收浮层，不停任务（见 handleEscape）；
   * - Ctrl+N：新任务；Ctrl+,：打开设置——这两组直接走动作层；
   * - Ctrl+K：聚焦侧栏搜索（搜工作区名）。侧栏收起时先把它拉开——对一个 display:none
   *   的输入框调 focus() 是空操作，等一帧再聚焦（React 提交之后）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        controller.handleEscape();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        if (!controller.store.current.ui.sidebar) {
          controller.actions.toggleSidebar();
        }
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".side-search input")?.focus();
        });
        return;
      }
      if (key === "n") {
        event.preventDefault();
        controller.actions.newTask();
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        controller.actions.openSettings();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  // 运行中的耗时要走字：只在这一种状态下每秒重画一次（见 controller.tick）
  useEffect(() => {
    const timer = window.setInterval(() => controller.tick(), 1000);
    return () => window.clearInterval(timer);
  }, [controller]);

  // 有待裁决时在标签页标题上留一个数字：人切到别的页也能看见
  const title = titleFor(state.approvals);
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = title;
    }
  }, [title]);

  return (
    <div className={`app${state.ui.sidebar ? " nav-open" : ""}`}>
      <Topbar />
      <div className="body">
        <Sidebar />
        <div className="drawer-mask" onClick={() => actions.closeSidebar()} />
        {/*
         * 主列：状态行 / 会话 / 输入区三层，设计稿第 1 页的纵向结构。
         * 状态行属于主列而不是通栏——分隔线从侧栏右缘起（§2）。
         * 变更面板绝对定位盖在会话这一层上：侧栏、状态行与输入区都在场。
         */}
        <div className="main-col">
          <Statusbar />
          <div className="main-stage">
            <Timeline />
            <DiffPanel />
            <FilePreview />
          </div>
          <Composer handleRef={composerRef} />
        </div>
      </div>
      <Settings />
      <Picker />
      <Boot />
    </div>
  );
}
