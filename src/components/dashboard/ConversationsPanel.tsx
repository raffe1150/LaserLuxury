import { useEffect, useMemo, useState } from 'react';
import type { Conversation } from '../../types/dashboard';
import { ChannelIcon } from './Icons';

interface ConversationsPanelProps {
  conversations: Conversation[];
}

const channelTabs = [
  { id: 'all', label: 'All' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'messenger', label: 'Messenger' },
  { id: 'telegram', label: 'Telegram' },
];

export default function ConversationsPanel({
  conversations,
}: ConversationsPanelProps) {
  const [query, setQuery] = useState('');
  const [activeChannel, setActiveChannel] = useState('all');
  const [selectedId, setSelectedId] = useState<string | undefined>(
    conversations[0]?.id,
  );

  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedId(undefined);
      return;
    }

    const selectedStillExists = conversations.some(
      (conversation) => conversation.id === selectedId,
    );

    if (!selectedStillExists) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations, selectedId]);

  const channelCounts = useMemo(() => {
    return conversations.reduce<Record<string, number>>(
      (counts, conversation) => {
        const channel = normalizeChannel(conversation.channel);

        counts.all += 1;
        counts[channel] = (counts[channel] || 0) + 1;

        return counts;
      },
      {
        all: 0,
        whatsapp: 0,
        instagram: 0,
        messenger: 0,
        telegram: 0,
      },
    );
  }, [conversations]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

   return conversations.filter((item) => {
  const itemChannel = normalizeChannel(item.channel);

  const matchesSearch =
    !term ||
    `${item.customerName} ${item.preview} ${item.status} ${item.channel}`
      .toLowerCase()
      .includes(term);

  const matchesChannel =
    activeChannel === 'all' || itemChannel === activeChannel;

  return matchesSearch && matchesChannel;
});
  }, [conversations, query, activeChannel]);
  const selected =
    filtered.find((item) => item.id === selectedId) ||
    conversations.find((item) => item.id === selectedId) ||
    filtered[0];

  return (
    <section id="conversations" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Conversations</div>
          <div className="card-desc">
            Search customers and review full AI-handled chats.
          </div>
        </div>

        <input
          className="form-input dashboard-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customer..."
        />
      </div>

      <div className="conversation-channel-tabs">
        {channelTabs.map((tab) => (
          <button
            className={
              activeChannel === tab.id
                ? 'conversation-channel-tab active'
                : 'conversation-channel-tab'
            }
            key={tab.id}
            type="button"
            onClick={() => setActiveChannel(tab.id)}
          >
            {tab.id !== 'all' && (
              <span className="conversation-channel-icon">
                <ChannelIcon channel={tab.id} />
              </span>
            )}

            <span>{tab.label}</span>

            <span className="conversation-channel-count">
              {channelCounts[tab.id] || 0}
            </span>
          </button>
        ))}
      </div>

      <div className="conversation-layout">
        <div className="conversation-list">
          {filtered.length === 0 && (
            <div className="empty-state">No conversations found.</div>
          )}

          {filtered.map((conversation) => (
            <button
              className={
                conversation.id === selected?.id
                  ? 'conversation-item active'
                  : 'conversation-item'
              }
              key={conversation.id}
              type="button"
              onClick={() => setSelectedId(conversation.id)}
            >
              <div className="conversation-avatar">
                <ChannelIcon channel={conversation.channel} />
              </div>

              <div className="conversation-main">
                <div className="conversation-title">
                  <span>{conversation.customerName}</span>
                  <small>{formatTime(conversation.updatedAt)}</small>
                </div>

                <div className="conversation-preview">
                  {conversation.preview}
                </div>

                <div className="conversation-meta">
                  {conversation.status}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="conversation-detail">
          {selected ? (
            <>
              <div className="conversation-detail-head">
                <div>
                  <div className="conversation-detail-name">
                    {selected.customerName}
                  </div>
                  <div className="conversation-detail-sub">
                    {selected.status}
                  </div>
                </div>
              </div>

              <div className="chat-transcript">
                {selected.messages.map((message) => (
                  <div
                    className={`transcript-bubble ${
                      message.author === 'customer' ? 'customer' : 'ai'
                    }`}
                    key={message.id}
                  >
                    {message.text}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state">Select a conversation.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function normalizeChannel(channel: string) {
  const value = String(channel || '').toLowerCase();

  if (value.includes('whatsapp')) return 'whatsapp';
  if (value.includes('instagram')) return 'instagram';
  if (value.includes('messenger') || value.includes('facebook')) {
    return 'messenger';
  }
  if (value.includes('telegram')) return 'telegram';

  return value;
}

function formatTime(value: string) {
  if (!value) return '';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
