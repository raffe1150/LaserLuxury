export interface UnifiedAudioInput {
  data: string;
  mimeType: string;
  channel?: string;
}

const supportedAudioMimeTypes = new Set([
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/m4a",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav",
  "audio/webm",
]);

export function normalizeAudioMimeType(value: unknown): string | null {
  const mimeType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (mimeType === "video/mp4") return "audio/mp4";
  return supportedAudioMimeTypes.has(mimeType) ? mimeType : null;
}

function normalizeBase64Audio(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const data = value.replace(/\s+/g, "");
  if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return null;
  }

  try {
    if (Buffer.from(data, "base64").byteLength === 0) return null;
  } catch {
    return null;
  }

  return data;
}

export function extractUnifiedAudioInput(
  input: unknown,
  channel?: string,
): UnifiedAudioInput | null {
  const candidates = Array.isArray(input) ? input : [input];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    const record = candidate as Record<string, any>;
    const audio = record.inlineData && typeof record.inlineData === "object"
      ? record.inlineData
      : record;
    const data = normalizeBase64Audio(audio.data);
    const mimeType = normalizeAudioMimeType(audio.mimeType);

    if (!data || !mimeType) continue;

    const normalizedChannel = String(channel || record.channel || "").trim();
    return {
      data,
      mimeType,
      ...(normalizedChannel ? { channel: normalizedChannel } : {}),
    };
  }

  return null;
}

export function toGeminiAudioContent(audio: UnifiedAudioInput): any[] {
  return [
    { text: "Voice message input:" },
    {
      inlineData: {
        data: audio.data,
        mimeType: audio.mimeType,
      },
    },
  ];
}
