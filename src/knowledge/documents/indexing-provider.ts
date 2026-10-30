import {denyTrialAction} from '../../runtime/controlled-knowledge-trial';
import { isDeepStrictEqual } from 'node:util';
import { GoogleEmbeddingProvider, type EmbeddingProvider } from '../../ai/embeddings';
import { embedWithOpenAi } from '../../ai/providers/openai';
import { KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY, OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,
  type KnowledgeBackfillEmbeddingIdentity } from '../embedding-backfill';

/** Explicit binding; no AI_PROVIDER lookup, fallback, key read, or network at construction. */
export function createSourceIndexProvider(identity: KnowledgeBackfillEmbeddingIdentity,
  googleApiKeyProvider: () => string | undefined): Pick<EmbeddingProvider, 'embedDocuments'> {
  if (isDeepStrictEqual(identity, OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY)) return { embedDocuments: embedWithOpenAi };
  if (isDeepStrictEqual(identity, KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY)) {denyTrialAction();return new GoogleEmbeddingProvider({
    apiKeyProvider: googleApiKeyProvider, model: identity.model, dimensions: identity.dimensions, version: identity.version,
  });}
  throw new Error('knowledge_index_invalid_identity');
}
