import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  estimateChatMessageTokens,
  toAnthropicPayload,
  toOpenAIMessages,
  toResponsesInput,
} from "../server/backend/agent/provider-chat.ts";
import { appendUserMessage, getStream } from "../server/backend/agent/broker.ts";
import { appendHistory, historyAsChatMessages } from "../server/backend/forwarder/history.ts";

const image = {
  type: "image",
  mimeType: "image/png",
  dataBase64: Buffer.from("fixture-image-bytes").toString("base64"),
  path: "C:/fixture/image.png",
};
const messages = [
  {
    role: "user",
    content: "Describe this image.",
    contentParts: [{ type: "text", text: "Describe this image." }, image],
  },
];

const openai = toOpenAIMessages(messages);
assert.ok(Array.isArray(openai[0].content), "OpenAI chat content must be multipart");
assert.equal(openai[0].content[1].type, "image_url");
assert.match(openai[0].content[1].image_url.url, /^data:image\/png;base64,/);

const responses = toResponsesInput(messages);
assert.equal(responses.input[0].content[1].type, "input_image");
assert.match(responses.input[0].content[1].image_url, /^data:image\/png;base64,/);

const anthropic = toAnthropicPayload(messages);
assert.ok(Array.isArray(anthropic.messages[0].content), "Anthropic content must be blocks");
assert.deepEqual(anthropic.messages[0].content[1], {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: image.dataBase64,
  },
});

assert.ok(
  estimateChatMessageTokens(messages[0]) >= 1024,
  "Image must participate in the context estimate",
);

const previousStudioHome = process.env.CURSOR_STUDIO_HOME;
const temporaryStudioHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-image-parts-"));
const historyKey = `smoke-image-history-${Date.now()}`;
const streamKey = `smoke-image-stream-${Date.now()}`;
try {
  process.env.CURSOR_STUDIO_HOME = temporaryStudioHome;
  await appendHistory(
    historyKey,
    "user",
    messages[0].content,
    undefined,
    messages[0].contentParts,
  );
  const restored = await historyAsChatMessages(historyKey);
  assert.equal(restored[0]?.contentParts?.[1]?.type, "image");
  assert.equal(restored[0]?.contentParts?.[1]?.dataBase64, image.dataBase64);

  appendUserMessage(streamKey, {
    content: messages[0].content,
    contentParts: messages[0].contentParts,
  });
  assert.equal(getStream(streamKey)?.messages[0]?.contentParts?.[1]?.type, "image");
} finally {
  if (previousStudioHome == null) delete process.env.CURSOR_STUDIO_HOME;
  else process.env.CURSOR_STUDIO_HOME = previousStudioHome;
  await fs.rm(temporaryStudioHome, { recursive: true, force: true });
}

console.log("PASS smoke-image-parts");
