/** Synthetic acceptance data only. Never import into production answering. */
export const acceptanceLanguages=['en','sv','de','fa','es','ar'] as const;
export type AcceptanceLanguage=typeof acceptanceLanguages[number];
export const acceptanceFamilies=['A','B','C'] as const;
export type AcceptanceFamily=typeof acceptanceFamilies[number];
export const acceptanceChannels=['telegram','whatsapp','instagram','messenger'] as const;
export const acceptanceQuestions:Record<AcceptanceFamily,Record<AcceptanceLanguage,string>>={
 A:{
  en:'For a visit, must I follow preparation instructions if I have received them, should I avoid strong perfume, and may I bring my own water bottle or eat snacks in the waiting room and treatment/work rooms?',
  sv:'Inför besöket: måste jag följa förberedelseinstruktioner om jag har fått dem, bör jag undvika stark parfym och får jag ta med en egen vattenflaska eller äta mellanmål i väntrummet och behandlings-/arbetsrummen?',
  de:'Vor dem Besuch: Muss ich erhaltene Vorbereitungshinweise befolgen, sollte ich starkes Parfüm meiden und darf ich meine Wasserflasche mitbringen oder im Wartezimmer und in Behandlungs-/Arbeitsräumen einen Snack essen?',
  fa:'برای مراجعه، اگر دستور آماده‌سازی دریافت کرده‌ام باید آن را رعایت کنم؟ بهتر است از عطر تند پرهیز کنم؟ می‌توانم بطری آب خودم را بیاورم یا در اتاق انتظار و اتاق‌های درمان یا کار میان‌وعده بخورم؟',
  es:'Antes de la visita, ¿debo seguir las instrucciones de preparación si las recibí, evitar perfumes fuertes y puedo traer mi botella de agua o comer un tentempié en la sala de espera y las salas de tratamiento o trabajo?',
  ar:'قبل الزيارة، هل يجب اتباع تعليمات التحضير إن تلقيتها، وهل يُنصح بتجنب العطر القوي؟ وهل يمكنني إحضار زجاجة مائي أو تناول وجبة خفيفة في غرفة الانتظار وغرف العلاج أو العمل؟',
 },
 B:{
  en:'What is the price and duration of Video Consultation? Could I use it instead of an in-person visit? Separately, explain the documented purpose and limits of digital information calls.',
  sv:'Vad kostar Video Consultation och hur lång tid tar den? Kan jag använda den i stället för ett fysiskt besök? Förklara separat de dokumenterade digitala informationssamtalens syfte och begränsningar.',
  de:'Was kostet Video Consultation und wie lange dauert sie? Kann ich sie anstelle eines Besuchs vor Ort nutzen? Erklären Sie separat den dokumentierten Zweck und die Grenzen digitaler Informationsgespräche.',
  fa:'قیمت و مدت Video Consultation چقدر است؟ آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟ جداگانه هدف و محدودیت‌های مستند تماس‌های اطلاعاتی دیجیتال را توضیح دهید.',
  es:'¿Cuál es el precio y la duración de Video Consultation? ¿Puedo usarla en lugar de una visita presencial? Explica por separado el propósito y los límites documentados de las llamadas informativas digitales.',
  ar:'ما سعر ومدة Video Consultation؟ هل يمكن أن تحل محل زيارة حضورية؟ اشرح بشكل منفصل الغرض والحدود الموثقة للمكالمات المعلوماتية الرقمية.',
 },
 C:{
  en:"Do the documents state Nordpark's parking fee? Does the studio provide free parking or reserve a space for me?",
  sv:'Anger dokumenten parkeringsavgiften i Nordpark? Erbjuder studion gratis parkering eller reserverar en plats åt mig?',
  de:'Nennen die Dokumente die Parkgebühr für Nordpark? Bietet das Studio kostenloses Parken an oder reserviert es einen Platz für mich?',
  fa:'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ آیا استودیو پارکینگ رایگان فراهم می‌کند یا برای من جای پارک رزرو می‌کند؟',
  es:'¿Indican los documentos la tarifa del aparcamiento Nordpark? ¿Ofrece el estudio aparcamiento gratuito o me reserva una plaza?',
  ar:'هل تحدد المستندات رسوم موقف Nordpark؟ هل يوفر الاستوديو مواقف مجانية أو يحجز لي مكاناً؟',
 },
};
export const obligations={
 A:['conditional_preparation_required','perfume_advice_and_sensitivity','own_water_bottle_allowed','no_food_in_treatment_or_work_rooms','snacks_allowed_in_waiting_room'],
 B:['catalog_identity_price_duration','document_initial_guidance_before_first_visit','document_initial_information_only','document_no_automatic_physical_replacement','document_not_all_matters_digital','configured_service_applicability_unresolved'],
 C:['parking_fee_not_established','studio_does_not_provide_free_parking','studio_cannot_reserve_space'],
} as const;
export const documentaryQuotes={
 A:[
  'Om du har fått särskilda förberedelseinstruktioner inför ditt besök ska du\nfölja dessa.',
  'Kunder bör undvika att använda starkt parfymerade produkter precis före sitt besök, eftersom andra besökare kan vara känsliga för\ndofter.',
  'Det är tillåtet att ta med en egen vatten fl aska.',
  'Mat får inte förtäras i behandlings- eller arbetsrummen, men enklare mellanmål är tillåtna i väntrummet.',
  'Mat får inte förtäras i behandlings- eller arbetsrummen, men enklare mellanmål är tillåtna i väntrummet.',
 ],
 B:[
  'AdMotion Studio erbjuder i detta test digitala informationssamtal för kunder som behöver allmän vägledning inför ett första besök.',
  'Digitala informationssamtal används endast för inledande information.',
  'De ersätter inte automatiskt ett fysiskt besök, och alla ärenden kan inte hanteras digitalt.',
  'De ersätter inte automatiskt ett fysiskt besök, och alla ärenden kan inte hanteras digitalt.',
 ],
 C:[
  'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.',
  'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.',
 ],
} as const;
/** Hand-reviewed expected propositions for offline transport/contract checks.
 * These scripted translations cannot establish real-model semantic acceptance. */
