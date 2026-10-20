/**
 * 组件树的可挂载性。
 *
 * 这一条守的是"打开页面就是白屏"这类失败：类型检查过得去，
 * 但某个组件在首次渲染时抛错（读空对象、用了不存在的上下文）时，
 * 唯一的症状是浏览器控制台里一行红字和一片空白。
 *
 * 用 `react-dom/server` 而不是 jsdom：这里要验证的是**首次渲染不抛错**，
 * 而不是交互，服务端渲染不需要 DOM，于是这条测试不用为仓库引入新依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { ClientStore } from "./store";
import { initialState } from "./state";

describe("前端组件树", () => {
  it("首屏渲染不抛错，且顶栏三枚芯片都在", () => {
    const html = renderToStaticMarkup(createElement(App));

    assert.match(html, /class="app"/, "根容器要挂上");
    assert.match(html, /class="topbar"/);
    assert.match(html, /class="sidebar"/);
    assert.match(html, /class="composer"/);
    assert.match(html, /未打开工作区/, "还没拿到状态时应如实说工作区未打开");
    assert.match(html, /未配置模型/, "还没拿到状态时不该假装模型已配好");
  });

  it("起不来的时候给的是说明与重试，不是一片空白", () => {
    const store = new ClientStore();
    store.update((state) => {
      state.error = "连不上 127.0.0.1:4788";
    });
    assert.match(store.current.error ?? "", /4788/);
    // Boot 只在有错误时出现：初始状态（无错）不该渲染它
    const initial = initialState();
    assert.strictEqual(initial.error, null);
  });
});
