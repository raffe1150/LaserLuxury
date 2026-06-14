import React, { useState, useRef, useEffect } from 'react';
import { Message } from '../types';
import { Mic, CalendarPlus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ChatSandboxProps {
  messages: Message[];
  isActivated: boolean;
  isTyping: boolean;
  onSendMessage: (text: string, audioData?: string, audioMimeType?: string) => void;
  onTranscribeAudio: (audioData: string, mimeType: string) => Promise<string>;
  toastMessage: string | null;
}

export function ChatSandbox({ messages, isActivated, isTyping, onSendMessage, onTranscribeAudio, toastMessage }: ChatSandboxProps) {
  const [inputText, setInputText] = useState('');
  const [isMicActive, setIsMicActive] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, toastMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !isActivated) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleMicClick = async () => {
    if (!isActivated || isTyping || isTranscribing) return;
    
    if (isMicActive) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Use standard webm but gracefully fallback if not supported
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4'; // Fallback for Safari
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = ''; // Let browser choose default
        }
      }
      
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setIsMicActive(false);
        setIsTranscribing(true);

        const activeMimeType = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(chunksRef.current, { type: activeMimeType });
        
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());

        // Convert blob to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64data = reader.result as string;
          const base64Audio = base64data.split(',')[1];
          
          const text = await onTranscribeAudio(base64Audio, activeMimeType);
          setIsTranscribing(false);
          
          if (text) {
            onSendMessage(text, base64Audio, activeMimeType);
          }
        };
      };

      mediaRecorder.start();
      setIsMicActive(true);
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      alert("Failed to access microphone. Please ensure you have granted permission.");
      setIsMicActive(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col bg-slate-100 h-full relative overflow-hidden">
      {/* Header */}
      <div className="h-[64px] bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0 z-10">
        <div className="flex flex-col">
          <span className="font-[700] text-[14px]">Multi-Channel Sandbox</span>
          <span className="text-[11px] text-slate-500">IG / Telegram / Web Live Test</span>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-[20px] text-[12px] font-[600] border ${
          isActivated 
            ? 'bg-emerald-50 text-emerald-600 border-emerald-100' 
            : 'bg-red-50 text-red-500 border-red-100'
        }`}>
          <div className="w-2 h-2 rounded-full bg-current" />
          <span>{isActivated ? 'Active 🟢' : 'Offline 🔴'}</span>
        </div>
      </div>

      {/* Floating System Toast */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute top-24 left-1/2 -translate-x-1/2 z-20"
          >
            <div className="px-4 py-3 bg-slate-800/95 backdrop-blur shadow-2xl rounded-2xl flex items-center gap-3 border border-slate-700">
              <CalendarPlus className="text-emerald-400" size={20} />
              <p className="text-sm font-medium text-white tracking-wide">{toastMessage}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages Area */}
      <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-4 bg-[radial-gradient(#E2E8F0_1px,transparent_1px)] bg-[size:24px_24px] pb-[100px] scroll-smooth">
        {!isActivated && messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-4 border border-slate-200 shadow-sm">
              <LockIcon />
            </div>
            <h3 className="text-slate-800 font-semibold mb-2">Sandbox Locked</h3>
            <p className="text-sm text-slate-500 max-w-sm leading-relaxed">
              Configure your credentials on the left panel and click "Activate Agent" to start interacting.
            </p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`max-w-[70%] px-[18px] py-[12px] rounded-[16px] text-[14px] leading-[1.5] shadow-[0_1px_2px_rgba(0,0,0,0.05)] flex flex-col ${
                msg.role === 'user'
                  ? 'bg-emerald-500 text-white self-end rounded-br-[4px]'
                  : 'bg-white text-slate-800 self-start rounded-bl-[4px] border border-slate-200'
              }`}
            >
              <span>{msg.text}</span>
              {msg.audioData && (
                <CustomAudioPlayer audioData={msg.audioData} mimeType={msg.audioMimeType || 'audio/wav'} role={msg.role} />
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {isTyping && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-[70%] px-[18px] py-[16px] bg-white rounded-[16px] rounded-bl-[4px] border border-slate-200 shadow-[0_1px_2px_rgba(0,0,0,0.05)] self-start flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} />
          </motion.div>
        )}
        <div ref={messagesEndRef} className="h-4" />
      </div>

      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 h-[84px] bg-white border-t border-slate-200 flex items-center px-6 gap-3 shrink-0">
        <form onSubmit={handleSubmit} className="w-full flex items-center gap-3">
          <button
            type="button"
            onClick={handleMicClick}
            disabled={!isActivated || isTyping || isTranscribing}
            className={`w-[44px] h-[44px] rounded-full border-none bg-slate-100 flex items-center justify-center cursor-pointer transition-colors shrink-0 ${
              isMicActive 
                ? 'bg-red-50 text-red-500' // Using minimal styling instead of scale for sleek look
                : 'text-slate-500 hover:bg-slate-200 hover:text-indigo-600 disabled:opacity-50 disabled:hover:bg-slate-100 disabled:hover:text-slate-500'
            }`}
          >
            <Mic size={20} className={isMicActive ? 'animate-pulse' : ''} />
          </button>
          <input
             type="text"
             value={inputText}
             onChange={(e) => setInputText(e.target.value)}
             disabled={!isActivated || isTyping || isTranscribing}
             placeholder={isTranscribing ? "Transcribing audio..." : isActivated ? "Type in Swedish, English or Persian..." : "Agent disabled..."}
             className="flex-1 bg-slate-100 border-none px-[20px] py-[12px] rounded-[24px] outline-none text-[14px] disabled:opacity-50"
           />
           <button
             type="submit"
             disabled={!isActivated || !inputText.trim() || isTyping || isTranscribing}
             className="px-4 py-2.5 rounded-[20px] bg-emerald-500 text-white font-bold cursor-pointer hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:hover:bg-emerald-500 shrink-0"
           >
            Send
          </button>
        </form>
      </div>
    </main>
  );
}

function CustomAudioPlayer({ audioData, mimeType, role = 'agent' }: { audioData: string, mimeType: string, role?: 'user' | 'agent' }) {
  const [audioUrl, setAudioUrl] = useState<string>('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(role === 'agent');

  useEffect(() => {
    try {
      if (!audioData) return;

      if (mimeType?.includes("audio/l16") || mimeType?.includes("audio/pcm")) {
        let sampleRate = 24000;
        const rateMatch = mimeType.match(/rate=(\d+)/);
        if (rateMatch) {
            sampleRate = parseInt(rateMatch[1], 10);
        }

        const binaryStr = atob(audioData);
        const len = binaryStr.length;
        const pcmBytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            pcmBytes[i] = binaryStr.charCodeAt(i);
        }

        const wavBytes = new Uint8Array(44 + len);
        const view = new DataView(wavBytes.buffer);

        const writeString = (offset: number, string: string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + len, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // Channels
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // ByteRate
        view.setUint16(32, 2, true); // BlockAlign
        view.setUint16(34, 16, true); // BitsPerSample
        writeString(36, 'data');
        view.setUint32(40, len, true);
        
        wavBytes.set(pcmBytes, 44);
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);

        return () => URL.revokeObjectURL(url);
      } else {
        const binaryStr = atob(audioData);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);

        return () => {
          URL.revokeObjectURL(url);
        };
      }
    } catch (e) {
      console.error("Failed to decode audio data", e);
    }
  }, [audioData, mimeType]);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  if (!audioUrl) return null;

  return (
      <div className={`mt-3 flex items-center gap-3 rounded-full py-1.5 px-2 shadow-sm w-fit ${role === 'user' ? 'bg-emerald-600 border border-emerald-400 self-end text-white' : 'bg-slate-50 border border-slate-200 self-start text-slate-800'}`}>
        <audio 
          ref={audioRef}
          autoPlay={role === 'agent'} 
          src={audioUrl}
          onEnded={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          className="hidden"
        />
        <button 
          onClick={togglePlay}
          className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors border-none cursor-pointer ${role === 'user' ? 'bg-white text-emerald-600 hover:bg-emerald-50' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
        >
          {isPlaying ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: '2px' }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
          )}
        </button>
        <div className={`h-1.5 w-24 rounded-full overflow-hidden ${role === 'user' ? 'bg-emerald-700' : 'bg-slate-200'}`}>
          {isPlaying ? (
             <motion.div 
               className={`h-full ${role === 'user' ? 'bg-white' : 'bg-emerald-500'}`}
               initial={{ width: "0%" }}
               animate={{ width: "100%" }}
               transition={{ duration: 3, ease: "linear", repeat: Infinity }}
             />
          ) : (
             <div className="h-full w-full opacity-50" />
          )}
        </div>
        <span className={`text-[9px] font-bold tracking-wider pr-2 ${role === 'user' ? 'text-emerald-100' : 'text-slate-400'}`}>VOICE</span>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-200">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
