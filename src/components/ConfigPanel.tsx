import React from 'react';
import { AgentConfig } from '../types';

interface ConfigPanelProps {
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
  isActivated: boolean;
  onToggleActivation: () => void;
  onSaveSettings: () => void;
}

export function ConfigPanel({ config, onConfigChange, isActivated, onToggleActivation, onSaveSettings }: ConfigPanelProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    onConfigChange({ ...config, [name]: value });
  };

  return (
    <aside className="w-full h-full bg-white border-r border-slate-200 flex flex-col p-6 shadow-[2px_0_10px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div className="font-[800] text-[20px] text-indigo-600 tracking-[-0.5px]">LASER LUXURY</div>
        <span className="text-[10px] text-slate-400">GÖTEBORG v1.2</span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-[14px]">
        {/* Core Credentials */}
        <div className="mb-[14px]">
          <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
            Google AI Studio API Key
          </label>
          <input
            type="password"
            name="apiKey"
            value={config.apiKey}
            onChange={handleChange}
            disabled={isActivated}
            placeholder="Enter API Key..."
            className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="mb-[14px]">
          <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
            Instagram Webhook Token
          </label>
          <input
            type="password"
            name="instagramToken"
            value={config.instagramToken}
            onChange={handleChange}
            disabled={isActivated}
            placeholder="Enter Instagram Token..."
            className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="mb-[14px]">
          <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
            Telegram Bot Token
          </label>
          <input
            type="password"
            name="telegramToken"
            value={config.telegramToken}
            onChange={handleChange}
            disabled={isActivated}
            placeholder="Enter Bot Token..."
            className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* System Prompt */}
        <div className="mb-[14px]">
          <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
            System Prompt (Core Brain)
          </label>
          <textarea
            name="systemPrompt"
            value={config.systemPrompt}
            onChange={handleChange}
            disabled={isActivated}
            className="w-full h-[220px] resize-none leading-[1.4] px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Calendar Integration */}
        <div className="mt-6 mb-2 border-t border-slate-200 pt-4">
          <label className="block text-[12px] font-[800] text-slate-700 mb-[10px] tracking-[0.5px]">
            Calendar Adapter
          </label>
          
          <div className="mb-[14px]">
            <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
              Provider Mode
            </label>
            <select
              name="calendarProvider"
              value={config.calendarProvider || 'google'}
              onChange={handleChange as any}
              disabled={isActivated}
              className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            >
              <option value="google">Google Calendar (Live)</option>
              <option value="mock">Built-in Mock Storage</option>
              <option value="custom">Custom Remote Adapter API (Webhooks)</option>
            </select>
          </div>

          {config.calendarProvider === 'custom' && (
            <>
              <div className="mb-[14px]">
                <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
                  Adapter API URL
                </label>
                <input
                  type="text"
                  name="calendarApiUrl"
                  value={config.calendarApiUrl || ''}
                  onChange={handleChange}
                  disabled={isActivated}
                  placeholder="https://your-server.com/calendar"
                  className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
                />
              </div>
              <div className="mb-[14px]">
                <label className="block text-[10px] font-[700] uppercase text-slate-500 mb-[6px] tracking-[0.5px]">
                  Adapter API Key / Token
                </label>
                <input
                  type="password"
                  name="calendarApiKey"
                  value={config.calendarApiKey || ''}
                  onChange={handleChange}
                  disabled={isActivated}
                  placeholder="Secret Key or Bearer Token..."
                  className="w-full px-[14px] py-[10px] border border-slate-300 rounded-[8px] text-[13px] box-border bg-slate-50 transition-colors duration-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-[10px] flex flex-col gap-[10px] shrink-0">
        <button
          onClick={onSaveSettings}
          disabled={isActivated}
          className="w-full bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 p-[12px] rounded-[10px] font-[600] cursor-pointer flex items-center justify-center gap-2 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save Settings 💾
        </button>
        <button
          onClick={onToggleActivation}
          className="w-full bg-indigo-500 hover:bg-indigo-600 text-white p-[14px] border-none rounded-[10px] font-[600] cursor-pointer flex items-center justify-center gap-2 text-[15px] transition-colors"
        >
          {isActivated ? 'Deactivate 🛑' : 'Activate Agent 🚀'}
        </button>
      </div>
    </aside>
  );
}
