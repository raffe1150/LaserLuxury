import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { ConfiguredEmbeddingProvider } from '../../src/ai/providers/embeddings';
import { extractInProcess } from '../../src/knowledge/documents/extraction-process';
import { documentChunks } from '../../src/knowledge/documents/service';

export const incidentQuestions = {
  A: 'Where is the Nordpark parking garage located, and how far is it from the studio?',
  B: 'Can I bring someone with me to the studio, and can they join me in the treatment room?',
  C: 'Is parking free, and can the studio reserve a parking space for me?',
} as const;
export type IncidentQuestion = keyof typeof incidentQuestions;
export const incidentChannels = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
export type IncidentChannel = typeof incidentChannels[number];
export const incidentConfig = { id: 77, businessId: 77, businessName: 'AdMotion Studio', language: 'sv', timezone: 'Europe/Stockholm',
  services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 60 }], defaultBookingService: 'Video Consultation', calendarProvider: 'custom',
  address: 'Studio Street 99', channelConnectionId: 'synthetic-connection', telegramToken: '123456:synthetic-offline', telegramBusinessResolved: true,
  whatsappPhoneNumberId: '10001', whatsappAccessToken: 'synthetic-only', instagramAccountId: '30001', instagramAccessToken: 'synthetic-only',
  messengerPageId: '40001', messengerPageAccessToken: 'synthetic-only', toneConfig: { tonePreset: 'warm' },
  workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(d => [d, [{ start: '09:00', end: '17:00' }]])) };

export function incidentFlags() {
  Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-5.6-luna',
    ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true', ODINLINK_GROUNDED_NATURAL_RESPONSES: 'false',
    ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false', ODINLINK_ASYNC_KNOWLEDGE_PROCESSING: 'false', ODINLINK_ASYNC_KNOWLEDGE_DELIVERY: 'false',
    ODINLINK_SMART_WAITING: 'false' });
}
export async function incidentCorpus(realEmbeddings = false, businessId = 77) {
  const bytes = readFileSync(new URL('../fixtures/admotion-studio-parking.pdf', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f15ba3a6a1428745edeedd6647fd7d6b61daf139d99311f304e38a2f1a340e9d');
  const extracted = documentChunks(await extractInProcess(bytes, 'admotion studio1.pdf', 'application/pdf'), 'admotion studio1.pdf');
  assert.equal(extracted.chunks.length, 5);
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage, storage, realEmbeddings ? new ConfiguredEmbeddingProvider(() => undefined) : null);
  const source = { id: 'incident-pdf', businessId, type: 'document' as const, title: 'admotion studio1.pdf', status: 'ready' as const,
    content: extracted.content, metadata: extracted.metadata, createdAt: '2026', updatedAt: '2026' };
  await storage.create(source);
  await storage.replaceChunks(businessId, source.id, extracted.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as any })));
  // Complete competing parking/contact policy from the incident; unrelated
  // secret-test-code content is excluded from this synthetic tenant fixture.
  const text = `OdinLink testinformation
# Kundinformation – AdMotion Studio
## Adress och besök
AdMotion Studio tar emot kunder efter överenskommelse. Besöksadressen meddelas i samband med bokningsbekräftelsen.
## Parkering
Det finns möjlighet till parkering i närheten. Kontakta oss gärna i förväg om du behöver information om parkeringsalternativ.
## Kontakt
Kunder kan kontakta oss via våra digitala meddelandekanaler. Telefonnummer lämnas vid behov av företaget.
## Bokning
Tidsbokning sker i förväg. Kunder kan fråga om lediga tider och boka en tjänst via vår digitala assistent.
## Inför besöket
Kom gärna fem minuter före din bokade tid. Om du behöver ändra tiden, kontakta oss så snart som möjligt.
## Digitala möten
Vissa tjänster kan genomföras digitalt. Mötesinformation skickas efter att bokningen har bekräftats.
## Vanliga frågor
Kan jag komma utan bokning? Vi rekommenderar att du bokar tid i förväg.
Kan jag boka ett digitalt möte? Ja, vissa tjänster erbjuds digitalt.
Hur får jag information om parkering? Kontakta oss före besöket så hjälper vi dig med tillgänglig information.`;
  await storage.create({ ...source, id: 'incident-txt', title: 'odinlink-test.txt', content: text,
    metadata: { segments: [{ start: 0, end: text.length, section: 'Text' }] } });
  await storage.replaceChunks(businessId, 'incident-txt', [{ chunkIndex: 0, content: text, metadata: { source: 'document', section: 'Text' } }]);
  return { storage, service, source, chunkCount: 6 };
}

let serial = 0;
export function incidentSession(b: any, channel: IncidentChannel, recipient: string) {
  return channel === 'telegram' ? `tg:77:${createHash('sha256').update(incidentConfig.telegramToken).digest('hex').slice(0, 12)}:${recipient}` :
    b.channelSessionId(channel, recipient, incidentConfig, channel === 'whatsapp' ? '10001' : channel === 'instagram' ? '30001' : '40001');
}
export async function incidentInbound(b: any, channel: IncidentChannel, text: string, recipient = '46700000001') {
  const now = Date.now(), eventId = String(++serial);
  if (channel === 'telegram') return b.telegramInbound({ update_id: eventId, message: { chat: { id: recipient }, text, date: Math.floor(now / 1000) } }, incidentConfig);
  if (channel === 'whatsapp') return b.whatsappInbound({ id: eventId, from: recipient, text: { body: text }, type: 'text', timestamp: String(Math.floor(now / 1000)) }, { phone_number_id: '10001' }, incidentConfig);
  const event = { sender: { id: recipient }, recipient: { id: channel === 'instagram' ? '30001' : '40001' }, timestamp: now, message: { mid: eventId, text } };
  return channel === 'instagram' ? b.instagramInbound(event, incidentConfig) : b.messengerInbound(event, incidentConfig);
}
export function interceptedIncidentSend(input: string | URL | Request, options: RequestInit | undefined): string {
  const url = new URL(String(input));
  assert.ok(['api.telegram.org', 'graph.facebook.com', 'graph.instagram.com'].includes(url.hostname), 'Non-OpenAI network is forbidden');
  assert.equal(options?.method, 'POST');
  const body = JSON.parse(String(options?.body));
  assert.equal(String(body.chat_id || body.to || body.recipient?.id), '46700000001');
  if (url.hostname === 'api.telegram.org') assert.ok(url.pathname.startsWith('/bot123456:synthetic-offline/'));
  return body.text?.body || body.message?.text || body.text;
}
export function assertIncidentAnswer(key: IncidentQuestion, reply: string) {
  assert.doesNotMatch(reply, /cannot verify|cannot confirm|referring to|name what|technical problem|\bpå\b/u);
  if (key === 'A') { assert.match(reply, /Stjärngatan\s+14/u); assert.match(reply, /(?:five|5)[ -]minute/iu); }
  if (key === 'B') { assert.match(reply, /(?:one|1|an)\s+(?:accompanying\s+)?adult/iu); assert.match(reply, /reception|waiting/iu); assert.match(reply, /approv|permission/iu); assert.match(reply, /staff/iu); }
  if (key === 'C') { assert.match(reply, /(?:not|n't|no)[^.!\n]{0,35}free parking|free parking[^.!\n]{0,20}(?:not|n't)/iu); assert.match(reply, /(?:cannot|can't|does not|doesn't|not)[^.!\n]{0,35}reserv/iu); }
}
