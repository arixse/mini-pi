/**
 * 标题存储。
 *
 * 这一层的失败模式都很安静：文件读不出来、写了一半、同名会话串了标题，
 * 界面上只会表现为"标题又变长了"，不会报错。所以断言都盯着落盘内容。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FileSessionTitles, parseTitles, serializeTitles } from "./sessionTitles";
import { TITLE_MAX_WIDTH, titleWidth } from "./title";

const dirs: string[] = [];

function tempFile(name = "client-titles.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "minipi-titles-"));
  dirs.push(dir);
  return join(dir, name);
}

after(() => {
  for (const dir of dirs) {
    // 每个用例一个目录；删不掉也不该影响其它用例的结论
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseTitles", () => {
  it("读得出正常的形状", () => {
    const book = parseTitles({ version: 1, titles: { "/w": { "a.jsonl": "收窄标题" } } });
    assert.deepStrictEqual(book, { "/w": { "a.jsonl": "收窄标题" } });
  });

  it("坏的部分逐项跳过，一条坏记录不该带走别人的标题", () => {
    const book = parseTitles({
      titles: {
        "/ok": { "a.jsonl": "好的", "b.jsonl": 42, "c.jsonl": "   " },
        "/bad": ["不是对象"],
        "/alsoBad": "也不是对象",
      },
    });
    assert.deepStrictEqual(book, { "/ok": { "a.jsonl": "好的" } });
  });

  it("整份是数组 / null / 缺 titles 时都给空", () => {
    assert.deepStrictEqual(parseTitles([]), {});
    assert.deepStrictEqual(parseTitles(null), {});
    assert.deepStrictEqual(parseTitles({ version: 1 }), {});
    assert.deepStrictEqual(parseTitles("x"), {});
  });

  it("序列化是可回读的", () => {
    const book = { "/w": { "a.jsonl": "标题" } };
    assert.deepStrictEqual(parseTitles(serializeTitles(book)), book);
  });
});

describe("FileSessionTitles", () => {
  it("记下之后立刻读得到，重建实例也读得到（已落盘）", async () => {
    const file = tempFile();
    const first = new FileSessionTitles(file);
    await first.set("/w", "a.jsonl", "收窄侧栏标题");
    assert.strictEqual(first.get("/w", "a.jsonl"), "收窄侧栏标题");

    const second = new FileSessionTitles(file);
    assert.strictEqual(second.get("/w", "a.jsonl"), "收窄侧栏标题");
  });

  it("不同工作区里的同名会话互不串标题", async () => {
    const file = tempFile();
    const titles = new FileSessionTitles(file);
    await titles.set("/w1", "same.jsonl", "一号的标题");
    await titles.set("/w2", "same.jsonl", "二号的标题");
    assert.strictEqual(titles.get("/w1", "same.jsonl"), "一号的标题");
    assert.strictEqual(titles.get("/w2", "same.jsonl"), "二号的标题");
  });

  it("没记过的会话返回 null，交给调用方退回原话截断", () => {
    const titles = new FileSessionTitles(tempFile());
    assert.strictEqual(titles.get("/w", "nope.jsonl"), null);
  });

  it("落库前按宽度再收一次：模型不听话也不该把侧栏撑开", async () => {
    const titles = new FileSessionTitles(tempFile());
    await titles.set("/w", "a.jsonl", "把客户端里写死的颜色统统收回到设计令牌里并补上暗色主题");
    const stored = titles.get("/w", "a.jsonl");
    assert.ok(stored !== null);
    assert.ok(
      titleWidth(stored) <= TITLE_MAX_WIDTH,
      `落库的标题也得收窄，实际 ${titleWidth(stored)}：${stored}`,
    );
  });

  it("空标题不写：没有比「新会话」更差的占位", async () => {
    const file = tempFile();
    const titles = new FileSessionTitles(file);
    await titles.set("/w", "a.jsonl", "   ");
    assert.strictEqual(titles.get("/w", "a.jsonl"), null);
    assert.strictEqual(existsSync(file), false, "什么都没记就不该创建文件");
  });

  it("forget 只摘一条；摘空的工作区整个消失", async () => {
    const file = tempFile();
    const titles = new FileSessionTitles(file);
    await titles.set("/w", "a.jsonl", "甲");
    await titles.set("/w", "b.jsonl", "乙");
    await titles.forget("/w", "a.jsonl");
    assert.strictEqual(titles.get("/w", "a.jsonl"), null);
    assert.strictEqual(titles.get("/w", "b.jsonl"), "乙");

    await titles.forget("/w", "b.jsonl");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { titles: unknown };
    assert.deepStrictEqual(onDisk.titles, {}, "摘空的根不该留一个空对象在文件里");
  });

  it("文件坏了当没记过，而不是把整列会话拖挂", () => {
    const file = tempFile();
    writeFileSync(file, "{ 不是 JSON", "utf8");
    assert.strictEqual(new FileSessionTitles(file).get("/w", "a.jsonl"), null);
  });

  it("连续写不会丢：串行落盘，最后一次是最全的", async () => {
    const file = tempFile();
    const titles = new FileSessionTitles(file);
    await Promise.all([
      titles.set("/w", "a.jsonl", "甲"),
      titles.set("/w", "b.jsonl", "乙"),
      titles.set("/w", "c.jsonl", "丙"),
    ]);
    const reopened = new FileSessionTitles(file);
    assert.strictEqual(reopened.get("/w", "a.jsonl"), "甲");
    assert.strictEqual(reopened.get("/w", "b.jsonl"), "乙");
    assert.strictEqual(reopened.get("/w", "c.jsonl"), "丙");
  });
});