export const documentaryStatements:Record<AcceptanceFamily,Record<AcceptanceLanguage,readonly string[]>>={
 A:{
  en:['If you have received special preparation instructions for your visit, you must follow them.','You should avoid strongly perfumed products immediately before your visit because other visitors may be sensitive to scents.','You may bring your own water bottle.','Food is not permitted in the treatment or work rooms.','Light snacks are allowed in the waiting room.'],
  sv:['Om du har fått särskilda förberedelseinstruktioner inför besöket måste du följa dem.','Du bör undvika starkt parfymerade produkter precis före besöket eftersom andra besökare kan vara känsliga för dofter.','Du får ta med en egen vattenflaska.','Mat får inte förtäras i behandlings- eller arbetsrummen.','Enklare mellanmål är tillåtna i väntrummet.'],
  de:['Wenn Sie besondere Vorbereitungshinweise für Ihren Besuch erhalten haben, müssen Sie diese befolgen.','Sie sollten unmittelbar vor Ihrem Besuch stark parfümierte Produkte vermeiden, da andere Besucher empfindlich auf Düfte reagieren können.','Sie dürfen Ihre eigene Wasserflasche mitbringen.','In den Behandlungs- oder Arbeitsräumen darf nicht gegessen werden.','Kleine Snacks sind im Wartezimmer erlaubt.'],
  fa:['اگر برای مراجعه دستورهای آماده‌سازی ویژه دریافت کرده‌اید، باید آن‌ها را رعایت کنید.','بهتر است درست پیش از مراجعه از محصولات با عطر تند پرهیز کنید، چون دیگر مراجعان ممکن است به بوها حساس باشند.','می‌توانید بطری آب خودتان را همراه بیاورید.','خوردن غذا در اتاق‌های درمان یا کار مجاز نیست.','خوردن میان‌وعده سبک در اتاق انتظار مجاز است.'],
  es:['Si ha recibido instrucciones especiales de preparación para su visita, debe seguirlas.','Se recomienda evitar productos muy perfumados justo antes de la visita, ya que otros visitantes pueden ser sensibles a los olores.','Puede traer su propia botella de agua.','No se permite comer en las salas de tratamiento o trabajo.','Se permiten tentempiés ligeros en la sala de espera.'],
  ar:['إذا تلقيت تعليمات تحضير خاصة لزيارتك، فيجب عليك اتباعها.','يُنصح بتجنب المنتجات شديدة التعطير قبل الزيارة مباشرة لأن الزوار الآخرين قد يكونون حساسين للروائح.','يمكنك إحضار زجاجة الماء الخاصة بك.','لا يُسمح بتناول الطعام في غرف العلاج أو العمل.','يُسمح بوجبات خفيفة بسيطة في غرفة الانتظار.'],
 },
 B:{
  en:['Digital information calls provide general guidance before a first visit.','Digital information calls are only for initial information.','Digital information calls do not automatically replace a physical visit.','Not all matters can be handled digitally.'],
  sv:['Digitala informationssamtal ger allmän vägledning inför ett första besök.','Digitala informationssamtal används endast för inledande information.','Digitala informationssamtal ersätter inte automatiskt ett fysiskt besök.','Alla ärenden kan inte hanteras digitalt.'],
  de:['Digitale Informationsgespräche bieten allgemeine Orientierung vor einem ersten Besuch.','Digitale Informationsgespräche dienen ausschließlich der ersten Information.','Digitale Informationsgespräche ersetzen nicht automatisch einen Besuch vor Ort.','Nicht alle Anliegen können digital bearbeitet werden.'],
  fa:['تماس‌های اطلاعاتی دیجیتال برای راهنمایی عمومی پیش از نخستین مراجعه هستند.','تماس‌های اطلاعاتی دیجیتال فقط برای اطلاعات اولیه هستند.','تماس‌های اطلاعاتی دیجیتال به‌طور خودکار جایگزین مراجعه حضوری نمی‌شوند.','همه موضوعات را نمی‌توان به‌صورت دیجیتال رسیدگی کرد.'],
  es:['Las llamadas informativas digitales ofrecen orientación general antes de una primera visita.','Las llamadas informativas digitales son únicamente para información inicial.','Las llamadas informativas digitales no sustituyen automáticamente una visita presencial.','No todos los asuntos se pueden atender de forma digital.'],
  ar:['تقدم المكالمات المعلوماتية الرقمية إرشادات عامة قبل الزيارة الأولى.','المكالمات المعلوماتية الرقمية مخصصة للمعلومات الأولية فقط.','لا تحل المكالمات المعلوماتية الرقمية تلقائياً محل زيارة حضورية.','لا يمكن التعامل مع جميع الأمور رقمياً.'],
 },
 C:{
  en:['AdMotion Studio does not provide free parking.','AdMotion Studio cannot reserve parking spaces.'],
  sv:['AdMotion Studio erbjuder inte gratis parkering.','AdMotion Studio kan inte reservera parkeringsplatser.'],
  de:['AdMotion Studio bietet kein kostenloses Parken an.','AdMotion Studio kann keine Parkplätze reservieren.'],
  fa:['AdMotion Studio پارکینگ رایگان فراهم نمی‌کند.','AdMotion Studio نمی‌تواند جای پارک رزرو کند.'],
  es:['AdMotion Studio no ofrece aparcamiento gratuito.','AdMotion Studio no puede reservar plazas de aparcamiento.'],
  ar:['لا يوفر AdMotion Studio مواقف مجانية.','لا يستطيع AdMotion Studio حجز أماكن لوقوف السيارات.'],
 },
};
export const preliminaryAcceptancePlan=acceptanceFamilies.flatMap((family,f)=>acceptanceLanguages.map((language,l)=>({
 id:`${family}-${language}`,sequence:f*6+l+1,family,language,channel:acceptanceChannels[(f+l)%4],businessId:77,
 question:acceptanceQuestions[family][language],obligations:[...obligations[family]],
 expectedCoverage:family==='A'?'VERIFIED':'PARTIAL',freshSession:true,outbound:'intercepted',
})));
export const laterExpansionPlan=acceptanceLanguages.flatMap(language=>acceptanceChannels.flatMap(channel=>acceptanceFamilies.map(family=>({family,language,channel,question:acceptanceQuestions[family][language]}))));
