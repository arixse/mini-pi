import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  initialTheme,
  isThemeMode,
  readStoredTheme,
  systemTheme,
  toggledTheme,
  writeStoredTheme,
  type ThemePrefers,
  type ThemeStorage,
} from "./theme";

/** 会抛的假存储：隐私模式 / 被禁用时的 localStorage 就是这个行为 */
class ThrowingStorage implements ThemeStorage {
  getItem(): string | null {
    throw new Error("storage disabled");
  }
  setItem(): void {
    throw new Error("storage disabled");
  }
}

class MemoryStorage implements ThemeStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function prefers(light: boolean): ThemePrefers {
  return { matches: (query: string) => query.includes("light") && light };
}

describe("主题", () => {
  it("认得出的只有 dark / light，别的一律不是", () => {
    assert.equal(isThemeMode("dark"), true);
    assert.equal(isThemeMode("light"), true);
    assert.equal(isThemeMode("Dark"), false);
    assert.equal(isThemeMode(""), false);
    assert.equal(isThemeMode(null), false);
    assert.equal(isThemeMode(undefined), false);
  });

  it("没存过按系统偏好，系统也问不出来按深色", () => {
    assert.equal(initialTheme(new MemoryStorage(), prefers(true)), "light");
    assert.equal(initialTheme(new MemoryStorage(), prefers(false)), "dark");
    assert.equal(initialTheme(null, null), "dark");
  });

  it("用户选过的压过系统偏好", () => {
    const storage = new MemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, "dark");
    assert.equal(initialTheme(storage, prefers(true)), "dark");
    storage.setItem(THEME_STORAGE_KEY, "light");
    assert.equal(initialTheme(storage, prefers(false)), "light");
  });

  it("存了坏值当作没存过，不把界面卡在认不出的模式上", () => {
    const storage = new MemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, "rainbow");
    assert.equal(readStoredTheme(storage), null);
    assert.equal(initialTheme(storage, prefers(false)), "dark");
  });

  it("存储不可用时读写都安静失败", () => {
    const storage = new ThrowingStorage();
    assert.equal(readStoredTheme(storage), null);
    assert.doesNotThrow(() => writeStoredTheme(storage, "light"));
  });

  it("系统偏好抛异常也按深色", () => {
    const broken: ThemePrefers = {
      matches: () => {
        throw new Error("no matchMedia");
      },
    };
    assert.equal(systemTheme(broken), "dark");
    assert.equal(systemTheme(null), "dark");
  });

  it("切换就是深浅互换", () => {
    assert.equal(toggledTheme("dark"), "light");
    assert.equal(toggledTheme("light"), "dark");
  });

  it("落到根节点的只有 data-theme 一个属性", () => {
    const calls: Array<[string, string]> = [];
    const root = { setAttribute: (name: string, value: string) => calls.push([name, value]) };
    applyTheme(root, "light");
    applyTheme(root, "dark");
    assert.deepEqual(calls, [
      ["data-theme", "light"],
      ["data-theme", "dark"],
    ]);
    // 没有 DOM（服务端渲染、单测）时不能抛
    assert.doesNotThrow(() => applyTheme(null, "light"));
  });

  it("写进去的再读出来还是同一个", () => {
    const storage = new MemoryStorage();
    writeStoredTheme(storage, "light");
    assert.equal(readStoredTheme(storage), "light");
  });
});
