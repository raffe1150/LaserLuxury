import { KeyboardEvent, useEffect, useMemo, useState } from 'react';
import type { Conversation } from '../../types/dashboard';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';

interface ConversationsPanelProps {
  conversations: Conversation[];
  businessId?: string;
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
  businessId,
}: ConversationsPanelProps) {
  const [query, setQuery] = useState('');
  const [activeChannel, setActiveChannel] = useState('all');
  const [localConversations, setLocalConversations] =
    useState<Conversation[]>(conversations);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    conversations[0]?.id,
  );
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  useEffect(() => {
    setLocalConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (localConversations.length === 0) {
      setSelectedId(undefined);
      return;
    }

    const selectedStillExists = localConversations.some(
      (conversation) => conversation.id === selectedId,
    );

    if (!selectedStillExists) {
      setSelectedId(localConversations[0].id);
    }
  }, [localConversations, selectedId]);

  useEffect(() => {
    setReplyText('');
    setSendError(null);
  }, [selectedId]);

  useEffect(() => {
    document.body.classList.toggle('mobile-conversation-open', mobileChatOpen);

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileChatOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.classList.remove('mobile-conversation-open');
      window.removeEventListener('keydown', handleEscape);
    };
  }, [mobileChatOpen]);

  const closeMobileConversation = () => {
    setMobileChatOpen(false);
  };

  const unreadCounts = useMemo(() => {
    return localConversations.reduce<Record<string, number>>(
      (counts, conversation) => {
        const channel = normalizeChannel(conversation.channel);
        const unread = Number(conversation.unreadCount || 0);

        counts.all += unread;
        counts[channel] = (counts[channel] || 0) + unread;

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
  }, [localConversations]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

    return localConversations
      .filter((item) => {
        const itemChannel = normalizeChannel(item.channel);

        const matchesSearch =
          !term ||
          `${item.customerName} ${item.preview} ${item.status} ${item.channel}`
            .toLowerCase()
            .includes(term);

        const matchesChannel =
          activeChannel === 'all' || itemChannel === activeChannel;

        return matchesSearch && matchesChannel;
      })
      .sort((a, b) => {
        const unreadDifference =
          Number(b.unreadCount || 0) - Number(a.unreadCount || 0);

        if (unreadDifference !== 0) {
          return unreadDifference;
        }

        return (
          new Date(b.updatedAt).getTime() -
          new Date(a.updatedAt).getTime()
        );
      });
  }, [localConversations, query, activeChannel]);

  const selected =
    filtered.find((item) => item.id === selectedId) ||
    localConversations.find((item) => item.id === selectedId) ||
    filtered[0];

  const handleSelectConversation = async (conversation: Conversation) => {
    setSelectedId(conversation.id);

    if (window.matchMedia('(max-width: 768px)').matches) {
      setMobileChatOpen(true);
    }

    const unread = Number(conversation.unreadCount || 0);

    if (!businessId || unread === 0) {
      return;
    }

    setLocalConversations((current) =>
      current.map((item) =>
        item.id === conversation.id
          ? {
              ...item,
              unreadCount: 0,
            }
          : item,
      ),
    );

    try {
      await api.markConversationRead(businessId, conversation.id);
    } catch (error) {
      console.error('Could not mark conversation as read:', error);

      setLocalConversations((current) =>
        current.map((item) =>
          item.id === conversation.id
            ? {
                ...item,
                unreadCount: unread,
              }
            : item,
        ),
      );
    }
  };

  const sendReply = async () => {
    const text = replyText.trim();

    if (!businessId || !selected || !text || sending) {
      return;
    }

    const conversationId = selected.id;
    const previousConversation = selected;
    const optimisticMessage = {
      id: `optimistic-${Date.now()}`,
      author: 'ai',
      text,
    } as Conversation['messages'][number];

    setSending(true);
    setSendError(null);
    setReplyText('');

    setLocalConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              preview: text,
              updatedAt: new Date().toISOString(),
              messages: [...conversation.messages, optimisticMessage],
            }
          : conversation,
      ),
    );

    try {
      await api.sendConversationMessage(businessId, conversationId, text);
    } catch (error) {
      console.error('Could not send message:', error);

      setLocalConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? previousConversation
            : conversation,
        ),
      );

      setReplyText(text);
      setSendError(
        error instanceof Error ? error.message : 'Could not send message.',
      );
    } finally {
      setSending(false);
    }
  };

  const handleReplyKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendReply();
    }
  };

  return (
    <section
      id="conversations"
      className={`card dashboard-section${mobileChatOpen ? ' mobile-chat-open' : ''}`}
    >
      <div className="conversation-toolbar">
        <div className="conversation-toolbar-stats">
          <span className="conversation-toolbar-stat active">
            <i aria-hidden="true" />
            {localConversations.length} active
          </span>
          <span className="conversation-toolbar-stat">
            {unreadCounts.all} unread
          </span>
        </div>

        <input
          className="form-input dashboard-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customers..."
        />
      </div>

      <div className="conversation-channel-tabs">
        {channelTabs.map((tab) => {
          const unread = unreadCounts[tab.id] || 0;

          return (
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

              {unread > 0 && (
                <span className="conversation-channel-count unread">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="conversation-layout">
        <div className="conversation-list">
          {filtered.length === 0 && (
            <div className="empty-state">No conversations found.</div>
          )}

          {filtered.map((conversation) => {
            const unread = Number(conversation.unreadCount || 0);
            const isUnread = unread > 0;
            const statusTone = getStatusTone(conversation.status);
            const statusLabel = getStatusLabel(conversation.status);

            return (
              <button
                className={[
                  'conversation-item',
                  conversation.id === selected?.id ? 'active' : '',
                  isUnread ? 'unread' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={conversation.id}
                type="button"
                onClick={() => handleSelectConversation(conversation)}
              >
                <div className="conversation-avatar">
                  <ChannelIcon channel={conversation.channel} />
                </div>

                <div className="conversation-main">
                  <div className="conversation-title">
                    <span>{conversation.customerName}</span>

                    <div className="conversation-title-right">
                      <small>{formatTime(conversation.updatedAt)}</small>

                      {isUnread && (
                        <span className="conversation-unread-badge">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="conversation-preview">
                    {conversation.preview}
                  </div>

                  <div className="conversation-meta">
                    <span className={`conversation-status ${statusTone}`}>
                      <i aria-hidden="true" />
                      {statusLabel}
                    </span>
                    <span className="conversation-channel-name">
                      {formatChannelName(conversation.channel)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="conversation-detail">
          {selected ? (
            <>
              <div className="conversation-detail-head">
                <button
                  className="conversation-mobile-back"
                  type="button"
                  onClick={closeMobileConversation}
                  aria-label="Back to inbox"
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  <span>Inbox</span>
                </button>

                <div className="conversation-detail-identity">
                  <div className="conversation-detail-avatar">
                    <ChannelIcon channel={selected.channel} />
                  </div>
                  <div>
                    <div className="conversation-detail-name">
                      {selected.customerName}
                    </div>
                    <div className="conversation-detail-sub">
                      <span className={`conversation-status ${getStatusTone(selected.status)}`}>
                        <i aria-hidden="true" />
                        {getStatusLabel(selected.status)}
                      </span>
                      <span>{formatChannelName(selected.channel)}</span>
                    </div>
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

              <div className="conversation-reply-box">
                <textarea
                  className="form-input conversation-reply-input"
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  onKeyDown={handleReplyKeyDown}
                  placeholder={`Write a reply via ${formatChannelName(selected.channel)}...`}
                  rows={3}
                  disabled={sending || !businessId}
                />

                <div className="conversation-reply-actions">
                  <span className="conversation-reply-hint">
                    Enter to send · Shift+Enter for a new line
                  </span>

                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => void sendReply()}
                    disabled={sending || !businessId || !replyText.trim()}
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>

                {sendError && (
                  <div className="conversation-send-error">{sendError}</div>
                )}
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


function getStatusTone(status: string) {
  const value = String(status || '').toLowerCase();

  if (
    value.includes('human') ||
    value.includes('attention') ||
    value.includes('escalat') ||
    value.includes('takeover')
  ) {
    return 'attention';
  }

  if (
    value.includes('handled') ||
    value.includes('resolved') ||
    value.includes('complete') ||
    value.includes('done')
  ) {
    return 'handled';
  }

  return 'active';
}

function getStatusLabel(status: string) {
  const tone = getStatusTone(status);

  if (tone === 'attention') return 'Needs attention';
  if (tone === 'handled') return 'Handled by OdinLink';
  return 'Active conversation';
}

function formatChannelName(channel: string) {
  const normalized = normalizeChannel(channel);

  if (normalized === 'whatsapp') return 'WhatsApp';
  if (normalized === 'instagram') return 'Instagram';
  if (normalized === 'messenger') return 'Messenger';
  if (normalized === 'telegram') return 'Telegram';

  return channel || 'Customer channel';
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
