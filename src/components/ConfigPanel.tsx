import React from 'react';
import { AgentConfig } from '../types';

interface ConfigPanelProps {
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
  IsActivated: boolean;
  OnToggleActivation: () => void;
  OnSaveSettings: () => void;
}

export function ConfigPanel({ config, onConfigChange, isActivated, onToggleActivation, onSaveSettings }: ConfigPanelProps) {
  Const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    Const { name, value } = e.target;
    OnConfigChange({ ...config, [name]: value });
  };

  Return (
    <div className="flex h-screen w-full bg-slate-50 font-sans antialiased text-slate-800">
      {/* سایدبار ناوبری مدرن */}
      <aside className="w-64 bg-indigo-950 text-white flex flex-col justify-between shadow-2xl shrink-0">
        <div>
          <div className="h-20 flex items-center px-8 border-b border-indigo-800/50">
            <span className="text-xl font-extrabold tracking-wider text-white">Laser Luxury</span>
          </div>
          <nav className="mt-8 px-4 space-y-2">
            <a href="#" className="flex items-center px-4 py-3 text-sm font-bold rounded-xl bg-indigo-900 text-white shadow-sm">
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v12a1 1 0 001 1h3m10-11l2 2m-2-2v12a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
              داشبورد مدیریت
            </a>
            <a href="#" className="flex items-center px-4 py-3 text-sm font-medium rounded-xl text-indigo-200 hover:bg-indigo-900/40 transition">
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
              مراکز / سالن‌ها
            </a>
            <a href="#" className="flex items-center px-4 py-3 text-sm font-medium rounded-xl text-indigo-200 hover:bg-indigo-900/40 transition">
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
              تنظیمات سیستم
            </a>
          </nav>
        </div>
        <div className="p-6 border-t border-indigo-800/50 text-xs text-indigo-300">
          پنل انحصاری سطح سازمانی
        </div>
      </aside>

      {/* محتوای اصلی داشبورد */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-10 shadow-sm shrink-0">
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">داشبورد مدیریت یکپارچه (Zendesk / Intercom Style)</h1>
          <div className="flex items-center space-x-4">
            <span className="text-sm font-bold text-slate-600">مدیر سیستم</span>
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center font-extrabold text-indigo-700 ring-2 ring-indigo-600/20">
              A
            </div>
          </div>
        </header>

        <main className="p-10 max-w-6xl">
          {/* کارت‌های آماری (KPI Cards) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
              <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">مراکز فعال متصل</h3>
              <p className="mt-4 text-5xl font-black text-slate-900 tracking-tight">24</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
              <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">کل مکالمات هوش‌مصنوعی</h3>
              <p className="mt-4 text-5xl font-black text-slate-900 tracking-tight">384</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
              <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">رزروهای موفق این ماه</h3>
              <p className="mt-4 text-5xl font-black text-indigo-600 tracking-tight">1,492</p>
            </div>
          </div>

          {/* فرم تنظیمات و پیکربندی */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10">
            <div className="flex justify-between items-center border-b border-slate-100 pb-6 mb-8">
              <div>
                <h2 className="text-xl font-black text-slate-900">پیکربندی هوش مصنوعی (AI Brain Engine)</h2>
                <p className="text-xs text-slate-500 mt-1">مدیریت کلیدهای API، توکن‌ها و سیستم پراMPT اختصاصی سالن</p>
              </div>
              <span className="bg-slate-100 text-slate-600 px-4 py-2 rounded-xl text-xs font-bold tracking-wider">GÖTEBORG v2.0</span>
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Google AI Studio API Key</label>
                  <input
                    type="password"
                    name="apiKey"
                    value={config.apiKey}
                    onChange={handleChange}
                    disabled={isActivated}
                    placeholder="AI_KEY_..."
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Instagram Webhook Token</label>
                  <input
                    type="password"
                    name="instagramToken"
                    value={config.instagramToken}
                    onChange={handleChange}
                    disabled={isActivated}
                    placeholder="IG_TOKEN_..."
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Telegram Bot Token</label>
                <input
                  type="password"
                  name="telegramToken"
                  value={config.telegramToken}
                  onChange={handleChange}
                  disabled={isActivated}
                  placeholder="123456789:ABCdef..."
                  className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">System Prompt (هوش و شخصیت منشی)</label>
                <textarea
                  name="systemPrompt"
                  value={config.systemPrompt}
                  onChange={handleChange}
                  disabled={isActivated}
                  rows={6}
                  className="w-full resize-none leading-relaxed px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                />
              </div>

              <div className="border-t border-slate-100 pt-6 mt-2">
                <label className="block text-base font-black text-slate-900 mb-4">تنظیمات تقویم (Calendar Adapter)</label>
                
                <div>
                  <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Provider Mode</label>
                  <select
                    name="calendarProvider"
                    value={config.calendarProvider || 'google'}
                    onChange={handleChange as any}
                    disabled={isActivated}
                    className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-bold"
                  >
                    <option value="google">Google Calendar (Live)</option>
                    <option value="mock">Built-in Mock Storage</option>
                    <option value="custom">Custom Remote Adapter API (Webhooks)</option>
                  </select>
                </div>

                {config.calendarProvider === 'custom' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                    <div>
                      <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Adapter API URL</label>
                      <input
                        type="text"
                        name="calendarApiUrl"
                        value={config.calendarApiUrl || ''}
                        onChange={handleChange}
                        disabled={isActivated}
                        placeholder="https://server.com/calendar"
                        className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-black uppercase text-slate-600 tracking-wider mb-2">Adapter API Key / Token</label>
                      <input
                        type="password"
                        name="calendarApiKey"
                        value={config.calendarApiKey || ''}
                        onChange={handleChange}
                        disabled={isActivated}
                        placeholder="Bearer Token..."
                        className="w-full px-4 py-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50 transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:outline-none disabled:opacity-50 font-medium"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-10 flex flex-col md:flex-row gap-4 justify-end border-t border-slate-100 pt-8">
              <button
                onClick={onSaveSettings}
                disabled={isActivated}
                className="w-full md:w-56 bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 py-4 rounded-xl font-extrabold shadow-sm transition flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ذخیره تنظیمات 💾
              </button>
              <button
                onClick={onToggleActivation}
                className={`w-full md:w-64 py-4 border-none rounded-xl font-black text-white shadow-lg transition flex items-center justify-center gap-2 text-sm ${
                  isActivated 
                    ? 'bg-rose-600 hover:bg-rose-700 ring-4 ring-rose-600/10' 
                    : 'bg-indigo-600 hover:bg-indigo-700 ring-4 ring-indigo-600/10'
                }`}
              >
                {isActivated ? 'غیرفعال‌سازی ایجنت 🛑' : 'فعال‌سازی ایجنت 🚀'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
