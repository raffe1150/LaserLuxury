export const arrivalPolicyQuestions = {
  sv:[
    'Jag hinner nog först 20 minuter efter min bokade tid. Försvinner bokningen automatiskt eller kan personalen avgöra vad som händer?',
    'Om jag blir sen till min bokning, kan personalen bedöma situationen?',
    'Jag kommer en halvtimme efter min bokade tid. Avbokas besöket automatiskt?',
  ],
  en:[
    'I will probably make it 20 minutes after my appointment. Is my booking automatically lost, or can staff decide?',
    'What happens if I am late for my appointment? Can staff assess the situation?',
    'I might get there half an hour after my appointment. Does that mean automatic cancellation?',
  ],
  de:[
    'Ich schaffe es wahrscheinlich erst 20 Minuten nach meinem Termin. Ist meine Buchung dann automatisch weg, oder kann das Personal noch entscheiden?',
    'Wenn ich mich bei meinem Termin verspäte, kann das Personal die Situation beurteilen?',
    'Ich bin wohl eine halbe Stunde nach meinem Termin da. Entscheiden die Mitarbeiter noch über meinen Besuch?',
  ],
  es:[
    'Probablemente llegaré 20 minutos después de mi cita. ¿Se pierde automáticamente la reserva o puede decidir el personal?',
    '¿Qué pasa si llego tarde a mi cita? ¿Puede el personal evaluar la situación?',
    'Llegaré media hora después de mi cita. ¿Se cancela automáticamente?',
  ],
  fa:[
    'احتمالاً ۲۰ دقیقه بعد از نوبتم می‌رسم. آیا نوبت خودکار از بین می‌رود یا کارکنان می‌توانند تصمیم بگیرند؟',
    'اگر برای نوبتم دیر برسم، آیا کارکنان می‌توانند وضعیت را بررسی کنند؟',
    'شاید نیم ساعت بعد از نوبتم برسم. آیا نوبت خودکار لغو می‌شود؟',
  ],
  ar:[
    'قد أصل بعد عشرين دقيقة بعد موعدي. هل يضيع الحجز تلقائياً أم يستطيع الموظفون اتخاذ القرار؟',
    'ماذا يحدث إذا تأخرت عن موعدي؟ هل يستطيع الموظفون تقييم الموقف؟',
    'سأصل نصف ساعة بعد موعدي. هل يُلغى الحجز تلقائياً؟',
  ],
} as const;

export const mixedArrivalPolicyQuestions = {
  sv:'Var är entrén och vad händer om jag blir sen till min bokning?',
  en:'Where is the entrance, and what happens if I am late for my appointment?',
  de:'Wo ist der Eingang und was passiert, wenn ich zu spät komme?',
  es:'¿Dónde está la entrada y qué pasa si llego tarde a mi cita?',
  fa:'ورودی کجاست و اگر برای نوبتم دیر برسم چه می‌شود؟',
  ar:'أين المدخل وماذا يحدث إذا تأخرت عن موعدي؟',
} as const;
