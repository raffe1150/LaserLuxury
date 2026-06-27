import React, { useState } from 'react';
import { LayoutDashboard, Building2, Settings, LogOut, Bell, Search, ChevronDown, Plus, Edit2, Trash2, ShieldCheck } from 'lucide-react';

interface Salon {
  id: string;
  name: string;
  businessId: string;
  status: 'active' | 'inactive';
}

export default function App() {
  throw new Error("APP TSX IS RUNNING");
  const [activeTab, setActiveTab] = useState<'dashboard' | 'salons' | 'settings'>('dashboard');
  
  const [businessId, setBusinessId] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const [salons, setSalons] = useState<Salon[]>([
    { id: '1', name: 'Laser Luxury Tehran', businessId: 'laser_tehran', status: 'active' },
    { id: '2', name: 'Beauty Clinic Zafaranieh', businessId: 'beauty_zaf', status: 'active' },
    { id: '3', name: 'Laser Center Isfahan', businessId: 'laser_esf', status: 'inactive' }
  ]);

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    alert('Settings saved successfully!');
  };

  return (
    <div className="flex h-screen bg-slate-100 font-sans antialiased text-slate-800">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-slate-900 text-slate-100 flex flex-col justify-between border-r border-slate-800">
        <div>
          <div className="h-20 flex items-center px-6 border-b border-slate-800/80">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center font-bold text-white text-lg shadow-md shadow-violet-600/30">LL</div>
              <span className="text-xl font-bold tracking-wider text-white">Laser Luxury</span>
            </div>
          </div>
          
          <nav className="mt-8 px-4 space-y-2">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
                activeTab === 'dashboard' 
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard className="w-5 h-5 ml-3" />
              <span>Dashboard</span>
            </button>
            
            <button 
              onClick={() => setActiveTab('salons')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
                activeTab === 'salons' 
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Building2 className="w-5 h-5 ml-3" />
              <span>Salonger / Företag</span>
            </button>
            
            <button 
              onClick={() => setActiveTab('settings')}
              className={`w-full flex items-center px-4 py-3.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
                activeTab === 'settings' 
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Settings className="w-5 h-5 ml-3" />
              <span>Inställningar</span>
            </button>
          </nav>
        </div>
        
        <div className="p-6 border-t border-slate-800/80">
          <button className="w-full flex items-center px-4 py-3 text-sm font-semibold text-slate-400 rounded-xl hover:bg-rose-500/10 hover:text-rose-400 transition-all duration-200">
            <LogOut className="w-5 h-5 ml-3" />
            <span>Logga ut</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Header */}
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-10 shadow-sm">
          <div className="flex items-center w-96">
            <div className="relative w-full">
              <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input 
                type="text" 
                placeholder="Sök..." 
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 pr-11 pl-4 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:bg-white transition-all"
              />
            </div>
          </div>
          
          <div className="flex items-center space-x-6 space-x-reverse">
            <button className="relative p-2 text-slate-600 hover:bg-slate-50 rounded-xl transition-all border border-slate-100">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2 right-2 w-2 h-2 bg-rose-500 rounded-full animate-pulse"></span>
            </button>
            
            <div className="h-8 w-[1px] bg-slate-200"></div>
            
            <div className="flex items-center space-x-3 space-x-reverse cursor-pointer">
              <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center font-bold text-violet-700 border border-violet-100">A</div>
              <div className="hidden md:block text-right">
                <p className="text-sm font-extrabold text-slate-800">System Admin</p>
                <p className="text-xs text-slate-400 mt-0.5 font-medium">Ägare</p>
              </div>
              <ChevronDown className="w-4 h-4 text-slate-400" />
            </div>
          </div>
        </header>

        {/* Dynamic Body Content */}
        <main className="p-10 max-w-7xl mx-auto w-full">
          
          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div>
              <div className="mb-8">
                <h1 className="text-2.5xl font-black text-slate-900 tracking-tight">Multi-Tenant AI Dashboard</h1>
                <p className="text-slate-500 text-sm mt-1.5">Fullständig översikt och hantering av AI-tjänster och anslutna salonger.</p>
              </div>

              {/* Statistics Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm flex flex-col justify-between h-36">
                  <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">Anslutna salonger</h3>
                    <p className="mt-3 text-4.5xl font-black text-slate-900 tracking-tight">12</p>
                  </div>
                  <span className="text-xs text-emerald-600 font-bold flex items-center">↑ 2 nya center den här månaden</span>
                </div>
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm flex flex-col justify-between h-36">
                  <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">Aktiva konversationer</h3>
                    <p className="mt-3 text-4.5xl font-black text-slate-900 tracking-tight">48</p>
                  </div>
                  <span className="text-xs text-violet-600 font-bold">Övervakning i realtid</span>
                </div>
                <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm flex flex-col justify-between h-36">
                  <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider">Bokade tider (denna månad)</h3>
                    <p className="mt-3 text-4.5xl font-black text-slate-900 tracking-tight">184</p>
                  </div>
                  <span className="text-xs text-emerald-600 font-bold">12% ökning jämfört med förra månaden</span>
                </div>
              </div>

              {/* System Notice */}
              <div className="bg-gradient-to-br from-slate-900 to-indigo-950 rounded-2xl p-8 text-white shadow-xl relative overflow-hidden border border-slate-800">
                <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full filter blur-3xl transform translate-x-1/4 -translate-y-1/4"></div>
                <div className="flex items-center space-x-3 space-x-reverse mb-4">
                  <ShieldCheck className="w-7 h-7 text-emerald-400" />
                  <h2 className="text-lg font-extrabold tracking-tight">Enterprise Multi-Företagssystem</h2>
                </div>
                <p className="text-slate-300 text-sm max-w-3xl leading-relaxed font-medium">
                  Systemet är konfigurerat för att stödja flera salonger och sköta kundtjänst och bokningar professionellt. Vänligen gå till "Salonger / Företag" för att lägga till eller hantera dina anslutna center och ställa in AI:ns instruktioner.
                </p>
              </div>
            </div>
          )}

          {/* Salons Tab */}
          {activeTab === 'salons' && (
            <div>
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h1 className="text-2.5xl font-black text-slate-900 tracking-tight">Salonger / Företag</h1>
                  <p className="text-slate-500 text-sm mt-1.5">Hantera alla anslutna salonger, klinikplatser och deras status.</p>
                </div>
                <button className="flex items-center bg-violet-600 text-white px-6 py-3 rounded-xl font-extrabold hover:bg-violet-700 shadow-lg shadow-violet-500/10 transition duration-200 text-sm">
                  <Plus className="w-4 h-4 ml-2" />
                  Lägg till ny salong
                </button>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
                <table className="w-full border-collapse text-right text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 font-black border-b border-slate-200">
                      <th className="py-5 px-8">Salongens namn</th>
                      <th className="py-5 px-4">Företags-ID (Business ID)</th>
                      <th className="py-5 px-4">Status</th>
                      <th className="py-5 px-8 text-left">Åtgärder</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700 font-semibold">
                    {salons.map((salon) => (
                      <tr key={salon.id} className="hover:bg-slate-50/60 transition">
                        <td className="py-5 px-8 text-slate-900">{salon.name}</td>
                        <td className="py-5 px-4">
                          <span className="font-mono text-xs text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5 tracking-tight">
                            {salon.businessId}
                          </span>
                        </td>
                        <td className="py-5 px-4">
                          <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-black ${
                            salon.status === 'active' 
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                              : 'bg-slate-100 text-slate-500 border border-slate-200'
                          }`}>
                            {salon.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                          </span>
                        </td>
                        <td className="py-5 px-8 text-left space-x-3 space-x-reverse">
                          <button className="p-2 text-slate-400 hover:text-violet-600 rounded-lg hover:bg-violet-50 transition border border-slate-50 hover:border-violet-100">
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button className="p-2 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition border border-slate-50 hover:border-rose-100">
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

          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div>
              <div className="mb-8">
                <h1 className="text-2.5xl font-black text-slate-900 tracking-tight">AI & Systeminställningar</h1>
                <p className="text-slate-500 text-sm mt-1.5">Konfigurera AI-assistenter, API-nycklar och integrationer (Telegram, Google Calendar, etc.)</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8 max-w-4xl">
                <form onSubmit={handleSaveConfig} className="space-y-6">
                  <div>
                    <label className="block text-sm font-black text-slate-700 tracking-tight">Standard Företags-ID (Default Business ID)</label>
                    <input 
                      type="text" 
                      value={businessId}
                      onChange={(e) => setBusinessId(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3.5 border focus:ring-2 focus:ring-violet-500 focus:border-violet-500 text-sm bg-slate-50/40 font-medium" 
                      placeholder="t.ex. laser_stockholm" 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-700 tracking-tight">Telegram Bot Token</label>
                    <input 
                      type="text" 
                      value={telegramToken}
                      onChange={(e) => setTelegramToken(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3.5 border focus:ring-2 focus:ring-violet-500 focus:border-violet-500 text-sm bg-slate-50/40 font-medium font-mono" 
                      placeholder="123456789:ABCdef..." 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-700 tracking-tight">Google Calendar ID</label>
                    <input 
                      type="text" 
                      value={calendarId}
                      onChange={(e) => setCalendarId(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3.5 border focus:ring-2 focus:ring-violet-500 focus:border-violet-500 text-sm bg-slate-50/40 font-medium font-mono" 
                      placeholder="mail@group.calendar.google.com" 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-black text-slate-700 tracking-tight">Anpassad System Prompt (Core Brain)</label>
                    <textarea 
                      rows={8}
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="mt-2 block w-full rounded-xl border-slate-200 shadow-sm p-3.5 border focus:ring-2 focus:ring-violet-500 focus:border-violet-500 text-sm bg-slate-50/40 font-medium" 
                      placeholder="Skriv instruktioner för din AI-assistent..." 
                    ></textarea>
                  </div>
                  <div className="flex justify-end pt-4 border-t border-slate-100">
                    <button type="submit" className="bg-violet-600 text-white px-8 py-3.5 rounded-xl font-extrabold hover:bg-violet-700 shadow-lg shadow-violet-500/15 transition duration-200 text-sm">
                      Spara konfiguration
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
