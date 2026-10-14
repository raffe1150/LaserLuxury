import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parse } from 'csv-parse/sync';
import { DOCUMENT_LIMITS as L, DocumentError, decodeText, rejectSensitiveText, type DocumentFormat, type ExtractedSection } from './formats';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(new DocumentError('document_archive'));
      const files = new Map<string, Buffer>(); let total = 0; let count = 0;
      const fail = () => { zip.close(); reject(new DocumentError('document_archive')); };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (++count > L.entries || entry.generalPurposeBitFlag & 1 || entry.uncompressedSize > L.entryBytes ||
          (total += entry.uncompressedSize) > L.expandedBytes || files.has(entry.fileName) ||
          /(?:vbaProject|activeX|embeddings|\/media\/|\/charts\/)\b/iu.test(entry.fileName)) return fail();
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail();
          const parts: Buffer[] = []; let actual = 0; let crc = 0xffffffff;
          stream.on('error', fail);
          stream.on('data', (part: Buffer) => {
            actual += part.length;
            for (const byte of part) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
            if (actual > entry.uncompressedSize || actual > L.entryBytes) { stream.destroy(); fail(); }
            else parts.push(part);
          });
          stream.on('end', () => {
            if (actual !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) return fail();
            files.set(entry.fileName, Buffer.concat(parts)); zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files)); zip.readEntry();
    });
  });
}
function xml(files: Map<string, Buffer>, path: string, ordered = false): any {
  const data = files.get(path);
  if (!data) throw new DocumentError('document_structure');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(text) || XMLValidator.validate(text) !== true) throw new DocumentError('document_structure');
  // Decode only XML's predefined/numeric entities. DTDs and custom entities are never evaluated.
  return new XMLParser({ ignoreAttributes: false, preserveOrder: ordered, processEntities: false, parseTagValue: false, parseAttributeValue: false }).parse(text);
}
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function textOf(value: any): string {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'object' ? textOf(value['#text']) : String(value);
  return raw.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const number = entity.startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}
