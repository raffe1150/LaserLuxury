import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const underName = boundary.resolveBookingContactPhrase({
  text: "Can you book it under Alex Testsson with the phone number 0701234567?",
});
assert.equal(underName.name, "Alex Testsson");
assert.equal(underName.phone, "0701234567");
assert.deepEqual(underName.missing, []);

const confirmationWithContact = boundary.resolveBookingContactPhrase({
  text: "Yes, please book it for Alex Testsson at 16:00 on Monday 24 August with the phone number 0701234567.",
});
assert.equal(confirmationWithContact.name, "Alex Testsson");
assert.equal(confirmationWithContact.phone, "0701234567");
assert.deepEqual(confirmationWithContact.missing, []);

const laterConfirmation = boundary.resolveBookingContactPhrase({
  text: "Yes, please book it.",
  storedName: confirmationWithContact.name,
  storedPhone: confirmationWithContact.phone,
  storedPhoneSource: "explicit_customer_message",
});
assert.equal(laterConfirmation.name, "Alex Testsson");
assert.equal(laterConfirmation.phone, "0701234567");
assert.deepEqual(laterConfirmation.missing, []);

console.log("English booking contact phrase regression tests passed");
