import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractDocument } from './extract';
import { extractInProcess } from './extraction-process';
import { DOCUMENT_FORMATS, DocumentError } from './formats';
import { docxFixture, xlsxFixture } from './fixtures.test-support';
import { DOCUMENT_TEXT, DOCUMENT_TRANSLATIONS, documentErrorMessage } from '../../i18n/knowledge-documents';

const linkedHeader = readFileSync(new URL('./fixtures/linked-header.docx', import.meta.url));
const malformedCell = readFileSync(new URL('./fixtures/malformed-cell.xlsx', import.meta.url));
const code = (expected: string) => (error: unknown) => error instanceof DocumentError && error.code === expected;

test('exact independently reproduced DOCX header fixture fails explicitly in the real child', async () => {
  await assert.rejects(extractInProcess(linkedHeader, 'linked-header.docx', DOCUMENT_FORMATS.docx.mime), code('document_header_footer'));
});
test('exact independently reproduced invalid XLSX coordinate fixture fails in the real child', async () => {
  await assert.rejects(extractInProcess(malformedCell, 'malformed-cell.xlsx', DOCUMENT_FORMATS.xlsx.mime), code('document_structure'));
});
function wordPart(kind: 'header' | 'footer', content: string, target = `${kind}1.xml`, relation = true) {
  const tag = kind === 'header' ? 'hdr' : 'ftr';
  return docxFixture(`<w:p><w:r><w:t>Body policy</w:t></w:r></w:p><w:sectPr><w:${kind}Reference w:type="default" r:id="part1"/></w:sectPr>`, {
    'word/_rels/document.xml.rels': `<Relationships>${relation ? `<Relationship Id="part1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>` : ''}</Relationships>`,
    [`word/${kind}1.xml`]: `<w:${tag} xmlns:w="urn:word">${content}</w:${tag}>`,
  });
}
for (const kind of ['header', 'footer'] as const) {
  for (const target of [`${kind}1.xml`, `/word/${kind}1.xml`, `../word/${kind}1.xml`]) test(`populated linked ${kind} rejects relative/absolute target ${target}`, async () => {
    await assert.rejects(extractDocument(wordPart(kind, '<w:p><w:r><w:t>Sunday policy</w:t></w:r></w:p>', target), 'docx'), code('document_header_footer'));
  });
  test(`blank linked ${kind} preserves body extraction`, async () => {
    assert.deepEqual(await extractDocument(wordPart(kind, '<w:p><w:r><w:t>  </w:t></w:r></w:p>'), 'docx'), [{ text: 'Body policy', section: 'Body' }]);
  });
  test(`linked ${kind} missing relationship fails closed`, async () => {
    await assert.rejects(extractDocument(wordPart(kind, '<w:p/>', undefined, false), 'docx'), code('document_structure'));
  });
  test(`linked ${kind} missing or escaping part fails closed`, async () => {
    for (const path of ['missing.xml','../outside.xml']) await assert.rejects(extractDocument(wordPart(kind, '<w:p/>', path), 'docx'), code('document_structure'));
  });
  for (const content of ['<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>', '<w:p><w:r><w:sym w:char="0041"/></w:r></w:p>', '<w:p><w:r><w:delText>Hidden policy</w:delText></w:r></w:p>', '<w:p><w:r><q:t xmlns:q="urn:word">Aliased policy</q:t></w:r></w:p>']) test(`linked ${kind} never hides fields/symbols/deleted/aliased text: ${content}`, async () => {
    await assert.rejects(extractDocument(wordPart(kind, content), 'docx'), code('document_header_footer'));
  });
}
test('body-only DOCX extraction and provenance remain unchanged', async () => {
  assert.deepEqual(await extractDocument(docxFixture(), 'docx'), [{ text: 'Cancellation & policy', section: 'Body' }]);
});
for (const reference of ['NOT_A_CELL','a1','$A$1','A0','A01','A-1','A1:B2','Sheet1!A1','A1 ','AAAA1','XFE1','A1048577','1A','']) test(`invalid XLSX reference ${JSON.stringify(reference)} is rejected`, async () => {
  await assert.rejects(extractDocument(xlsxFixture(`<c r="${reference}" t="inlineStr"><is><t>Policy</t></is></c>`), 'xlsx'), code('document_structure'));
});
test('row-mismatched explicit XLSX coordinates fail closed', async () => {
  await assert.rejects(extractDocument(xlsxFixture('<c r="A2" t="inlineStr"><is><t>Policy</t></is></c>'), 'xlsx'), code('document_structure'));
});
test('omitted optional XLSX coordinate retains existing row-label fallback', async () => {
  assert.deepEqual(await extractDocument(xlsxFixture('<c t="inlineStr"><is><t>Policy</t></is></c>'), 'xlsx'), [{ text:'1: Policy', sheet:'Policies' }]);
});
test('valid sparse cells and maximum worksheet coordinate preserve labels and sheet provenance', async () => {
  const sparse = await extractDocument(xlsxFixture('<c r="A1" t="inlineStr"><is><t>Policy</t></is></c><c r="C1"><v>24</v></c>'), 'xlsx');
  assert.deepEqual(sparse, [{ text:'A1: Policy | C1: 24', sheet:'Policies' }]);
  const edge = await extractDocument(xlsxFixture('', { 'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>Edge policy</t></is></c></row></sheetData></worksheet>' }), 'xlsx');
  assert.deepEqual(edge, [{ text:'XFD1048576: Edge policy', sheet:'Policies' }]);
});
test('header/footer processing failure has a specific message in all six locales', () => {
  const text = documentErrorMessage({ code:'document_header_footer' });
  assert.equal(text, DOCUMENT_TEXT[24]);assert.match(text,/headers and footers/u);
  for (const [locale, values] of Object.entries(DOCUMENT_TRANSLATIONS)) {
    assert.equal(values.length, DOCUMENT_TEXT.length, locale);assert.ok(values[24] && values[24] !== text, locale);
  }
});
