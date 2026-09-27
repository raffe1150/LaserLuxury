import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { GoogleEmbeddingProvider } from "../src/ai/embeddings";
import {
  KnowledgeEmbeddingBackfillError,
  SupabaseKnowledgeEmbeddingBackfillRepository,
  runKnowledgeEmbeddingBackfill,
} from "../src/knowledge/embedding-backfill";

type ParsedArguments = {
  businessId: number;
  sourceId: string;
  write: boolean;
};

function argumentValue(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsValue = args.find((argument) =>
    argument.startsWith(equalsPrefix)
  );
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArguments(args: string[]): ParsedArguments {
  const businessId = Number(argumentValue(args, "--business-id"));
  const sourceId = String(argumentValue(args, "--source-id") || "").trim();
  const write = args.includes("--write");

  if (!Number.isSafeInteger(businessId) || businessId <= 0) {
    throw new KnowledgeEmbeddingBackfillError("business_id_required");
  }

  if (!sourceId) {
    throw new KnowledgeEmbeddingBackfillError("source_id_required");
  }

  return { businessId, sourceId, write };
}

function configuredGeminiKeys(): string[] {
  const keys = [
    process.env.GEMINI_API_KEY,
    ...(process.env.GEMINI_API_KEYS || "").split(","),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return Array.from(new Set(keys));
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  ).trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new KnowledgeEmbeddingBackfillError(
      "supabase_service_configuration_required",
    );
  }

  const keys = configuredGeminiKeys();
  if (parsed.write && keys.length === 0) {
    throw new KnowledgeEmbeddingBackfillError(
      "gemini_api_key_required_for_write",
    );
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const repository =
    new SupabaseKnowledgeEmbeddingBackfillRepository(client);
  const embeddingProvider = parsed.write
    ? new GoogleEmbeddingProvider({
        apiKeyProvider: () => keys[0],
      })
    : undefined;

  const summary = await runKnowledgeEmbeddingBackfill({
    ...parsed,
    repository,
    embeddingProvider,
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const code =
    error instanceof KnowledgeEmbeddingBackfillError
      ? error.code
      : "knowledge_embedding_backfill_failed";

  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
});
