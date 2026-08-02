import assert from 'node:assert/strict';
import { isInvalidCustomerNameToken, resolveAuthoritativeContact } from './channel-contact';

for (const token of ['Bale', 'بله', 'Yes', 'Yeah', 'Ja', 'Ja tack', 'OK', 'Okay', 'Merci', 'Thanks']) {
  assert.equal(isInvalidCustomerNameToken(token), true, `${token} cannot be a customer name`);
}
for (const name of ['Sara', 'Nina Andersson', 'سارا', 'Shirin']) assert.equal(isInvalidCustomerNameToken(name), false);

const telegramPhoneOnly = resolveAuthoritativeContact({ channel: 'telegram', currentName: 'Bale', currentPhone: '07394660356' });
assert.deepEqual(telegramPhoneOnly.missing, ['name']);
assert.equal(telegramPhoneOnly.name, null);
assert.equal(telegramPhoneOnly.phone, '07394660356');

const telegramCombined = resolveAuthoritativeContact({ channel: 'telegram', currentName: 'Sara', currentPhone: '07394660356' });
assert.deepEqual(telegramCombined.missing, []);
const telegramNameThenPhone = resolveAuthoritativeContact({
  channel: 'telegram', storedName: 'Sara', currentPhone: '07394660356', storedPhoneSource: 'missing',
});
assert.deepEqual(telegramNameThenPhone.missing, []);
const telegramPhoneThenName = resolveAuthoritativeContact({
  channel: 'telegram', currentName: 'Sara', storedPhone: '07394660356', storedPhoneSource: 'explicit_customer_message',
});
assert.deepEqual(telegramPhoneThenName.missing, []);

const whatsappMissingName = resolveAuthoritativeContact({ channel: 'whatsapp', senderPhone: '+46701234567' });
assert.deepEqual(whatsappMissingName.missing, ['name']);
assert.equal(whatsappMissingName.phoneSource, 'verified_sender_metadata');
const whatsappComplete = resolveAuthoritativeContact({
  channel: 'whatsapp', senderPhone: '+46701234567', currentName: 'Sara', currentPhone: '999999999',
});
assert.deepEqual(whatsappComplete.missing, []);
assert.equal(whatsappComplete.phone, '+46701234567', 'message numbers cannot overwrite WhatsApp sender metadata');
const whatsappNoMetadata = resolveAuthoritativeContact({ channel: 'whatsapp', currentName: 'Sara' });
assert.deepEqual(whatsappNoMetadata.missing, ['phone']);

for (const channel of ['instagram', 'messenger'] as const) {
  const contact = resolveAuthoritativeContact({ channel, currentName: 'Sara', currentPhone: '07394660356' });
  assert.deepEqual(contact.missing, []);
  assert.equal(contact.phoneSource, 'explicit_customer_message');
}

console.log('channel contact policy tests passed');
