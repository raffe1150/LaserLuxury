// Synthetic source-backed content; providers and native sends are intercepted.
const en = 'Use the Nordpark garage at Stjärngatan 14, about five minutes on foot from the studio. Parking is paid and spaces cannot be reserved. Contact the studio for parking alternatives.';
export const naturalLocationCases = [
  ['en', "Hello, I'm thinking about visiting your studio next week. Could you tell me where I can park my car?", en],
  ['en', "Hi! I'm thinking about visiting your studio next week. Could you tell me where I can park my car?", en],
  ['en', "I'm thinking about visiting your studio next week. Could you tell me where I can park my car?", en],
  ['en', 'Where can I park my car when visiting AdMotion Studio?', en],
  ['sv', 'Hej! Jag funderar på ett besök nästa vecka. Kan ni berätta var jag kan parkera bilen?', 'Använd Nordpark på Stjärngatan 14, cirka fem minuters promenad från studion. Parkeringen är avgiftsbelagd och platser kan inte reserveras. Kontakta studion för parkeringsalternativ.'],
  ['de', 'Ich plane nächste Woche einen Besuch. Können Sie mir sagen wo ich parken kann?', 'Nutzen Sie die Nordpark-Garage an der Stjärngatan 14, etwa fünf Gehminuten vom Studio entfernt. Das Parken ist kostenpflichtig und Plätze können nicht reserviert werden. Kontaktieren Sie das Studio für Parkalternativen.'],
  ['es', 'Hola! Estoy pensando en visitarles. ¿Me pueden decir dónde puedo aparcar?', 'Puede usar el garaje Nordpark en Stjärngatan 14, a unos cinco minutos a pie del estudio. El aparcamiento es de pago y no se pueden reservar plazas. Contacte con el estudio para conocer alternativas de aparcamiento.'],
  ['fa', 'سلام! قصد دارم هفته آینده به استودیو بیایم. می‌توانید بگویید کجا می توانم پارکینگ پیدا کنم؟', 'از پارکینگ Nordpark در Stjärngatan 14 استفاده کنید که حدود پنج دقیقه پیاده تا استودیو فاصله دارد. پارکینگ پولی است و امکان رزرو جای پارک وجود ندارد. برای گزینه‌های دیگر پارکینگ با استودیو تماس بگیرید.'],
  ['ar', 'أفكر في زيارة الاستوديو الأسبوع القادم. هل يمكنكم إخباري أين يمكنني ركن سيارتي؟', 'يمكن استخدام مرآب Nordpark في Stjärngatan 14 على بعد نحو خمس دقائق سيرًا من الاستوديو. الوقوف مدفوع ولا يمكن حجز أماكن. تواصل مع الاستوديو لمعرفة بدائل الوقوف.'],
] as const;
