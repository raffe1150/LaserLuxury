import { extractDocument } from './extract';
import { DocumentError, validateDocument } from './formats';
// This process receives no Supabase/provider credentials and has no file/network extraction inputs.
globalThis.fetch = async () => { throw new Error('External resources disabled'); };
process.once('message', async (message: { bytes: string; filename: string; mime: string }) => {
  try {
    const bytes = Buffer.from(message.bytes, 'base64');
    const format = validateDocument(bytes, message.filename, message.mime);
    const sections = await extractDocument(bytes, format);
    process.send?.({ sections }, () => process.exit(0));
  } catch (error) {
    process.send?.({ error: error instanceof DocumentError ? error.code : 'document_parse' }, () => process.exit(0));
  }
});