function wordText(nodes: any[]): string {
  let text = '';
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === 'w:t') text += array(value).map((v) => textOf(v['#text'])).join('');
    else if (key === 'w:tab') text += '\t';
    else if (key === 'w:br') text += '\n';
    else if (Array.isArray(value)) text += wordText(value) + (key === 'w:p' || key === 'w:tr' ? '\n' : '');
  }
  return text;
}
async function office(bytes: Buffer, format: 'docx' | 'xlsx'): Promise<ExtractedSection[]> {
  const files = await unzip(bytes);
  const types = xml(files, '[Content_Types].xml');
  const expected = format === 'docx' ? 'wordprocessingml.document.main+xml' : 'spreadsheetml.sheet.main+xml';
  if (!array(types.Types?.Override).some((v) => v['@_PartName'] === (format === 'docx' ? '/word/document.xml' : '/xl/workbook.xml') && v['@_ContentType'] === 'application/vnd.openxmlformats-officedocument.' + expected)) throw new DocumentError('document_structure');
  // Reject links/OLE/macro content even though extraction never resolves external resources.
  for (const path of files.keys()) if (path.endsWith('.rels')) {
    const relationships = array(xml(files, path).Relationships?.Relationship);
    if (relationships.some((r) => r['@_TargetMode'] === 'External' || /oleObject|vbaProject/iu.test(String(r['@_Type'])))) throw new DocumentError('document_external');
  }
  if (format === 'docx') {
    if (/<w:(?:altChunk|object|drawing|fldSimple|fldChar|instrText|del|ins)\b/u.test(files.get('word/document.xml')?.toString('utf8') || '')) throw new DocumentError('document_structure');
    const body = xml(files, 'word/document.xml', true);
    if (!body.some((v: any) => v['w:document'])) throw new DocumentError('document_structure');
    return [{ text: wordText(body), section: 'Body' }];
  }
  const workbook = xml(files, 'xl/workbook.xml');
  const relationships = array(xml(files, 'xl/_rels/workbook.xml.rels').Relationships?.Relationship);
  const sheets = array(workbook.workbook?.sheets?.sheet);
  if (!sheets.length || sheets.length > L.sheets) throw new DocumentError('document_limits');
  const shared = files.has('xl/sharedStrings.xml') ? array(xml(files, 'xl/sharedStrings.xml').sst?.si).map((si) =>
    textOf(si.t) || array(si.r).map((r) => textOf(r.t)).join('')) : [];
  let cells = 0; let rows = 0;
  return sheets.map((sheet) => {
    if (sheet['@_state'] && sheet['@_state'] !== 'visible') throw new DocumentError('document_spreadsheet');
    const relation = relationships.find((r) => r['@_Id'] === sheet['@_r:id']);
    const target = String(relation?.['@_Target'] || '');
    const path = target.startsWith('/xl/') ? target.slice(1) : `xl/${target}`;
    if (!/^xl\/worksheets\/[^/]+\.xml$/u.test(path)) throw new DocumentError('document_structure');
    const data = xml(files, path).worksheet;
    if (array(data?.cols?.col).some((c) => c['@_hidden'] === '1' || c['@_hidden'] === 'true')) throw new DocumentError('document_spreadsheet');
    if (!data?.sheetData) throw new DocumentError('document_structure');
    const output = array(data.sheetData.row).map((row) => {
      if (++rows > L.rows || row['@_hidden'] === '1' || row['@_hidden'] === 'true') throw new DocumentError('document_spreadsheet');
      const number = String(row['@_r'] || rows);
      return array(row.c).map((cell) => {
        if (++cells > L.cells) throw new DocumentError('document_limits');
        // No formula evaluation or cached formula claims, dates/styles/charts are not inferred.
        if (cell.f !== undefined || (cell['@_t'] && !['n','s','str','inlineStr','b'].includes(cell['@_t']))) throw new DocumentError('document_spreadsheet');
        let value = textOf(cell.v);
        if (cell['@_t'] === 's') {
          if (!/^\d+$/u.test(value) || shared[Number(value)] === undefined) throw new DocumentError('document_structure');
          value = shared[Number(value)];
        } else if (cell['@_t'] === 'inlineStr') value = textOf(cell.is?.t) || array(cell.is?.r).map((r) => textOf(r.t)).join('');
        else if (cell['@_t'] === 'b') { if (!['0','1'].includes(value)) throw new DocumentError('document_structure'); value = value === '1' ? 'true' : 'false'; }
        else {
          if (cell['@_s'] && !['str'].includes(cell['@_t'])) throw new DocumentError('document_spreadsheet');
          if ((!cell['@_t'] || cell['@_t'] === 'n') && value && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) throw new DocumentError('document_structure');
        }
        return `${String(cell['@_r'] || number)}: ${value}`;
      }).join(' | ');
    }).join('\n');
    return { text: output, sheet: textOf(sheet['@_name']) };
  });
}
async function pdf(bytes: Buffer): Promise<ExtractedSection[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useWasm: false, useSystemFonts: false, disableFontFace: true,
    disableAutoFetch: true, disableStream: true, disableRange: true, stopAtErrors: true, enableXfa: false, verbosity: 0 });
  try {
    const document = await task.promise;
    if (await document.getPermissions() !== null) throw new DocumentError('document_external');
    if (document.numPages > L.pages) throw new DocumentError('document_limits');
    if (await document.getAttachments() || await document.getJSActions()) throw new DocumentError('document_external');
    const sections: ExtractedSection[] = []; let chars = 0;
    for (let page = 1; page <= document.numPages; page++) {
      const current = await document.getPage(page);
      if (await current.getJSActions()) throw new DocumentError('document_external');
      const content = await current.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (!text.trim()) throw new DocumentError('document_no_text');
      if ((chars += text.length) > L.chars) throw new DocumentError('document_limits');
      sections.push({ text, page }); current.cleanup();
    }
    return sections;
  } finally { await task.destroy(); }
}
async function csv(bytes: Buffer): Promise<ExtractedSection[]> {
  const records: string[][] = parse(decodeText(bytes), { bom: true, skip_empty_lines: true, max_record_size: 100_000 });
  if (records.length > L.rows || records.reduce((n, row) => n + row.length, 0) > L.cells) throw new DocumentError('document_limits');
  if (records.some((row) => row.some((cell) => /^\s*(?:[=+@]|-(?!\d))/u.test(cell)))) throw new DocumentError('document_spreadsheet');
  return [{ text: records.map((row, i) => `Row ${i + 1}: ${row.map((cell, j) => `Column ${j + 1}: ${JSON.stringify(cell)}`).join(' | ')}`).join('\n'), section: 'Rows' }];
}
// Every format admitted by validation must have an explicit extractor. New entries
// require a handler and independent feasibility/security tests before UI exposure.
export const DOCUMENT_EXTRACTORS: Record<DocumentFormat, (bytes: Buffer) => Promise<ExtractedSection[]>> = {
  pdf, docx: (bytes) => office(bytes, 'docx'), xlsx: (bytes) => office(bytes, 'xlsx'), csv,
  txt: async (bytes) => [{ text: decodeText(bytes), section: 'Text' }],
};
export async function extractDocument(bytes: Buffer, format: DocumentFormat): Promise<ExtractedSection[]> {
  let sections = await DOCUMENT_EXTRACTORS[format](bytes);
  sections = sections.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
  const all = sections.map((s) => s.text).join('\n\n');
  if (!all) throw new DocumentError('document_no_text');
  if (all.length > L.chars) throw new DocumentError('document_limits');
  rejectSensitiveText(all);
  return sections;
}
