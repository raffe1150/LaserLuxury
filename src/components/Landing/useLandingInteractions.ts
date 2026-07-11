import { useEffect } from 'react';
import landingCss from '../../styles/landing.css?raw';

const landingScript = "\n/* ── CANVAS ── */\nconst cvs = document.getElementById('bg-canvas');\nconst ctx = cvs.getContext('2d');\nlet W, H, scrollY = 0;\nconst stars = Array.from({length:160}, () => ({x:Math.random()*1920,y:Math.random()*1080,r:Math.random()*1.1+0.2,a:Math.random()*0.5+0.08,phase:Math.random()*Math.PI*2,speed:Math.random()*0.015+0.003,parallax:Math.random()*0.08+0.01}));\nconst floats = Array.from({length:12}, () => ({x:Math.random()*1920,y:Math.random()*1080,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*2+1,a:Math.random()*.3+0.08}));\nlet mouse = {x:-999,y:-999};\nwindow.addEventListener('mousemove', e => {mouse.x=e.clientX;mouse.y=e.clientY;});\nwindow.addEventListener('scroll', () => {\n  scrollY=window.scrollY;\n  updateBackToTop();\n});\nfunction resize(){W=cvs.width=window.innerWidth;H=cvs.height=window.innerHeight;}\nresize(); window.addEventListener('resize',resize);\nfunction updateBackToTop() {\n  const btn = document.getElementById('backToTop');\n  if (!btn) return;\n  btn.classList.toggle('show', window.scrollY > 650);\n}\nfunction scrollToTop() {\n  window.scrollTo({ top: 0, behavior: 'smooth' });\n}\nfunction frame(){\n  ctx.clearRect(0,0,W,H);\n  ctx.save(); ctx.strokeStyle='rgba(61,220,132,0.04)'; ctx.lineWidth=1;\n  const gs=90,ox=(scrollY*.05)%gs;\n  for(let x=0;x<W;x+=gs){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}\n  for(let y=-ox;y<H;y+=gs){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}\n  ctx.restore();\n  const arc=ctx.createRadialGradient(W/2,H*1.1,0,W/2,H*1.1,W*.65);\n  arc.addColorStop(0,'rgba(61,220,132,0.17)');arc.addColorStop(.35,'rgba(61,220,132,0.06)');arc.addColorStop(1,'rgba(0,0,0,0)');\n  ctx.fillStyle=arc;ctx.fillRect(0,0,W,H);\n  stars.forEach(s=>{s.phase+=s.speed;const px=s.x%W,py=(s.y-scrollY*s.parallax+10000)%H,al=s.a*(0.55+0.45*Math.sin(s.phase));ctx.beginPath();ctx.arc(px,py,s.r,0,Math.PI*2);ctx.fillStyle=`rgba(220,240,228,${al})`;ctx.fill();});\n  floats.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;const pg=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*14);pg.addColorStop(0,`rgba(61,220,132,${p.a})`);pg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=pg;ctx.fillRect(p.x-p.r*14,p.y-p.r*14,p.r*28,p.r*28);});\n  if(mouse.x>0){const mg=ctx.createRadialGradient(mouse.x,mouse.y,0,mouse.x,mouse.y,200);mg.addColorStop(0,'rgba(61,220,132,0.06)');mg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=mg;ctx.fillRect(0,0,W,H);}\n  requestAnimationFrame(frame);\n}\nframe();\n\n/* ── SCROLL REVEAL ── */\nconst io = new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add('in');});},{threshold:0.1});\ndocument.querySelectorAll('.reveal').forEach(el=>io.observe(el));\n\n/* ── COUNTER ANIMATION ── */\nfunction animateCounter(el) {\n  const target = parseInt(el.dataset.target);\n  if (!target) return;\n  let current = 0;\n  const duration = 1800;\n  const step = target / (duration / 16);\n  const timer = setInterval(() => {\n    current = Math.min(current + step, target);\n    el.textContent = Math.floor(current).toLocaleString('sv-SE') + (el.dataset.target == '98' ? '%' : '+');\n    if (current >= target) clearInterval(timer);\n  }, 16);\n}\nconst counterObs = new IntersectionObserver(entries => {\n  entries.forEach(e => { if(e.isIntersecting){ animateCounter(e.target); counterObs.unobserve(e.target); }});\n}, {threshold:0.5});\ndocument.querySelectorAll('.proof-num[data-target]').forEach(el=>counterObs.observe(el));\n\n/* ── DEMO ANIMATION ── */\nsetTimeout(() => {\n  const typing = document.getElementById('typingBubble');\n  const msgs = document.getElementById('demoMessages');\n  if(!typing||!msgs) return;\n  setTimeout(() => {\n    typing.remove();\n    const reply = document.createElement('div');\n    reply.className = 'dm out';\n    reply.textContent = \"Perfect! I've booked you at 10:00 on Friday July 4. You'll get a confirmation via DM. See you! 🌿\";\n    msgs.appendChild(reply);\n    msgs.scrollTop = msgs.scrollHeight;\n  }, 3000);\n}, 1500);\n\n/* ── BENTO MOUSE GLOW ── */\ndocument.querySelectorAll('.bento-card').forEach(card => {\n  card.addEventListener('mousemove', e => {\n    const r = card.getBoundingClientRect();\n    card.style.setProperty('--mx', ((e.clientX-r.left)/r.width*100)+'%');\n    card.style.setProperty('--my', ((e.clientY-r.top)/r.height*100)+'%');\n  });\n});\n\n/* ── FAQ ── */\nfunction toggleFaq(btn) {\n  const item = btn.parentElement;\n  const isOpen = item.classList.contains('open');\n  document.querySelectorAll('.faq-item.open').forEach(i=>i.classList.remove('open'));\n  if(!isOpen) item.classList.add('open');\n}\n\n/* ── LANGUAGE SYSTEM ── */\nconst LANGS = {\n  en: { flag:'🇬🇧', code:'EN', dir:'ltr' },\n  sv: { flag:'🇸🇪', code:'SV', dir:'ltr' },\n  de: { flag:'🇩🇪', code:'DE', dir:'ltr' },\n  es: { flag:'🇪🇸', code:'ES', dir:'ltr' },\n  fa: { flag:'🇮🇷', code:'FA', dir:'rtl' },\n  ar: { flag:'🇸🇦', code:'AR', dir:'rtl' },\n};\nlet currentLang = 'en';\nconst FORM_SENT_TEXT = {\n  en: '✓ Sent!',\n  sv: '✓ Skickat!',\n  de: '✓ Gesendet!',\n  es: '✓ Enviado!',\n  fa: '✓ ارسال شد!',\n  ar: '✓ تم الإرسال!'\n};\n\nfunction setLang(lang) {\n  if (!LANGS[lang]) lang = 'en';\n  currentLang = lang;\n  document.documentElement.lang = lang;\n  document.documentElement.dir = LANGS[lang].dir;\n  document.body.style.fontFamily = (lang === 'fa' || lang === 'ar')\n    ? '\"Vazirmatn\", \"Inter\", sans-serif'\n    : '\"Inter\", sans-serif';\n\n  // Apply translations for this lang, fallback to EN\n  document.querySelectorAll('[data-en]').forEach(el => {\n    const v = el.getAttribute('data-' + lang) || el.getAttribute('data-en');\n    if (v) el.innerHTML = v;\n  });\n  document.querySelectorAll('[data-placeholder-en]').forEach(el => {\n    const v = el.getAttribute('data-placeholder-' + lang) || el.getAttribute('data-placeholder-en');\n    if (v) el.setAttribute('placeholder', v);\n  });\n\n  const flagEl = document.getElementById('langFlag');\n  const codeEl = document.getElementById('langCode');\n  if (flagEl) flagEl.textContent = LANGS[lang].flag;\n  if (codeEl) codeEl.textContent = LANGS[lang].code;\n\n  document.querySelectorAll('.lang-option').forEach(o => o.classList.remove('active'));\n  const active = document.querySelector(`.lang-option[onclick=\"setLang('${lang}')\"]`);\n  if (active) active.classList.add('active');\n\n  if (document.getElementById('roiBookings')) calculateRoi();\n  closeLangMenu();\n  try { localStorage.setItem('af_lang', lang); } catch(e) {}\n}\n\nfunction toggleLangMenu(e) {\n  e.stopPropagation();\n  document.getElementById('langMenu').classList.toggle('open');\n}\nfunction closeLangMenu() {\n  const m = document.getElementById('langMenu');\n  if (m) m.classList.remove('open');\n}\ndocument.addEventListener('click', closeLangMenu);\n\n/* ── MODAL ── */\nfunction calculateRoi() {\n  const input = document.getElementById('roiBookings');\n  const lostEl = document.getElementById('roiLost');\n  const compareEl = document.getElementById('roiCompare');\n  const bookings = Math.max(0, parseInt(input?.value || '0', 10));\n  const avgBookingValue = 1200;\n  const monthlyLost = bookings * 4 * avgBookingValue;\n  const monthlyCost = 990;\n  const perMonth = {\n    en: 'kr/month',\n    sv: 'kr/månad',\n    de: 'kr/Monat',\n    es: 'kr/mes',\n    fa: 'کرون/ماه',\n    ar: 'كرونة/شهر'\n  };\n  const compareCopy = {\n    en: `Odinlink costs <strong>${monthlyCost.toLocaleString('sv-SE')} kr/month</strong>.`,\n    sv: `Odinlink kostar <strong>${monthlyCost.toLocaleString('sv-SE')} kr/månad</strong>.`,\n    de: `Odinlink kostet <strong>${monthlyCost.toLocaleString('sv-SE')} kr/Monat</strong>.`,\n    es: `Odinlink cuesta <strong>${monthlyCost.toLocaleString('sv-SE')} kr/mes</strong>.`,\n    fa: `هزینه Odinlink <strong>${monthlyCost.toLocaleString('sv-SE')} کرون/ماه</strong> است.`,\n    ar: `تكلفة Odinlink هي <strong>${monthlyCost.toLocaleString('sv-SE')} كرونة/شهر</strong>.`\n  };\n  if (lostEl) lostEl.textContent = `${monthlyLost.toLocaleString('sv-SE')} ${perMonth[currentLang] || perMonth.en}`;\n  if (compareEl) compareEl.innerHTML = compareCopy[currentLang] || compareCopy.en;\n}\nfunction openModal(e) {\n  if(e) e.preventDefault();\n  const m = document.getElementById('contactModal');\n  if (!m) return;\n  setLang(currentLang);\n  m.style.display = 'flex';\n  document.body.style.overflow = 'hidden';\n}\nfunction closeModal() {\n  const m = document.getElementById('contactModal');\n  if (!m) return;\n  m.style.display = 'none';\n  document.body.style.overflow = '';\n}\nfunction submitForm(btn) {\n  const span = btn.querySelector('span');\n  if (!span) return;\n  const orig = span.textContent;\n  span.textContent = FORM_SENT_TEXT[currentLang] || FORM_SENT_TEXT.en;\n  btn.style.background = '#2ab86a';\n  setTimeout(() => { closeModal(); span.textContent = orig; btn.style.background = 'var(--green)'; }, 1800);\n}\n\n// Modal close on backdrop click and ESC — deferred until DOM ready\ndocument.addEventListener('DOMContentLoaded', function() {\n  calculateRoi();\n  setLang(currentLang);\n  updateBackToTop();\n  const modal = document.getElementById('contactModal');\n  if (modal) {\n    modal.addEventListener('click', function(e) {\n      if (e.target === this) closeModal();\n    });\n  }\n});\ndocument.addEventListener('keydown', function(e) { if(e.key==='Escape') closeModal(); });\n\n/* ── AUTO-DETECT LANGUAGE ── */\n(function() {\n  try {\n    const saved = localStorage.getItem('af_lang');\n    const browser = (navigator.language || 'en').split('-')[0];\n    const supported = ['en','sv','de','es','fa','ar'];\n    const lang = (saved && supported.includes(saved)) ? saved : (supported.includes(browser) ? browser : 'en');\n    setLang(lang);\n  } catch(e) {\n    setLang('en');\n  }\n})();\n";

