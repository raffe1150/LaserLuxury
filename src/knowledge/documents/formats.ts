export const DOCUMENT_LIMITS = {
  bytes: 5 * 1024 * 1024, chars: 100_000, pages: 100, expandedBytes: 20 * 1024 * 1024,
  entryBytes: 5 * 1024 * 1024, entries: 1000, sheets: 20, cells: 20_000, rows: 10_000,
  timeoutMs: 20_000, memoryMb: 512, heapMb: 256, leaseSeconds: 120,
} as const;
export const DOCUMENT_FORMATS = {
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'zip' },
  txt: { mime: 'text/plain', kind: 'text' },
  csv: { mime: 'text/csv', kind: 'text' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'zip' },
} as const;
export type DocumentFormat = keyof typeof DOCUMENT_FORMATS;
export type ExtractedSection = { text: string; page?: number; sheet?: string; section?: string };
export class DocumentError extends Error {
  constructor(public code: string, public status = 422) { super(code); }
}
export function validateDocument(bytes: Buffer, filename: string, mime: string): DocumentFormat {
  if (!bytes.length || bytes.length > DOCUMENT_LIMITS.bytes) throw new DocumentError('document_size', 413);
  const extension = filename.split('.').pop()?.toLowerCase() as DocumentFormat;
  if (!Object.hasOwn(DOCUMENT_FORMATS, extension)) throw new DocumentError('document_format');
  if (mime.toLowerCase() !== DOCUMENT_FORMATS[extension].mime) throw new DocumentError('document_mime');
  const kind = DOCUMENT_FORMATS[extension].kind;
  if (kind === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new DocumentError('document_content');
  if (kind === 'zip' && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new DocumentError('document_content');
  if (kind === 'text') decodeText(bytes);
  return extension;
}
export function decodeText(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new DocumentError('document_encoding'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text) || /^\s*(?:%PDF-|PK\x03\x04|<\?xml|<!doctype|<html|<script|\{\s*")/iu.test(text)) throw new DocumentError('document_content');
  return text;
}
export function displayFilename(value: string): string {
  const name = value.normalize('NFC').replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/gu, '_').trim();
  if (!name || name.length > 200) throw new DocumentError('document_filename', 400);
  return name;
}
// Conservative gate; attestation is also mandatory. This is not a medical-record classifier.
export function rejectSensitiveText(text: string): void {
  if (/(?:patient\s*(?:record|name|id|number)|medical\s*record|diagnos(?:is|es)|patientjournal|personnummer|krankenakte|patientenakte|historia\s*cl[ií]nica|diagn[oó]stico|پرونده\s*پزشکی|تشخیص|سجل\s*طبي|تشخيص)/iu.test(text)) {
    throw new DocumentError('document_sensitive');
  }
}
