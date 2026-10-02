import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createOpenAIModel } from "./model";
import { createTextContent } from "./message";

/**
 * OpenAI 兼容路径的流式集成测试。
 *
 * 用本地 SSE 服务器替代真实提供方，验证的是"真心跑一遍 OpenAI SDK 的流式分支"：
 * 请求体里确实带了 stream/stream_options、分片能被正确拼装、
 * 以及在提供方拒绝 stream_options 时能自动降级重试。
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function withServer(
  handler: Handler,
  run: (baseUrl: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(body);
      handler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function writeSse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function baseInput(onDelta?: (delta: string) => void) {
  return {
    systemPrompt: "s",
    messages: [
      { role: "user" as const, content: [createTextContent("hi")], timestamp: Date.now() },
    ],
    tools: [],
    onDelta,
  };
}

describe("OpenAI 流式路径（本地 SSE）", () => {
  it("请求体应带 stream 与 stream_options，并把分片拼成完整回复", async () => {
    await withServer(
      (req, res, body) => {
        assert.ok(req.url?.endsWith("/chat/completions"), `unexpected url ${req.url}`);
        const payload = JSON.parse(body);
        assert.strictEqual(payload.stream, true);
        assert.deepStrictEqual(payload.stream_options, { include_usage: true });

        writeSse(res, [
          { choices: [{ delta: { content: "你" } }] },
          { choices: [{ delta: { content: "好" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          },
        ]);
      },
      async (baseUrl) => {
        const model = createOpenAIModel({
          apiKey: "test-key",
          baseUrl,
          model: "test-model",
        });
        const deltas: string[] = [];

        const message = await model.complete(baseInput((delta) => deltas.push(delta)));

        assert.deepStrictEqual(deltas, ["你", "好"], "应逐段回调 onDelta");
        assert.strictEqual(message.stopReason, "stop");
        assert.strictEqual(
          (message.content[0] as { type: "text"; text: string }).text,
          "你好",
        );
        assert.deepStrictEqual(message.usage, { input: 5, output: 2, totalTokens: 7 });
      },
    );
  });

  it("工具调用分片应拼装为 toolCall 并以 toolUse 结束", async () => {
    await withServer(
      (_req, res) => {
        writeSse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      async (baseUrl) => {
        const model = createOpenAIModel({
          apiKey: "test-key",
          baseUrl,
          model: "test-model",
        });

        const message = await model.complete(baseInput());

        assert.strictEqual(message.stopReason, "toolUse");
        assert.deepStrictEqual(message.content, [
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
        ]);
      },
    );
  });

  it("提供方拒绝 stream_options 时应自动降级重试并成功", async () => {
    await withServer(
      (_req, res, body) => {
        const payload = JSON.parse(body);
        if (payload.stream_options) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Unrecognized request argument supplied: stream_options" },
            }),
          );
          return;
        }
        writeSse(res, [
          { choices: [{ delta: { content: "降级成功" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl, requests) => {
        const model = createOpenAIModel({
          apiKey: "test-key",
          baseUrl,
          model: "test-model",
        });

        const message = await model.complete(baseInput());

        assert.strictEqual(message.stopReason, "stop");
        assert.strictEqual(
          (message.content[0] as { type: "text"; text: string }).text,
          "降级成功",
        );
        assert.strictEqual(requests.length, 2, "第一次失败后应只重试一次");
        assert.ok(JSON.parse(requests[0]).stream_options, "首次请求带 stream_options");
        assert.strictEqual(
          JSON.parse(requests[1]).stream_options,
          undefined,
          "降级后的请求不应再带 stream_options",
        );
      },
    );
  });
});