export default function useLandingInteractions(onNavigate: (path: '/' | '/login' | '/dashboard') => void) {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pageStyle = 'landing';
    style.textContent = landingCss;
    document.head.appendChild(style);

    let disposed = false;
    const cleanupFns: Array<() => void> = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const frameIds = new Set<number>();

    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = originalRequestAnimationFrame((time) => {
        if (!disposed) callback(time);
      });
      frameIds.add(id);
      return id;
    }) as typeof window.requestAnimationFrame;

    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    (EventTarget.prototype as any).addEventListener = function(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      originalAddEventListener.call(this, type, listener, options);
      if (listener) {
        cleanupFns.push(() => originalRemoveEventListener.call(this, type, listener, options));
      }
    };

    try {
      new Function(`${landingScript}\n;window.setLang=setLang;window.toggleLangMenu=toggleLangMenu;window.closeLangMenu=closeLangMenu;window.calculateRoi=calculateRoi;window.openModal=openModal;window.closeModal=closeModal;window.submitForm=submitForm;window.toggleFaq=toggleFaq;window.scrollToTop=scrollToTop;`)();
    } finally {
      EventTarget.prototype.addEventListener = originalAddEventListener;
    }

    (window as any).calculateRoi?.();
    (window as any).setLang?.(localStorage.getItem('af_lang') || 'en');
    const modal = document.getElementById('contactModal');
    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === modal) (window as any).closeModal?.();
    };
    modal?.addEventListener('click', closeOnBackdrop);
    cleanupFns.push(() => modal?.removeEventListener('click', closeOnBackdrop));

    const routeDashboard = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.('a[href="/dashboard"]') as HTMLAnchorElement | null;
      if (!link) return;
      event.preventDefault();
      onNavigate('/dashboard');
    };
    document.addEventListener('click', routeDashboard);

    return () => {
      disposed = true;
      style.remove();
      document.removeEventListener('click', routeDashboard);
      cleanupFns.forEach((cleanup) => cleanup());
      frameIds.forEach((id) => window.cancelAnimationFrame(id));
      window.requestAnimationFrame = originalRequestAnimationFrame;
      delete (window as any).setLang;
      delete (window as any).toggleLangMenu;
      delete (window as any).closeLangMenu;
      delete (window as any).calculateRoi;
      delete (window as any).openModal;
      delete (window as any).closeModal;
      delete (window as any).submitForm;
      delete (window as any).toggleFaq;
      delete (window as any).scrollToTop;
    };
  }, [onNavigate]);
}
