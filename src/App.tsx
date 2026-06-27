import React, { useState } from 'react';
import { LayoutDashboard, Building2, Settings, LogOut, Bell, Search, ChevronDown, Plus, Edit2, Trash2, ShieldCheck, Globe } from 'lucide-react';

interface Salon {
  id: string;
  name: string;
  businessId: string;
  status: 'active' | 'inactive';
}

type Language = 'EN' | 'FA' | 'SV' | 'ES' | 'DE';

export function ConfigPanel() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'salons' | 'settings'>('dashboard');
  const [language, setLanguage] = useState<Language>('EN');
  
  const [businessId, setBusinessId] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const [salons, setSalons] = useState<Salon[]>([
    { id: '1', name: 'Laser Luxury Tehran', businessId: 'laser_tehran', status: 'active' },
    { id: '2', name: 'Beauty Clinic Zafaranieh', businessId: 'beauty_zaf', status: 'active' },
    { id: '3', name: 'Laser Center Isfahan', businessId: 'laser_esf', status: 'inactive' }
  ]);

  const [newSalonName, setNewSalonName] = useState('');
  const [newBusinessId, setNewBusinessId] = useState('');

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    alert(translations[language].saved);
  };

  const handleAddSalon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSalonName || !newBusinessId) return;
    
    const newSalon: Salon = {
      id: Date.now().toString(),
      name: newSalonName,
      businessId: newBusinessId,
      status: 'active'
    };
    
    setSalons([...salons, newSalon]);
    setNewSalonName('');
    setNewBusinessId('');
  };

  const handleDeleteSalon = (id: string) => {
    setSalons(salons.filter(salon => salon.id !== id));
  };

  // ترجمه عبارات به ۵ زبان
  const translations = {
    EN: {
      dashboard: 'Dashboard',
      salons: 'Salons / Branches',
      settings: 'Settings',
      logout: 'Logout',
      search: 'Search...',
      admin: 'Main Admin',
      connectedSalons: 'Connected Salons',
      activeChats: 'Active Chats',
      successfulBookings: 'Successful Bookings (This month)',
      enterprisePanel: 'Multi-Branch Enterprise Panel',
      enterpriseDesc: 'The system is configured to support multiple salons and provide intelligent receptionist services. Please use the "Salons" menu to manage branches and the "Settings" menu to adjust AI guidelines.',
      addNewSalon: 'Add New Salon',
      salonName: 'Salon Name',
      businessIdLabel: 'Business ID',
      status: 'Status',
      actions: 'Actions',
      active: 'Active',
      inactive: 'Inactive',
      aiSettings: 'AI & System Configuration',
      aiDesc: 'Configure your AI assistant, Telegram tokens, and Google Calendar IDs.',
      defaultBusinessId: 'Default Business ID',
      telegramToken: 'Telegram Bot Token',
      calendarId: 'Google Calendar ID',
      systemPrompt: 'Dedicated Receptionist Instructions (System Prompt)',
      saveConfig: 'Save Configuration',
      saved: 'Settings saved successfully!',
      placeholderBusiness: 'e.g. laser_tehran',
      placeholderPrompt: 'Smart receptionist behavior and instructions...',
      placeholderCalendar: 'mail@group.calendar.google.com',
    },
    FA: {
      dashboard: 'داشبورد',
      salons: 'سالن‌ها / مراکز',
      settings: 'تنظیمات',
      logout: 'خروج',
      search: 'جستجو...',
      admin: 'مدیر اصلی',
      connectedSalons: 'سالن‌های متصل',
      activeChats: 'مکالمات فعال',
      successfulBookings: 'رزروهای موفق (این ماه)',
      enterprisePanel: 'پنل مدیریت چندشعبه‌ای (Enterprise)',
      enterpriseDesc: 'سیستم برای پشتیبانی از چند سالن و ارائه خدمات منشی‌گری هوشمند پیکربندی شده است. لطفاً از منوی «سالن‌ها» برای مدیریت شعبه‌ها و از منوی «تنظیمات» برای تغییر دستورالعمل‌های هوش مصنوعی استفاده نمایید.',
      addNewSalon: 'افزودن سالن جدید',
      salonName: 'نام سالن',
      businessIdLabel: 'شناسه کسب و کار (Business ID)',
      status: 'وضعیت',
      actions: 'عملیات',
      active: 'فعال',
      inactive: 'غیرفعال',
      aiSettings: 'تنظیمات هوش مصنوعی و سیستم',
      aiDesc: 'پیکربندی دستیار هوش مصنوعی، توکن‌های تلگرام و تقویم گوگل.',
      defaultBusinessId: 'شناسه پیش‌فرض کسب‌وکار',
      telegramToken: 'توکن ربات تلگرام',
      calendarId: 'شناسه تقویم گوگل',
      systemPrompt: 'دستورالعمل‌های اختصاصی منشی (System Prompt)',
      saveConfig: 'ذخیره پیکربندی',
      saved: 'تنظیمات با موفقیت ذخیره شد!',
      placeholderBusiness: 'مثال: laser_tehran',
      placeholderPrompt: 'شخصیت و دستورالعمل‌های منشی هوشمند...',
      placeholderCalendar: 'mail@group.calendar.google.com',
    },
    SV: {
      dashboard: 'Översikt',
      salons: 'Salonger / Filialer',
      settings: 'Inställningar',
      logout: 'Logga ut',
      search: 'Sök...',
      admin: 'Huvudadministratör',
      connectedSalons: 'Anslutna salonger',
      activeChats: 'Aktiva chattar',
      successfulBookings: 'Slutförda bokningar (Denna månad)',
      enterprisePanel: 'Företagspanel för flera filialer',
      enterpriseDesc: 'Systemet är konfigurerat för att stödja flera salonger och tillhandahålla intelligenta receptionstjänster. Använd menyn "Salonger" för att hantera filialer och menyn "Inställningar" för att justera AI-instruktioner.',
      addNewSalon: 'Lägg till ny salong',
      salonName: 'Salongnamn',
      businessIdLabel: 'Företags-ID',
      status: 'Status',
      actions: 'Åtgärder',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      aiSettings: 'AI- & Systeminställningar',
      aiDesc: 'Konfigurera din AI-assistent, Telegram-token och Google Calendar-ID.',
      defaultBusinessId: 'Standard Företags-ID',
      telegramToken: 'Telegram Bot Token',
      calendarId: 'Google Calendar ID',
      systemPrompt: 'Dedikerade instruktioner för receptionist (System Prompt)',
      saveConfig: 'Spara konfiguration',
      saved: 'Inställningarna har sparats!',
      placeholderBusiness: 't.ex. laser_tehran',
      placeholderPrompt: 'Beteende och instruktioner för smart receptionist...',
      placeholderCalendar: 'mail@group.calendar.google.com',
    },
    ES: {
      dashboard: 'Panel',
      salons: 'Salones / Sucursales',
      settings: 'Ajustes',
      logout: 'Cerrar sesión',
      search: 'Buscar...',
      admin: 'Administrador',
      connectedSalons: 'Salones conectados',
      activeChats: 'Chats activos',
      successfulBookings: 'Reservas exitosas (Este mes)',
      enterprisePanel: 'Panel corporativo multisucursal',
      enterpriseDesc: 'El sistema está configurado para admitir múltiples salones y brindar servicios de recepcionista inteligente. Utilice el menú "Salones" para administrar sucursales y "Ajustes" para ajustar las pautas de IA.',
      addNewSalon: 'Añadir nuevo salón',
      salonName: 'Nombre del salón',
      businessIdLabel: 'ID de Negocio',
      status: 'Estado',
      actions: 'Acciones',
      active: 'Activo',
      inactive: 'Inactivo',
      aiSettings: 'Configuración de IA y sistema',
      aiDesc: 'Configure su asistente de IA, tokens de Telegram y ID de Google Calendar.',
      defaultBusinessId: 'ID de Negocio predeterminado',
      telegramToken: 'Token del bot de Telegram',
      calendarId: 'ID de Google Calendar',
      systemPrompt: 'Instrucciones dedicadas para recepcionista (System Prompt)',
      saveConfig: 'Guardar configuración',
      saved: '¡Configuración guardada exitosamente!',
      placeholderBusiness: 'ej. laser_tehran',
      placeholderPrompt: 'Comportamiento e instrucciones de la recepcionista inteligente...',
      placeholderCalendar: 'mail@group.calendar.google.com',
    },
    DE: {
      dashboard: 'Übersicht',
      salons: 'Salons / Filialen',
      settings: 'Einstellungen',
      logout: 'Abmelden',
      search: 'Suchen...',
      admin: 'Hauptadministrator',
      connectedSalons: 'Angeschlossene Salons',
      activeChats: 'Aktive Chats',
      successfulBookings: 'Erfolgreiche Buchungen (Diesen Monat)',
      enterprisePanel: 'Unternehmenspanel für mehrere Filialen',
      enterpriseDesc: 'Das System ist so konfiguriert, dass es mehrere Salons unterstützt und intelligente Empfangsdienste bereitstellt. Bitte nutzen Sie das Menü "Salons" zur Verwaltung der Filialen und das Menü "Einstellungen" zur Anpassung der KI-Richtlinien.',
      addNewSalon: 'Neuen Salon hinzufügen',
      salonName: 'Salonname',
      businessIdLabel: 'Geschäfts-ID',
      status: 'Status',
      actions: 'Aktionen',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      aiSettings: 'KI- & Systemeinstellungen',
      aiDesc: 'Konfigurieren Sie Ihren KI-Assistenten, Telegram-Token und Ihre Google Calendar-ID.',
      defaultBusinessId: 'Standard Geschäfts-ID',
      telegramToken: 'Telegram Bot Token',
      calendarId: 'Google Calendar ID',
      systemPrompt: 'Spezielle Anweisungen für Empfangsdame (System Prompt)',
      saveConfig: 'Konfiguration speichern',
      saved: 'Einstellungen erfolgreich gespeichert!',
      placeholderBusiness: 'z.B. laser_tehran',
      placeholderPrompt: 'Verhalten und Anweisungen für den smarten Empfang...',
      placeholderCalendar: 'mail@group.calendar.google.com',
    }
  };

  const t = translations[language];

  return (
    <div className="flex h-screen bg-slate-50 font-sans antialiased text-slate-800 w-full">
      {/* سایدبار ناوبری */}
      <aside className="w-64 bg-slate-900 text-slate-100 flex flex-col justify-between border-r border-slate-800 shadow-2xl">
        <div>
          <div className="h-24 flex items-center px-6 border-b border-slate-800/80 bg-slate-950/40">
            <div className="flex items-center space-x-3 space-x-reverse">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center font-black text-white text-base shadow-lg shadow-indigo-600/30">LL</div>
              <span className="text-xl font-black tracking-wider text-white">Laser Luxury</span>
            </div>
          </div>
          
          <nav className="mt-8 px-4 space-y-2">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-extrabold rounded-xl transition-all duration-300 ${
                activeTab === 'dashboard' 
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-600/20' 
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard className="w-5 h-5 ml-3" />
              <span>{t.dashboard}</span>
            </button>
            
            <button 
              onClick={() => setActiveTab('salons')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-extrabold rounded-xl transition-all duration-300 ${
                activeTab === 'salons' 
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-600/20' 
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <Building2 className="w-5 h-5 ml-3" />
              <span>{t.salons}</span>
            </button>
            
            <button 
              onClick={() => setActiveTab('settings')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-extrabold rounded-xl transition-all duration-300 ${
                activeTab === 'settings' 
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-600/20' 
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <Settings className="w-5 h-5 ml-3" />
              <span>{t.settings}</span>
            </button>
          </nav>
        </div>
        
        <div className="p-6 border-t border-slate-800/80 space-y-4">
          {/* انتخاب زبان */}
          <div className="bg-slate-950/30 p-3 rounded-xl border border-slate-800">
            <div className="flex items-center text-xs font-black text-slate-400 mb-2 px-1">
              <Globe className="w-4 h-4 ml-2 text-indigo-400" />
              <span>CHOOSE LANGUAGE</span>
            </div>
            <div className="flex justify-between gap-1">
              {(['EN', 'FA', 'SV', 'ES', 'DE'] as Language[]).map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={`text-xs font-black py-1.5 px-2 rounded-lg transition ${
                    language === lang 
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20' 
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>
          </div>

          <button className="w-full flex items-center px-4 py-3.5 text-sm font-extrabold text-slate-400 rounded-xl hover:bg-rose-500/10 hover:text-rose-400 transition-all duration-300">
            <LogOut className="w-5 h-5 ml-3" />
            <span>{t.logout}</span>
          </button>
        </div>
      </aside>

      {/* ناحیه محتوای اصلی */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* هدر */}
        <header className="h-24 bg-white border-b border-slate-200 flex items-center justify-between px-10 shadow-sm backdrop-blur-md bg-white/70 sticky top-0 z-30">
          <div className="flex items-center w-96">
            <div className="relative w-full">
              <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input 
                type="text" 
                placeholder={t.search} 
                className="w-full bg-slate-50/80 border border-slate-200 rounded-xl py-3 pr-11 pl-4 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white transition-all font-semibold text-slate-700"
              />
            </div>
          </div>
          
          <div className="flex items-center space-x-6 space-x-reverse">
            <button className="relative p-3 text-slate-600 hover:bg-indigo-50/60 rounded-xl transition-all border border-slate-100 hover:border-indigo-100 hover:text-indigo-600">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-rose-500 rounded-full animate-pulse"></span>
            </button>
            
            <div className="h-8 w-[1px] bg-slate-200"></div>
            
            <div className="flex items-center space-x-3 space-x-reverse cursor-pointer bg-slate-50 border border-slate-100 py-2 px-3.5 rounded-xl hover:bg-slate-100/80 transition">
              <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center font-black text-white border border-indigo-500/20 shadow-md shadow-indigo-500/10">A</div>
              <div className="hidden md:block text-right">
                <p className="text-sm font-black text-slate-800 tracking-tight">{t.admin}</p>
                <p className="text-xs text-indigo-600 mt-0.5 font-black tracking-wider uppercase">{language}</p>
              </div>
              <ChevronDown className="w-4 h-4 text-slate-400" />
            </div>
          </div>
        </header>

        {/* محتوای بدنه پویا */}
        <main className="p-10 max-w-7xl mx-auto w-full">
          
          {/* تب داشبورد */}
          {activeTab === 'dashboard' && (
            <div>
              <div className="mb-8">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight">{t.dashboard}</h1>
                <p className="text-slate-500 text-sm mt-2 font-semibold">{t.enterpriseDesc}</p>
              </div>

              {/* کارت‌های آماری */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm shadow-slate-100 flex flex-col justify-between h-40 relative overflow-hidden group hover:border-indigo-200 transition">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-50 rounded-bl-3xl -z-0 group-hover:scale-110 transition duration-300"></div>
                  <div className="z-10">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">{t.connectedSalons}</h3>
                    <p className="mt-4 text-5xl font-black text-slate-900 tracking-tight">12</p>
                  </div>
                  <span className="text-xs text-emerald-600 font-black z-10">↑ ۲ {t.active.toLowerCase()} مرکز جدید</span>
                </div>
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm shadow-slate-100 flex flex-col justify-between h-40 relative overflow-hidden group hover:border-violet-200 transition">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-violet-50 rounded-bl-3xl -z-0 group-hover:scale-110 transition duration-300"></div>
                  <div className="z-10">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">{t.activeChats}</h3>
                    <p className="mt-4 text-5xl font-black text-slate-900 tracking-tight">48</p>
                  </div>
                  <span className="text-xs text-violet-600 font-black z-10">• نظارت به صورت زنده</span>
                </div>
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm shadow-slate-100 flex flex-col justify-between h-40 relative overflow-hidden group hover:border-emerald-200 transition">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50 rounded-bl-3xl -z-0 group-hover:scale-110 transition duration-300"></div>
                  <div className="z-10">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">{t.successfulBookings}</h3>
                    <p className="mt-4 text-5xl font-black text-slate-900 tracking-tight">184</p>
                  </div>
                  <span className="text-xs text-emerald-600 font-black z-10">۱۲٪ رشد نسبت به ماه قبل</span>
                </div>
              </div>

              {/* اعلان سیستم */}
              <div className="bg-gradient-to-tr from-slate-900 via-indigo-950 to-slate-900 rounded-3xl p-10 text-white shadow-2xl relative overflow-hidden border border-slate-800">
                <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full filter blur-3xl transform translate-x-1/4 -translate-y-1/4"></div>
                <div className="flex items-center space-x-3 space-x-reverse mb-5">
                  <ShieldCheck className="w-8 h-8 text-emerald-400" />
                  <h2 className="text-xl font-black tracking-tight">{t.enterprisePanel}</h2>
                </div>
                <p className="text-slate-300 text-sm max-w-3xl leading-relaxed font-semibold">
                  {t.enterpriseDesc}
                </p>
              </div>
            </div>
          )}

          {/* تب سالن‌ها */}
          {activeTab === 'salons' && (
            <div>
              <div className="mb-8">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight">{t.salons}</h1>
                <p className="text-slate-500 text-sm mt-2 font-semibold">مدیریت تمامی شعبه‌ها، کلینیک‌ها و وضعیت فعالیت آن‌ها.</p>
              </div>

              {/* فرم افزودن سالن جدید */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8 mb-10 max-w-4xl">
                <h2 className="text-base font-black text-slate-900 mb-6 tracking-tight flex items-center">
                  <Plus className="w-5 h-5 ml-2 text-indigo-600" />
                  {t.addNewSalon}
                </h2>
                <form onSubmit={handleAddSalon} className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                  <div>
                    <label className="block text-xs font-black text-slate-600 tracking-wider uppercase">{t.salonName}</label>
                    <input 
                      type="text" 
                      value={newSalonName}
                      onChange={(e) => setNewSalonName(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 text-sm font-semibold text-slate-700 bg-slate-50/40" 
                      placeholder="Laser Luxury Tehran" 
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-black text-slate-600 tracking-wider uppercase">{t.businessIdLabel}</label>
                    <input 
                      type="text" 
                      value={newBusinessId}
                      onChange={(e) => setNewBusinessId(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 text-sm font-semibold text-slate-700 bg-slate-50/40 font-mono" 
                      placeholder="laser_tehran" 
                      required
                    />
                  </div>
                  <button type="submit" className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white py-3 rounded-xl font-extrabold hover:brightness-110 shadow-lg shadow-indigo-500/10 transition duration-200 text-sm">
                    {t.addNewSalon}
                  </button>
                </form>
              </div>

              {/* لیست سالن‌ها */}
              <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm overflow-hidden">
                <table className="w-full border-collapse text-right text-sm">
                  <thead>
                    <tr className="bg-slate-50/70 text-slate-600 font-black border-b border-slate-200/80">
                      <th className="py-6 px-8">{t.salonName}</th>
                      <th className="py-6 px-4">{t.businessIdLabel}</th>
                      <th className="py-6 px-4">{t.status}</th>
                      <th className="py-6 px-8 text-left">{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700 font-bold">
                    {salons.map((salon) => (
                      <tr key={salon.id} className="hover:bg-slate-50/60 transition">
                        <td className="py-6 px-8 text-slate-900 font-extrabold">{salon.name}</td>
                        <td className="py-6 px-4">
                          <span className="font-mono text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-1.5 tracking-tight">
                            {salon.businessId}
                          </span>
                        </td>
                        <td className="py-6 px-4">
                          <span className={`inline-flex items-center px-3.5 py-1.5 rounded-xl text-xs font-black ${
                            salon.status === 'active' 
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                              : 'bg-slate-100 text-slate-500 border border-slate-200'
                          }`}>
                            {salon.status === 'active' ? t.active : t.inactive}
                          </span>
                        </td>
                        <td className="py-6 px-8 text-left space-x-3 space-x-reverse">
                          <button className="p-2.5 text-slate-400 hover:text-indigo-600 rounded-xl hover:bg-indigo-50 transition border border-slate-50/30 hover:border-indigo-100">
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => handleDeleteSalon(salon.id)} 
                            className="p-2.5 text-slate-400 hover:text-rose-600 rounded-xl hover:bg-rose-50 transition border border-slate-50/30 hover:border-rose-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* تب تنظیمات */}
          {activeTab === 'settings' && (
            <div>
              <div className="mb-8">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight">{t.aiSettings}</h1>
                <p className="text-slate-500 text-sm mt-2 font-semibold">{t.aiDesc}</p>
              </div>

              <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-10 max-w-4xl">
                <form onSubmit={handleSaveConfig} className="space-y-8">
                  <div>
                    <label className="block text-sm font-black text-slate-800 tracking-tight">{t.defaultBusinessId}</label>
                    <input 
                      type="text" 
                      value={businessId}
                      onChange={(e) => setBusinessId(e.target.value)}
                      className="mt-3 block w-full rounded-xl border-slate-200 shadow-sm p-4 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 text-sm bg-slate-50/40 font-semibold text-slate-700" 
                      placeholder={t.placeholderBusiness} 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-800 tracking-tight">{t.telegramToken}</label>
                    <input 
                      type="text" 
                      value={telegramToken}
                      onChange={(e) => setTelegramToken(e.target.value)}
                      className="mt-3 block w-full rounded-xl border-slate-200 shadow-sm p-4 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 text-sm bg-slate-50/40 font-semibold text-slate-700 font-mono" 
                      placeholder="123456789:ABCdef..." 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-800 tracking-tight">{t.calendarId}</label>
                    <input 
                      type="text" 
                      value={calendarId}
                      onChange={(e) => setCalendarId(e.target.value)}
                      className="mt-3 block w-full rounded-xl border-slate-200 shadow-sm p-4 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 text-sm bg-slate-50/40 font-semibold text-slate-700 font-mono" 
                      placeholder={t.placeholderCalendar} 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-800 tracking-tight">{t.systemPrompt}</label>
                    <textarea 
                      rows={6}
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="mt-3 block w-full rounded-xl border-slate-200 shadow-sm p-4 border focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 text-sm bg-slate-50/40 font-semibold text-slate-700" 
                      placeholder={t.placeholderPrompt}
                    ></textarea>
                  </div>
                  <div className="flex justify-end pt-4 border-t border-slate-100">
                    <button type="submit" className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-10 py-4 rounded-2xl font-black hover:brightness-110 shadow-xl shadow-indigo-500/15 transition duration-200 text-sm tracking-wide">
                      {t.saveConfig}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
