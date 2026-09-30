import { GoogleEmbeddingProvider, type EmbeddingProvider, type EmbeddingVector } from "../embeddings";
import { getConfiguredAiProvider } from "./provider";
import { embedWithConfiguredProvider } from "./router";

/** Uses the same provider selection as conversation generation, never cross-provider fallback. */
export class ConfiguredEmbeddingProvider implements EmbeddingProvider {
  private readonly gemini: GoogleEmbeddingProvider;
  constructor(apiKeyProvider: () => string | undefined) {
    this.gemini = new GoogleEmbeddingProvider({ apiKeyProvider });
  }
  get supportsLocalSemanticSearch(): boolean {
    return getConfiguredAiProvider() === "openai";
  }
  embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    return embedWithConfiguredProvider(texts, this.gemini);
  }
  async embedQuery(text: string): Promise<EmbeddingVector> {
    // Preserve Gemini's original query request shape.
    if (getConfiguredAiProvider() === "gemini") return this.gemini.embedQuery(text);
    return (await this.embedDocuments([text]))[0];
  }
}
