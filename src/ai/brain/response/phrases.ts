import type { SupportedConversationLanguage as Language } from '../../language-brain';
import type { Missing } from '../semantic/contracts';

type Phrases = {
  unknown: string; requirement: string; recommendation: string; permission: string;
  prohibition: string; ask: Record<Missing, string>; correction: string; handoff: string; close: string;
};
export const phrases: Record<Language, Phrases> = {
  en: { unknown: 'I couldn’t verify that detail.', requirement: 'I couldn’t verify whether that’s required.',
    recommendation: 'I couldn’t verify what’s recommended there.', permission: 'I couldn’t verify whether that’s allowed.',
    prohibition: 'I couldn’t verify whether that’s prohibited.', correction: 'Got it, I’ll use that preference.', handoff: 'The booking system can check that request.', close: 'You’re welcome. Take care!',
    ask: { service: 'Which service would you like?', staff: 'Which staff member did you mean?', date: 'Which day works for you?',
      time: 'What time did you have in mind?', reference: 'Which one do you mean?', intent: 'What would you like help with?', conflict: 'Which option should I use?' } },
  sv: { unknown: 'Jag kunde inte bekräfta den detaljen.', requirement: 'Jag kunde inte bekräfta om det är ett krav.',
    recommendation: 'Jag kunde inte bekräfta vad som rekommenderas.', permission: 'Jag kunde inte bekräfta om det är tillåtet.',
    prohibition: 'Jag kunde inte bekräfta om det är förbjudet.', correction: 'Då utgår jag från ditt nya önskemål.', handoff: 'Bokningssystemet kan kontrollera din förfrågan.', close: 'Varsågod. Ha det fint!',
    ask: { service: 'Vilken tjänst vill du boka?', staff: 'Vem i personalen menar du?', date: 'Vilken dag passar dig?',
      time: 'Vilken tid tänkte du dig?', reference: 'Vilken menar du?', intent: 'Vad vill du ha hjälp med?', conflict: 'Vilket alternativ ska jag utgå från?' } },
  de: { unknown: 'Das konnte ich nicht verlässlich klären.', requirement: 'Ob das erforderlich ist, konnte ich nicht bestätigen.',
    recommendation: 'Ich konnte nicht bestätigen, was hier empfohlen wird.', permission: 'Ob das erlaubt ist, konnte ich nicht bestätigen.',
    prohibition: 'Ob das untersagt ist, konnte ich nicht bestätigen.', correction: 'Alles klar, ich berücksichtige Ihren neuen Wunsch.', handoff: 'Das Buchungssystem kann Ihre Anfrage prüfen.', close: 'Gern geschehen. Alles Gute!',
    ask: { service: 'Welche Leistung möchten Sie buchen?', staff: 'Wen aus dem Team meinen Sie?', date: 'Welcher Tag passt Ihnen?',
      time: 'Welche Uhrzeit meinen Sie?', reference: 'Was genau meinen Sie?', intent: 'Wobei kann ich Ihnen helfen?', conflict: 'Welche Option meinen Sie?' } },
  es: { unknown: 'No pude confirmar ese detalle.', requirement: 'No pude confirmar si es obligatorio.',
    recommendation: 'No pude confirmar qué se recomienda en ese caso.', permission: 'No pude confirmar si está permitido.',
    prohibition: 'No pude confirmar si está prohibido.', correction: 'De acuerdo, tendré en cuenta tu nueva preferencia.', handoff: 'El sistema de reservas puede comprobar esa solicitud.', close: 'De nada. ¡Que te vaya bien!',
    ask: { service: '¿Qué servicio te gustaría reservar?', staff: '¿A quién del equipo te refieres?', date: '¿Qué día te viene bien?',
      time: '¿A qué hora te refieres?', reference: '¿A cuál te refieres?', intent: '¿En qué te puedo ayudar?', conflict: '¿Con cuál de las opciones te quedas?' } },
  fa: { unknown: 'نتوانستم این مورد را تأیید کنم.', requirement: 'نتوانستم تأیید کنم که این مورد الزامی است یا نه.',
    recommendation: 'نتوانستم تأیید کنم چه کاری توصیه می‌شود.', permission: 'نتوانستم تأیید کنم که این کار مجاز است یا نه.',
    prohibition: 'نتوانستم تأیید کنم که این کار ممنوع است یا نه.', correction: 'باشه، ترجیح جدیدتان را در نظر می‌گیرم.', handoff: 'درخواستتان را می‌شود در سامانهٔ نوبت‌دهی بررسی کرد.', close: 'خواهش می‌کنم. روز خوبی داشته باشید!',
    ask: { service: 'کدام خدمت را می‌خواهید؟', staff: 'منظورتان کدام همکار است؟', date: 'چه روزی برایتان مناسب است؟',
      time: 'چه ساعتی مدنظرتان است؟', reference: 'منظورتان کدام مورد است؟', intent: 'در چه موردی می‌توانم کمک کنم؟', conflict: 'کدام گزینه را در نظر بگیرم؟' } },
  ar: { unknown: 'لم أتمكن من التحقق من هذه المعلومة.', requirement: 'لم أتمكن من التأكد مما إذا كان ذلك مطلوبًا.',
    recommendation: 'لم أتمكن من التأكد مما يُنصح به في هذه الحالة.', permission: 'لم أتمكن من التأكد مما إذا كان ذلك مسموحًا.',
    prohibition: 'لم أتمكن من التأكد مما إذا كان ذلك ممنوعًا.', correction: 'حسنًا، سأراعي تفضيلك الجديد.', handoff: 'يمكن التحقق من طلبك عبر نظام الحجز.', close: 'على الرحب والسعة. أتمنى لك يومًا طيبًا!',
    ask: { service: 'ما الخدمة التي ترغب فيها؟', staff: 'من تقصد من فريق العمل؟', date: 'أي يوم يناسبك؟',
      time: 'ما الوقت الذي تقصده؟', reference: 'أي خيار تقصد؟', intent: 'كيف يمكنني مساعدتك؟', conflict: 'أي خيار تفضّل أن أعتمده؟' } },
};
