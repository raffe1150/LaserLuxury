import React, { useState } from 'react';

export default function App() {
  const [businessId, setBusinessId] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    // اینجا می توانید اتصال به API دیتابیس (Supabase یا اندپوینت شما) را قرار دهید
    console.log('Saved:', { businessId, telegramToken, calendarId, systemPrompt });
    alert('تنظیمات با موفقیت ذخیره شد!');
  };

  return (
    <div className="flex h-screen bg-gray-50 font-sans antialiased text-gray-800">
      {/* سایدبار ناوبری */}
      <aside className="w-64 bg-indigo-950 text-white flex flex-col justify-between shadow-xl">
        <div>
          <div className="h-20 flex items-center px-8 border-b border-indigo-800/50">
            <span className="text-xl font-bold tracking-wider text-white">Laser Luxury</span>
          </div>
          <nav className="mt-8 px-4 space-y-1">
            <a href="#" className="flex items-center px-4 py-3 text-sm font-medium rounded-lg bg-indigo-900 text-white">
              <span className="ml-3"> داشبورد</span>
            </a>
            <a href="#" className="flex items-center px-4 py-3 text-sm font-medium rounded-lg text-indigo-200 hover:bg-indigo-900/40">
              <span className="ml-3"> سالن‌ها / مراکز</span>
            </a>
            <a href="#" className="flex items-center px-4 py-3 text-sm font-medium rounded-lg text-indigo-200 hover:bg-indigo-900/40">
              <span className="ml-3"> تنظیمات سیستم</span>
            </a>
          </nav>
        </div>
        <div className="p-6 border-t border-indigo-800/50 text-xs text-indigo-300">
          پنل مدیریت انحصاری
        </div>
      </aside>

      {/* محتوای اصلی */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-20 bg-white border-b border-gray-200 flex items-center justify-between px-10 shadow-sm">
          <h1 className="text-2xl font-semibold text-gray-900">داشبورد مدیریت یکپارچه</h1>
          <div className="flex items-center space-x-4">
            <span className="text-sm font-medium text-gray-600">مدیرسیستم</span>
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center font-semibold text-indigo-700">
              A
            </div>
          </div>
        </header>

        <main className="p-10 max-w-5xl">
          {/* کارت‌های آماری */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
            <div className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">مراکز فعال</h3>
              <p className="mt-4 text-4xl font-extrabold text-gray-900">12</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">کل مکالمات</h3>
              <p className="mt-4 text-4xl font-extrabold text-gray-900">48</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">رزروهای موفق ماه</h3>
              <p className="mt-4 text-4xl font-extrabold text-gray-900">184</p>
            </div>
          </div>

          {/* فرم تنظیمات اختصاصی */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <h2 className="text-xl font-bold text-gray-900 mb-6 border-b pb-4">پیکربندی هوش مصنوعی سالن</h2>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-bold text-gray-700">شناسه کسب‌وکار (Business ID)</label>
                <input 
                  type="text" 
                  value={businessId}
                  onChange={(e) => setBusinessId(e.target.value)}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" 
                  placeholder="مثال: laser_luxury_tehran" 
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700">توکن ربات تلگرام (Telegram Bot Token)</label>
                <input 
                  type="text" 
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" 
                  placeholder="123456789:ABCdef..." 
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700">شناسه تقویم گوگل (Google Calendar ID)</label>
                <input 
                  type="text" 
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" 
                  placeholder="mail@group.calendar.google.com" 
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700">شخصیت و دستورالعمل‌ها (System Prompt)</label>
                <textarea 
                  rows="6" 
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" 
                  placeholder="متن سیستم پراMPT منشی اختصاصی را اینجا قرار دهید..." 
                ></textarea>
              </div>
              <div className="flex justify-end pt-4 border-t">
                <button type="submit" className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 shadow-md transition duration-200">
                  ذخیره تنظیمات
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
