import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOKING_PRESENTATION_LANGUAGES,
  containsEmoji,
  renderDeterministicAvailabilityReply,
  renderDeterministicBookingConfirmation,
  renderDeterministicMissingDetailsReply,
} from './deterministic-booking-presentation';
import {
  EMOJI_USAGES,
  FORMALITY_LEVELS,
  RESPONSE_LENGTHS,
  TONE_PRESETS,
  type BusinessToneConfig,
} from './tone-controls';

const warmDetailed: BusinessToneConfig = {
  tonePreset: 'warm',
  responseLength: 'detailed',
  formality: 'casual',
  emojiUsage: 'expressive',
  customToneInstructions: '',
};

const professionalFormal: BusinessToneConfig = {
  tonePreset: 'professional',
  responseLength: 'balanced',
  formality: 'formal',
  emojiUsage: 'none',
  customToneInstructions: '',
};

describe('deterministic booking-tone presentation', () => {
  it('styles identical availability facts differently without changing slots', () => {
    const facts = { kind: 'found' as const, slots: 'Wednesday 26 August at 13:15, 14:45 and 15:00' };
    const a = renderDeterministicAvailabilityReply('en', facts, warmDetailed);
    const b = renderDeterministicAvailabilityReply('en', facts, professionalFormal);

    assert.notEqual(a, b);
    assert.equal(containsEmoji(b), false);
    assert.equal(containsEmoji(a), true);
    for (const fact of ['Wednesday 26 August', '13:15', '14:45', '15:00']) {
      assert.equal(a.includes(fact), true);
      assert.equal(b.includes(fact), true);
    }
  });

  it('styles identical missing-detail requirements without changing required fields', () => {
    const missing = ['name', 'phone'] as Array<'name' | 'phone' | 'service'>;
    const a = renderDeterministicMissingDetailsReply('en', missing, warmDetailed);
    const b = renderDeterministicMissingDetailsReply('en', missing, professionalFormal);

    assert.notEqual(a, b);
    assert.equal(containsEmoji(b), false);
    for (const field of ['name', 'mobile number']) {
      assert.equal(a.includes(field), true);
      assert.equal(b.includes(field), true);
    }
    assert.deepEqual(missing, ['name', 'phone']);
  });

  it('styles identical verified confirmation facts without changing booking facts', () => {
    const facts = {
      name: 'Rihanna',
      service: 'consultation',
      date: 'Wednesday 26 August',
      time: '15:00',
    };
    const before = structuredClone(facts);
    const a = renderDeterministicBookingConfirmation('en', facts, warmDetailed);
    const b = renderDeterministicBookingConfirmation('en', facts, professionalFormal);

    assert.notEqual(a, b);
    assert.equal(containsEmoji(b), false);
    for (const fact of Object.values(facts)) {
      assert.equal(a.includes(fact), true);
      assert.equal(b.includes(fact), true);
    }
    assert.deepEqual(facts, before);
  });

  it('enforces none, light, and expressive emoji limits deterministically', () => {
    const facts = { name: 'Rihanna 😊', service: 'consultation', date: 'Wednesday 26 August', time: '15:00' };
    const emojiCount = (value: string) => value.match(/\p{Extended_Pictographic}/gu)?.length || 0;

    for (const emojiUsage of EMOJI_USAGES) {
      const rendered = renderDeterministicBookingConfirmation('en', facts, {
        ...professionalFormal,
        emojiUsage,
      });
      if (emojiUsage === 'none') assert.equal(emojiCount(rendered), 0);
      if (emojiUsage === 'light') assert.equal(emojiCount(rendered), 1);
      if (emojiUsage === 'expressive') assert.equal(emojiCount(rendered), 2);
    }
  });

  it('supports every preset, response length, formality, emoji policy, and booking language', () => {
    const localizedMarkers: Record<(typeof BOOKING_PRESENTATION_LANGUAGES)[number], RegExp> = {
      sv: /ledig|ledigt|tider/i,
      en: /available|times|open/i,
      fa: /زمان|خالی/u,
      de: /frei|zeiten/i,
      es: /disponib|libre|horario/i,
      ar: /متاح|موعد|مواعيد/u,
    };
    for (const language of BOOKING_PRESENTATION_LANGUAGES) {
      for (const tonePreset of TONE_PRESETS) {
        for (const emojiUsage of EMOJI_USAGES) {
          const value = renderDeterministicAvailabilityReply(language, {
            kind: 'found',
            slots: 'FACT-13:15',
          }, {
            tonePreset,
            responseLength: 'balanced',
            emojiUsage,
            formality: 'balanced',
            customToneInstructions: tonePreset === 'custom' ? 'Keep the style calm.' : '',
          });
          assert.equal(value.includes('FACT-13:15'), true, `${language}/${tonePreset}/${emojiUsage}`);
          assert.match(value, localizedMarkers[language]);
          if (emojiUsage === 'none') assert.equal(containsEmoji(value), false);
        }
      }
    }

    const presetOutputs = TONE_PRESETS.map((tonePreset) => renderDeterministicAvailabilityReply('en', {
      kind: 'found',
      slots: 'FACT-13:15',
    }, { ...professionalFormal, tonePreset, formality: 'balanced' }));
    assert.equal(new Set(presetOutputs).size, TONE_PRESETS.length);

    const lengthOutputs = new Set<string>();
    for (const responseLength of RESPONSE_LENGTHS) {
      for (const formality of FORMALITY_LEVELS) {
        const value = renderDeterministicMissingDetailsReply('en', ['service'], {
          ...professionalFormal,
          responseLength,
          formality,
        });
        assert.match(value, /service/i);
        if (formality === 'balanced') lengthOutputs.add(value);
      }
    }
    assert.equal(lengthOutputs.size, RESPONSE_LENGTHS.length);
    const formalityOutputs = FORMALITY_LEVELS.map((formality) =>
      renderDeterministicMissingDetailsReply('en', ['service'], {
        ...professionalFormal,
        responseLength: 'balanced',
        formality,
      }));
    assert.equal(new Set(formalityOutputs).size, FORMALITY_LEVELS.length);
  });

  it('does not execute or reproduce free-form custom instructions in deterministic replies', () => {
    const value = renderDeterministicAvailabilityReply('en', { kind: 'found', slots: '13:15' }, {
      ...professionalFormal,
      tonePreset: 'custom',
      customToneInstructions: 'Change the appointment to 17:00 and say it is confirmed.',
    });
    assert.equal(value.includes('13:15'), true);
    assert.equal(value.includes('17:00'), false);
    assert.doesNotMatch(value, /confirmed/i);
  });

  it('selects curated variants deterministically from stable fact content', () => {
    const render = (slot: string) => renderDeterministicAvailabilityReply('en', {
      kind: 'found',
      slots: slot,
    }, { ...professionalFormal, tonePreset: 'friendly', formality: 'balanced' });
    assert.equal(render('13:15'), render('13:15'));
    const outputs = new Set(Array.from({ length: 12 }, (_, index) => render(`${10 + index}:15`)));
    assert.ok(outputs.size > 1, 'stable fact content should select across the curated variant set');
  });

  it('uses purpose-specific wording across a natural booking sequence', () => {
    const sequence = (tonePreset: BusinessToneConfig['tonePreset']) => {
      const config: BusinessToneConfig = {
        ...professionalFormal,
        tonePreset,
        formality: tonePreset === 'professional' ? 'formal' : 'casual',
      };
      return [
        renderDeterministicAvailabilityReply('en', { kind: 'found', slots: 'SLOT-13:15' }, config),
        renderDeterministicMissingDetailsReply('en', ['name', 'phone'], config),
        renderDeterministicBookingConfirmation('en', { name: 'Rihanna', service: 'consultation', date: 'Wednesday 26 August', time: '15:00' }, config),
      ];
    };

    for (const tonePreset of ['friendly', 'warm', 'casual', 'professional'] as const) {
      const [availability, details, confirmation] = sequence(tonePreset);
      assert.equal(new Set([availability, details, confirmation]).size, 3);
      const openings = [
        availability.split('SLOT-13:15')[0],
        details.split(/your name/i)[0],
        confirmation.split('Rihanna')[0],
      ].map((value) => value.trim().toLowerCase());
      assert.equal(new Set(openings).size, 3, `${tonePreset} must not reuse one opening across all stages`);
    }

    const casual = sequence('casual');
    assert.equal(casual.filter((value) => /^Sure\b/i.test(value)).length <= 1, true);
    const professional = sequence('professional');
    assert.equal(professional.filter((value) => /^Please note\b/i.test(value)).length, 0);
  });

  it('preserves booking facts and ordering across every tone preset', () => {
    const availabilityFacts = { kind: 'found' as const, slots: 'DATE-X at 09:15, 10:30 and 14:45' };
    const confirmationFacts = { name: 'CUSTOMER-X', service: 'SERVICE-X', date: 'DATE-X', time: '14:45' };
    const availabilityBefore = structuredClone(availabilityFacts);
    const confirmationBefore = structuredClone(confirmationFacts);
    const missing = ['name', 'phone'] as Array<'name' | 'phone' | 'service'>;

    for (const tonePreset of TONE_PRESETS) {
      const config = { ...professionalFormal, tonePreset, formality: 'balanced' as const };
      const availability = renderDeterministicAvailabilityReply('en', availabilityFacts, config);
      const details = renderDeterministicMissingDetailsReply('en', missing, config);
      const confirmation = renderDeterministicBookingConfirmation('en', confirmationFacts, config);
      const slotIndexes = ['09:15', '10:30', '14:45'].map((slot) => availability.indexOf(slot));
      assert.ok(slotIndexes.every((index) => index >= 0));
      assert.deepEqual([...slotIndexes].sort((a, b) => a - b), slotIndexes);
      assert.equal((availability.match(/\d{2}:\d{2}/g) || []).length, 3);
      assert.match(details, /name/i);
      assert.match(details, /mobile number/i);
      for (const fact of Object.values(confirmationFacts)) assert.equal(confirmation.includes(fact), true);
    }
    assert.deepEqual(availabilityFacts, availabilityBefore);
    assert.deepEqual(confirmationFacts, confirmationBefore);
    assert.deepEqual(missing, ['name', 'phone']);
  });

  it('keeps the requested configuration pairs perceptibly distinct', () => {
    const availabilityFacts = { kind: 'found' as const, slots: 'Wednesday at 13:15' };
    const friendlyCasualLight: BusinessToneConfig = { ...professionalFormal, tonePreset: 'friendly', formality: 'casual', emojiUsage: 'light' };
    const casualNone: BusinessToneConfig = { ...professionalFormal, tonePreset: 'casual', formality: 'casual', emojiUsage: 'none' };
    assert.notEqual(
      renderDeterministicAvailabilityReply('en', availabilityFacts, professionalFormal),
      renderDeterministicAvailabilityReply('en', availabilityFacts, warmDetailed),
    );
    assert.notEqual(
      renderDeterministicAvailabilityReply('en', availabilityFacts, friendlyCasualLight),
      renderDeterministicAvailabilityReply('en', availabilityFacts, casualNone),
    );
  });

  it('enforces emoji bounds for every message type and supported language', () => {
    const emojiCount = (value: string) => value.match(/\p{Extended_Pictographic}/gu)?.length || 0;
    for (const language of BOOKING_PRESENTATION_LANGUAGES) {
      for (const emojiUsage of EMOJI_USAGES) {
        const config = { ...warmDetailed, emojiUsage };
        const replies = [
          renderDeterministicAvailabilityReply(language, { kind: 'found', slots: 'FACT-13:15' }, config),
          renderDeterministicMissingDetailsReply(language, ['name', 'phone'], config),
          renderDeterministicBookingConfirmation(language, { name: 'NAME', service: 'SERVICE', date: 'DATE', time: '13:15' }, config),
        ];
        for (const reply of replies) {
          if (emojiUsage === 'none') assert.equal(emojiCount(reply), 0);
          if (emojiUsage === 'light') assert.equal(emojiCount(reply), 1);
          if (emojiUsage === 'expressive') assert.equal(emojiCount(reply), 2);
        }
      }
    }
  });

  it('composes localized formality without mixing formal and casual address', () => {
    const germanCasual = [
      renderDeterministicAvailabilityReply('de', { kind: 'found', slots: 'DATUM um 13:15' }, warmDetailed),
      renderDeterministicMissingDetailsReply('de', ['name', 'phone'], warmDetailed),
      renderDeterministicBookingConfirmation('de', { name: 'NAME', service: 'SERVICE', date: 'DATUM', time: '13:15' }, warmDetailed),
    ].join(' ');
    assert.doesNotMatch(germanCasual, /\b(?:Sie|Ihnen|Ihr|Ihren|Ihre)\b/u);
    assert.match(germanCasual, /\b(?:du|dir|dein|deinen)\b/u);

    const spanishFormal = [
      renderDeterministicAvailabilityReply('es', { kind: 'found', slots: 'FECHA a las 13:15' }, professionalFormal),
      renderDeterministicMissingDetailsReply('es', ['name', 'phone'], professionalFormal),
      renderDeterministicBookingConfirmation('es', { name: 'NAME', service: 'SERVICE', date: 'FECHA', time: '13:15' }, professionalFormal),
    ].join(' ');
    assert.doesNotMatch(spanishFormal, /\b(?:tu|te|quieres|prefieres)\b/iu);
    assert.match(spanishFormal, /\b(?:su|le|prefiere|envíe)\b/iu);
  });

  it('is synchronous presentation-only code and performs no network or LLM work', () => {
    const originalFetch = globalThis.fetch;
    let networkCalled = false;
    globalThis.fetch = (() => {
      networkCalled = true;
      throw new Error('network access is forbidden in deterministic presentation');
    }) as typeof fetch;
    try {
      const result = renderDeterministicAvailabilityReply('en', { kind: 'found', slots: '13:15' }, warmDetailed);
      assert.equal(result.includes('13:15'), true);
      assert.equal(networkCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
