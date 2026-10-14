import { deflateRawSync } from 'node:zlib';
export function zipFixture(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path); const data = Buffer.isBuffer(value) ? value : Buffer.from(value); const compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    locals.push(local, name, compressed);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(8,10);
    c.writeUInt32LE(crc,16); c.writeUInt32LE(compressed.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28); c.writeUInt32LE(offset,42);
    central.push(c,name); offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,end]);
}
const contentType = (part: string, type: string) => `<Types><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/></Types>`;
export const docxFixture = (body = '<w:p><w:r><w:t>Cancellation &amp; policy</w:t></w:r></w:p>', extra: Record<string,string|Buffer> = {}) => zipFixture({
  '[Content_Types].xml': contentType('word/document.xml','wordprocessingml.document.main+xml'),
  'word/document.xml': `<w:document xmlns:w="urn:word"><w:body>${body}</w:body></w:document>`, ...extra,
});
export const xlsxFixture = (cells = '<c r="A1" t="inlineStr"><is><t>Policy</t></is></c><c r="B1"><v>24</v></c>', extra: Record<string,string|Buffer> = {}) => zipFixture({
  '[Content_Types].xml': contentType('xl/workbook.xml','spreadsheetml.sheet.main+xml'),
  'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Policies" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`, ...extra,
});
export function pdfFixture(text = 'Cancellation policy', pages = 1): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let page = 0; page < pages; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+page*2} 0 R >>`);
    const stream = `BT /F1 12 Tf 10 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let document = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((obj,i)=>{ offsets.push(Buffer.byteLength(document));document+=`${i+1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(document); document+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document+=offsets.slice(1).map((off)=>`${String(off).padStart(10,'0')} 00000 n \n`).join('');
  document+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
}
