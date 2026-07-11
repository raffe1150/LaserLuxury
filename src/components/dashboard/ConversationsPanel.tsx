import { useMemo, useState } from 'react';
import type { Conversation } from '../../types/dashboard';
import { ChannelIcon } from './Icons';

interface ConversationsPanelProps {
  conversations: Conversation[];
}

export default function ConversationsPanel({ conversations }: ConversationsPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(conversations[0]?.id);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((item) =>
      `${item.customerName} ${item.preview} ${item.status}`.toLowerCase().includes(term),
    );
  }, [conversations, query]);

  const selected = conversations.find((item) => item.id === selectedId) || filtered[0];

  return (
    <section id="conversations" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Conversations</div>
          <div className="card-desc">Search customers and review full AI-handled chats.</div>
        </div>
        <input
          className="form-input dashboard-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customer..."
        />
      </div>
      <div className="conversation-layout">
        <div className="conversation-list">
          {filtered.length === 0 && <div className="empty-state">No conversations found.</div>}
          {filtered.map((conversation) => (
            <button
              className={conversation.id === selected?.id ? 'conversation-item active' : 'conversation-item'}
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
                <div className="conversation-preview">{conversation.preview}</div>
                <div className="conversation-meta">{conversation.status}</div>
              </div>
            </button>
          ))}
        </div>
        <div className="conversation-detail">
          {selected ? (
            <>
              <div className="conversation-detail-head">
                <div>
                  <div className="conversation-detail-name">{selected.customerName}</div>
                  <div className="conversation-detail-sub">{selected.status}</div>
                </div>
              </div>
              <div className="chat-transcript">
                {selected.messages.map((message) => (
                  <div className={`transcript-bubble ${message.author === 'customer' ? 'customer' : 'ai'}`} key={message.id}>
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

function formatTime(value: string) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}
