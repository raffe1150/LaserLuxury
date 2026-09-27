import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  GoogleEmbeddingProvider,
  type GoogleEmbeddingClient,
} from "./embeddings";

test("embedDocuments sends one Content per document and preserves vector order", async () => {
  let capturedRequest: Parameters<
    GoogleEmbeddingClient["models"]["embedContent"]
  >[0] | null = null;
  const firstValues = Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0.1);
  const secondValues = Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0.2);

  const provider = new GoogleEmbeddingProvider({
    apiKeyProvider: () => "test-only-key",
    clientFactory: (apiKey) => {
      assert.equal(apiKey, "test-only-key");
      return {
        models: {
          async embedContent(request) {
            capturedRequest = request;
            return {
              embeddings: [
                { values: firstValues },
                { values: secondValues },
              ],
            };
          },
        },
      };
    },
  });

  const result = await provider.embedDocuments([
    " First document text. ",
    "Second document text.",
  ]);

  assert.ok(capturedRequest);
  assert.deepEqual(capturedRequest.contents, [
    {
      role: "user",
      parts: [{ text: "First document text." }],
    },
    {
      role: "user",
      parts: [{ text: "Second document text." }],
    },
  ]);
  assert.equal(capturedRequest.config?.outputDimensionality, 768);
  assert.equal(result.length, 2);
  assert.equal(result[0].values, firstValues);
  assert.equal(result[1].values, secondValues);
  assert.deepEqual(result.map((embedding) => embedding.dimensions), [768, 768]);
});
