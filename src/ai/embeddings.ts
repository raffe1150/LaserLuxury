import { GoogleGenAI } from "@google/genai";

type EmbedContentRequest = Parameters<
  GoogleGenAI["models"]["embedContent"]
>[0];
type EmbedContentResult = Awaited<ReturnType<
  GoogleGenAI["models"]["embedContent"]
>>;

export interface GoogleEmbeddingClient {
  models: {
    embedContent(
      request: EmbedContentRequest,
    ): Promise<Pick<EmbedContentResult, "embeddings">>;
  };
}

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_VERSION = 1;

export interface EmbeddingVector {
  values: number[];
  provider: string;
  model: string;
  dimensions: number;
  version: number;
}

export interface EmbeddingProvider {
  readonly supportsLocalSemanticSearch?: boolean;
  embedDocuments(texts: string[]): Promise<EmbeddingVector[]>;
  embedQuery(text: string): Promise<EmbeddingVector>;
}

export interface GoogleEmbeddingProviderOptions {
  apiKeyProvider: () => string | undefined;
  model?: string;
  dimensions?: number;
  version?: number;
  clientFactory?: (apiKey: string) => GoogleEmbeddingClient;
}

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKeyProvider: () => string | undefined;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly version: number;
  private readonly clientFactory: (apiKey: string) => GoogleEmbeddingClient;

  constructor(options: GoogleEmbeddingProviderOptions) {
    this.apiKeyProvider = options.apiKeyProvider;
    this.model = options.model || DEFAULT_EMBEDDING_MODEL;
    this.dimensions =
      Number.isInteger(options.dimensions) && Number(options.dimensions) > 0
        ? Number(options.dimensions)
        : DEFAULT_EMBEDDING_DIMENSIONS;
    this.version =
      Number.isInteger(options.version) && Number(options.version) > 0
        ? Number(options.version)
        : DEFAULT_EMBEDDING_VERSION;
    this.clientFactory = options.clientFactory ||
      ((apiKey) => new GoogleGenAI({ apiKey }));
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    const normalized = texts.map((value) => String(value || "").trim());

    if (
      normalized.length === 0 ||
      normalized.some((value) => !value)
    ) {
      throw new Error("Embedding documents must contain non-empty text.");
    }

    const apiKey = String(this.apiKeyProvider() || "").trim();
    if (!apiKey) {
      throw new Error("Embedding provider API key is unavailable.");
    }

    const ai = this.clientFactory(apiKey);

    const response = await ai.models.embedContent({
      model: this.model,
      // @google/genai folds a string[] into one Content with multiple parts.
      // Explicit Content objects preserve the one-document/one-vector mapping.
      contents: normalized.map((text) => ({
        role: "user",
        parts: [{ text }],
      })),
      config: {
        outputDimensionality: this.dimensions,
      },
    });

    const embeddings = Array.isArray(response?.embeddings)
      ? response.embeddings
      : [];

    if (embeddings.length !== normalized.length) {
      throw new Error("Embedding provider returned an unexpected result count.");
    }

    return embeddings.map((embedding: any) =>
      this.normalizeEmbedding(embedding?.values)
    );
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    const normalized = String(text || "").trim();
    if (!normalized) {
      throw new Error("Embedding query must contain non-empty text.");
    }

    const apiKey = String(this.apiKeyProvider() || "").trim();
    if (!apiKey) {
      throw new Error("Embedding provider API key is unavailable.");
    }

    const ai = this.clientFactory(apiKey);

    const response = await ai.models.embedContent({
      model: this.model,
      contents: normalized,
      config: {
        outputDimensionality: this.dimensions,
      },
    });

    const embedding = Array.isArray(response?.embeddings)
      ? response.embeddings[0]
      : null;

    return this.normalizeEmbedding(embedding?.values);
  }

  private normalizeEmbedding(values: unknown): EmbeddingVector {
    if (
      !Array.isArray(values) ||
      values.length !== this.dimensions ||
      values.some(
        (value) =>
          typeof value !== "number" ||
          !Number.isFinite(value)
      )
    ) {
      throw new Error("Embedding provider returned an invalid vector.");
    }

    return {
      values,
      provider: "google",
      model: this.model,
      dimensions: this.dimensions,
      version: this.version,
    };
  }
}
