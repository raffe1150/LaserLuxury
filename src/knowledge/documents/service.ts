import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkKnowledgeContent, type KnowledgeSource } from '../../../knowledge';
import { DOCUMENT_LIMITS as L, DocumentError, displayFilename, rejectSensitiveText, validateDocument, type ExtractedSection } from './formats';
import { extractInProcess } from './extraction-process';

export const DOCUMENT_BUCKET = 'business-knowledge';
type DocumentRow = { source_id: string; business_id: number; object_key: string; filename: string; mime: string; format: string; bytes: number; sha256: string; lease_token: string; uploaded: boolean; attempts: number; deleted_at: string | null; error_code: string | null; created_at: string };
export function documentChunks(sections: ExtractedSection[], filename: string) {
  let content = ''; const segments: Record<string, unknown>[] = []; const chunks: Record<string, unknown>[] = [];
  for (const section of sections) {
    const { text, ...provenance } = section;
    const start = content.length; content += text + '\n\n';
    segments.push({ start, end: start + text.length, ...provenance });
    for (const chunk of chunkKnowledgeContent(text)) chunks.push({ chunk_index: chunks.length, content: chunk.content,
      metadata: { source: 'document', filename, untrusted: true, ...provenance } });
  }
  if (!chunks.length || chunks.length > 200 || content.trimEnd().length > L.chars) throw new DocumentError('document_limits');
  return { content: content.trimEnd(), chunks, metadata: { segments, extractorVersion: 1 } };
}
export class DocumentService {
  private active = false;
  constructor(private client: SupabaseClient | null, private extract = extractInProcess,
    private readonly indexing?: { recover(): Promise<unknown>; stop(): void }) {}
  recoverIndex() { return this.indexing?.recover() ?? Promise.resolve([]); }
  stopIndexing() { this.indexing?.stop(); }
  private db(): SupabaseClient {
    if (!this.client) throw new DocumentError('document_unavailable', 503);
    return this.client;
  }
  private async transition(businessId: number, id: string, action: string, payload: Record<string, unknown> = {}) {
    const { data, error } = await this.db().rpc('transition_knowledge_document', { p_business_id: businessId, p_id: id, p_action: action, ...payload });
    if (error) throw new DocumentError('document_unavailable', 503);
    return data;
  }
  async available() {
    const { data, error } = await this.db().storage.getBucket(DOCUMENT_BUCKET);
    if (error || !data || data.public || !data.file_size_limit || Number(data.file_size_limit) > L.bytes) throw new DocumentError('document_unavailable', 503);
  }
  async upload(businessId: number, userId: string, bytes: Buffer, filename: string, mime: string, attested: boolean) {
    if (!attested) throw new DocumentError('document_attestation', 400);
    filename = displayFilename(filename); rejectSensitiveText(filename);
    const format = validateDocument(bytes, filename, mime);
    await this.available();
    const id = randomUUID(); const objectKey = `${businessId}/${id}/original.${format}`;
    const { error } = await this.db().rpc('create_knowledge_document', { p_business_id: businessId, p_id: id, p_filename: filename,
      p_mime: mime, p_format: format, p_bytes: bytes.length, p_sha256: createHash('sha256').update(bytes).digest('hex'), p_user: userId });
    if (error) {
      if (error.message.includes('document_forbidden')) throw new DocumentError('document_forbidden', 403);
      throw new DocumentError(error.message.includes('document_quota') ? 'document_quota' : 'document_unavailable', error.message.includes('document_quota') ? 409 : 503);
    }
    try {
      const { error: storageError } = await this.db().storage.from(DOCUMENT_BUCKET).upload(objectKey, bytes, { contentType: mime, upsert: false });
      if (storageError) throw new DocumentError('document_storage', 503);
      const result = await this.transition(businessId, id, 'uploaded');
      if (!result) throw new DocumentError('document_deleted', 409);
    } catch (error) {
      // A tombstone exists before best-effort cleanup; recovery retries failures.
      await this.transition(businessId, id, 'upload_failed', { p_error: 'document_storage' });
      throw error;
    }
    return id;
  }
  async list(businessId: number): Promise<KnowledgeSource[]> {
    const { data, error } = await this.db().from('knowledge_sources')
      .select('id,business_id,type,title,status,created_at,updated_at,metadata').eq('business_id', businessId).eq('type', 'document').neq('status', 'deleted');
    if (error) throw new DocumentError('document_unavailable', 503);
    const { data: documents, error: metadataError } = await this.db().from('knowledge_documents').select('source_id,business_id,error_code,attempts,uploaded').eq('business_id', businessId).is('deleted_at', null);
    if (metadataError) throw new DocumentError('document_unavailable', 503);
    return (data || []).filter((s) => s.business_id === businessId).map((s) => {
      const d = documents?.find((row) => row.source_id === s.id && row.business_id === businessId);
      return { id: s.id, businessId, type: 'document', title: s.title, status: s.status, content: '', createdAt: s.created_at, updatedAt: s.updated_at,
        metadata: { filename: s.metadata?.filename, format: s.metadata?.format, bytes: s.metadata?.bytes, errorCode: d?.error_code, attempts: d?.attempts, retryable: d?.uploaded && d.attempts < 3 } };
    });
  }
  async retry(businessId: number, id: string) {
    const result = await this.transition(businessId, id, 'retry');
    if (!result) throw new DocumentError('document_retry', 409);
  }
  async delete(businessId: number, id: string) {
    const result = await this.transition(businessId, id, 'delete');
    if (!result) throw new DocumentError('document_not_found', 404);
    // Retrieval exclusion is already committed. Physical cleanup has a grace period.
  }
  async process(businessId: number, id: string): Promise<void> {
    if (this.active) return; // Bounded local concurrency; other instances are fenced by DB leases.
    this.active = true;
    let row: DocumentRow | null = null;
    try {
      await this.available();
      row = await this.transition(businessId, id, 'claim');
      if (!row) return;
      if (Number(row.business_id) !== businessId || row.source_id !== id || row.object_key !== `${businessId}/${id}/original.${row.format}`) throw new DocumentError('document_scope');
      const { data, error } = await this.db().storage.from(DOCUMENT_BUCKET).download(row.object_key);
      if (error || !data) throw new DocumentError('document_storage', 503);
      if (data.size !== row.bytes || data.size > L.bytes) throw new DocumentError('document_content');
      const bytes = Buffer.from(await data.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new DocumentError('document_content');
      const sections = await this.extract(bytes, row.filename, row.mime);
      const extracted = documentChunks(sections, row.filename);
      await this.transition(businessId, id, 'finish', { p_token: row.lease_token, p_content: extracted.content, p_chunks: extracted.chunks, p_metadata: extracted.metadata });
    } catch (error) {
      if (row) {
        const code = error instanceof DocumentError ? error.code : 'document_parse';
        // Sensitive rejection and cleanup are one fenced database transaction.
        await this.transition(businessId, id, 'fail', { p_token: row.lease_token, p_error: code });
      } else throw error;
    } finally { this.active = false; }
  }
  async recover() {
    // No content/customer data logging. An unavailable database/storage leaves work durable.
    await this.available();
    const { data, error } = await this.db().from('knowledge_documents').select('*,knowledge_sources!inner(status)').is('deleted_at', null).in('knowledge_sources.status', ['pending','processing']).order('created_at').limit(50);
    if (error) throw new DocumentError('document_unavailable', 503);
    for (const row of data || []) {
      if (!row.uploaded && Date.parse(row.created_at) < Date.now() - L.leaseSeconds * 1000) {
        // The batch is only a hint: SQL rechecks upload completion/status/age.
        await this.transition(row.business_id, row.source_id, 'abandon_upload', { p_error: 'document_storage' });
      } else if (row.uploaded && !row.error_code) await this.process(row.business_id, row.source_id);
    }
    const { data: cleanup, error: cleanupError } = await this.db().from('knowledge_document_cleanup').select('object_key')
      .lt('created_at', new Date(Date.now() - L.leaseSeconds * 1000).toISOString()).limit(50);
    if (cleanupError) throw new DocumentError('document_unavailable', 503);
    for (const item of cleanup || []) {
      const { error: removeError } = await this.db().storage.from(DOCUMENT_BUCKET).remove([item.object_key]);
      if (!removeError) {
        const { error: ackError } = await this.db().from('knowledge_document_cleanup').delete().eq('object_key', item.object_key);
        if (ackError) throw new DocumentError('document_unavailable', 503);
      }
    }
  }
}
