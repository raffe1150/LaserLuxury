import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, ConversationMessage } from '../../types/dashboard';
import { mergeConversationPages } from '../../conversations/inbox';
import type { ConversationActivityRange, ConversationStatusFilter } from '../../conversations/inbox';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';

interface ConversationsPanelProps { businessId: string; }

const PAGE_SIZE = 25;
const THREAD_PAGE_SIZE = 75;
const channelTabs = [
  { id: 'all', label: 'All' }, { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'instagram', label: 'Instagram' }, { id: 'messenger', label: 'Messenger' },
  { id: 'telegram', label: 'Telegram' },
];
const rangeTabs: Array<{ id: ConversationActivityRange; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '3m', label: '3 months' },
];
const statusTabs: Array<{ id: ConversationStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'booked', label: 'Booked' },
];

export default function ConversationsPanel({ businessId }: ConversationsPanelProps) {
  const { locale, formatNumber, t } = useDashboardI18n();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [activeChannel, setActiveChannel] = useState('all');
  const [activeRange, setActiveRange] = useState<ConversationActivityRange>('recent');
  const [activeStatus, setActiveStatus] = useState<ConversationStatusFilter>('all');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [listCursor, setListCursor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [threadCursor, setThreadCursor] = useState<number | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [listRetry, setListRetry] = useState(0);
  const [threadRetry, setThreadRetry] = useState(0);
  const listRequest = useRef(0);
  const threadRequest = useRef(0);
  const replyContext = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollToLatest = useRef(true);
  const activeRangeLabel = rangeTabs.find((tab) => tab.id === activeRange)?.label ?? 'Recent';

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const requestId = ++listRequest.current;
    const controller = new AbortController();
    setConversations([]);
    setSelectedId(undefined);
    setListCursor(null);
    setTotal(0);
    setListError(null);
    setListLoading(true);
    setMobileChatOpen(false);

    api.getConversationPage(businessId, { limit: PAGE_SIZE, search, channel: activeChannel, status: activeStatus, range: activeRange }, controller.signal)
      .then((page) => {
        if (requestId !== listRequest.current) return;
        setConversations(page.items);
        setSelectedId(page.items[0]?.id);
        setListCursor(page.pagination.nextCursor);
        setTotal(page.pagination.total);
      })
      .catch((error) => {
        if (controller.signal.aborted || requestId !== listRequest.current) return;
        setListError(error instanceof Error ? error.message : 'Could not load conversations.');
      })
      .finally(() => { if (requestId === listRequest.current) setListLoading(false); });
    return () => controller.abort();
  }, [businessId, search, activeChannel, activeStatus, activeRange, listRetry]);

  const selected = conversations.find((conversation) => conversation.id === selectedId);

  useEffect(() => {
    const requestId = ++threadRequest.current;
    replyContext.current += 1;
    setMessages([]);
    scrollToLatest.current = true;
    setThreadCursor(null);
    setThreadError(null);
    setReplyText('');
    setSendError(null);
    setSending(false);
    if (!selectedId) { setThreadLoading(false); return; }

    const controller = new AbortController();
    setThreadLoading(true);
    api.getConversationThread(businessId, selectedId, { limit: THREAD_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (requestId !== threadRequest.current) return;
        setMessages(page.messages);
        setThreadCursor(page.pagination.nextCursor);
      })
      .catch((error) => {
        if (controller.signal.aborted || requestId !== threadRequest.current) return;
        setThreadError(error instanceof Error ? error.message : 'Could not load this conversation.');
      })
      .finally(() => { if (requestId === threadRequest.current) setThreadLoading(false); });
    return () => controller.abort();
  }, [businessId, selectedId, threadRetry]);

  useEffect(() => {
    if (!messages.length || !scrollToLatest.current) return;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    scrollToLatest.current = false;
  }, [messages]);

  useEffect(() => {
    document.body.classList.toggle('mobile-conversation-open', mobileChatOpen);
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMobileChatOpen(false); };
    window.addEventListener('keydown', escape);
    return () => {
      document.body.classList.remove('mobile-conversation-open');
      window.removeEventListener('keydown', escape);
    };
  }, [mobileChatOpen]);

  const loadedUnread = useMemo(
    () => conversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0),
    [conversations],
  );

  const loadMore = async () => {
    if (listCursor === null || loadingMore) return;
    const requestId = ++listRequest.current;
    setLoadingMore(true);
    setListError(null);
    try {
      const page = await api.getConversationPage(businessId, {
        limit: PAGE_SIZE, cursor: listCursor, search, channel: activeChannel, status: activeStatus, range: activeRange,
      });
      if (requestId !== listRequest.current) return;
      setConversations((current) => mergeConversationPages(current, page.items));
      setListCursor(page.pagination.nextCursor);
      setTotal(page.pagination.total);
    } catch (error) {
      if (requestId !== listRequest.current) return;
      setListError(error instanceof Error ? error.message : 'Could not load more conversations.');
    } finally { if (requestId === listRequest.current) setLoadingMore(false); }
  };

  const loadEarlier = async () => {
    if (!selectedId || threadCursor === null || loadingEarlier) return;
    const requestId = ++threadRequest.current;
    setLoadingEarlier(true);
    scrollToLatest.current = false;
    setThreadError(null);
    try {
      const page = await api.getConversationThread(businessId, selectedId, {
        limit: THREAD_PAGE_SIZE, cursor: threadCursor,
      });
      if (requestId !== threadRequest.current) return;
      setMessages((current) => {
        const existing = new Set(current.map((message) => message.id));
        return [...page.messages.filter((message) => !existing.has(message.id)), ...current];
      });
      setThreadCursor(page.pagination.nextCursor);
    } catch (error) {
      if (requestId !== threadRequest.current) return;
      setThreadError(error instanceof Error ? error.message : 'Could not load earlier messages.');
    } finally { if (requestId === threadRequest.current) setLoadingEarlier(false); }
  };

  const selectConversation = (conversation: Conversation) => {
    setSelectedId(conversation.id);
    if (window.matchMedia('(max-width: 768px)').matches) setMobileChatOpen(true);
    const unread = Number(conversation.unreadCount || 0);
    if (!unread) return;
    setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, unreadCount: 0 } : item));
    api.markConversationRead(businessId, conversation.id).catch(() => {
      setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, unreadCount: unread } : item));
    });
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if (!selected || !text || sending) return;
    const conversationId = selected.id;
    const context = replyContext.current;
    const optimisticId = `optimistic-${Date.now()}`;
    const optimistic: ConversationMessage = { id: optimisticId, author: 'human', text, createdAt: new Date().toISOString() };
    setSending(true);
    scrollToLatest.current = true;
    setSendError(null);
    setReplyText('');
    setMessages((current) => [...current, optimistic]);
    setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, preview: text, updatedAt: optimistic.createdAt } : item));
    try {
      const result = await api.sendConversationMessage(businessId, conversationId, text);
      if (context !== replyContext.current) return;
      setMessages((current) => current.map((message) => message.id === optimisticId
        ? { ...message, id: result.messageId || optimisticId, createdAt: result.createdAt || message.createdAt }
        : message));
    } catch (error) {
      if (context !== replyContext.current) return;
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setReplyText(text);
      setSendError(error instanceof Error ? error.message : 'Could not send message.');
    } finally { if (context === replyContext.current) setSending(false); }
  };

  const handleReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReply(); }
  };

  return (
    <section id="conversations" className={`card dashboard-section conversation-inbox${mobileChatOpen ? ' mobile-chat-open' : ''}`}>
      <div className="conversation-toolbar">
        <div className="conversation-toolbar-stats">
          <span className="conversation-toolbar-stat active"><i aria-hidden="true" />{formatNumber(total)} conversations loaded · {activeRangeLabel}</span>
          <span className="conversation-toolbar-stat">{formatNumber(loadedUnread)} unread in loaded results</span>
        </div>
        <input className="form-input dashboard-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names or messages…" aria-label="Search conversations" />
      </div>

      <div className="conversation-channel-tabs" aria-label="Filter conversations by channel">
        {channelTabs.map((tab) => <button className={activeChannel === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveChannel(tab.id)} aria-pressed={activeChannel === tab.id}>
          {tab.id !== 'all' && <span className="conversation-channel-icon"><ChannelIcon channel={tab.id} /></span>}<span>{tab.label}</span>
        </button>)}
      </div>

      <div className="conversation-channel-tabs conversation-range-tabs" aria-label="Filter conversations by activity range">
        {rangeTabs.map((tab) => <button className={activeRange === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveRange(tab.id)} aria-pressed={activeRange === tab.id}>
          <span>{tab.label}</span>
        </button>)}
      </div>

      <div className="conversation-channel-tabs conversation-status-tabs" aria-label={t('Filter conversations by status')}>
        {statusTabs.map((tab) => <button className={activeStatus === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveStatus(tab.id)} aria-pressed={activeStatus === tab.id}>
          <span>{t(tab.label)}</span>
        </button>)}
      </div>

      <div className="conversation-layout">
        <div className="conversation-list" aria-busy={listLoading}>
          {listLoading && <ConversationListSkeleton />}
          {!listLoading && listError && conversations.length === 0 && <div className="conversation-state"><strong>Inbox unavailable</strong><span>{listError}</span><button type="button" onClick={() => setListRetry((value) => value + 1)}>Retry</button></div>}
          {!listLoading && !listError && conversations.length === 0 && <div className="conversation-state"><strong>No conversations found</strong><span>Try another search or channel.</span></div>}
          {conversations.map((conversation) => {
            const unread = Number(conversation.unreadCount || 0);
            return <button className={`conversation-item${conversation.id === selectedId ? ' active' : ''}${unread ? ' unread' : ''}`} key={conversation.id} type="button" onClick={() => selectConversation(conversation)}>
              <div className="conversation-avatar"><ChannelIcon channel={conversation.channel} /></div>
              <div className="conversation-main">
                <div className="conversation-title"><span translate="no">{conversation.customerName}</span><div className="conversation-title-right"><small>{formatTime(conversation.updatedAt, locale)}</small>{unread > 0 && <span className="conversation-unread-badge">{unread > 99 ? '99+' : formatNumber(unread)}</span>}</div></div>
                <div className="conversation-preview" dir="auto">{conversation.preview}</div>
                <div className="conversation-meta"><span className={`conversation-status ${getStatusTone(conversation.status)}`}><i aria-hidden="true" />{getStatusLabel(conversation.status)}</span><span className="conversation-channel-name">{formatChannelName(conversation.channel)}</span></div>
              </div>
            </button>;
          })}
          {listCursor !== null && <button className="conversation-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : `Load more (${conversations.length} of ${total})`}</button>}
          {listError && conversations.length > 0 && <div className="conversation-inline-error">{listError} <button type="button" onClick={() => void loadMore()}>Retry</button></div>}
        </div>

        <div className="conversation-detail">
          {selected ? <>
            <div className="conversation-detail-head">
              <button className="conversation-mobile-back" type="button" onClick={() => setMobileChatOpen(false)} aria-label="Back to inbox"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg><span>Inbox</span></button>
              <div className="conversation-detail-identity"><div className="conversation-detail-avatar"><ChannelIcon channel={selected.channel} /></div><div><div className="conversation-detail-name" translate="no">{selected.customerName}</div><div className="conversation-detail-sub"><span className={`conversation-status ${getStatusTone(selected.status)}`}><i aria-hidden="true" />{getStatusLabel(selected.status)}</span><span>{formatChannelName(selected.channel)}</span></div></div></div>
            </div>
            <div className="chat-transcript" aria-busy={threadLoading} ref={transcriptRef}>
              {threadCursor !== null && <button className="conversation-load-earlier" type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button>}
              {threadLoading && <div className="conversation-thread-loading">Loading messages…</div>}
              {threadError && messages.length === 0 && <div className="conversation-state"><strong>Thread unavailable</strong><span>{threadError}</span><button type="button" onClick={() => setThreadRetry((value) => value + 1)}>Retry</button></div>}
              {messages.map((message) => <div className={`transcript-message ${message.author}`} key={message.id}><span className="transcript-author">{authorLabel(message.author)}</span><div className={`transcript-bubble ${message.author}`} dir="auto" translate="no">{message.text}</div><time>{formatTime(message.createdAt, locale)}</time></div>)}
            </div>
            <div className="conversation-reply-box">
              <textarea className="form-input conversation-reply-input" value={replyText} onChange={(event) => setReplyText(event.target.value)} onKeyDown={handleReplyKeyDown} placeholder={`Reply via ${formatChannelName(selected.channel)}…`} rows={2} disabled={sending || threadLoading} maxLength={4000} />
              <div className="conversation-reply-actions"><span className="conversation-reply-hint">Enter to send · Shift+Enter for a new line</span><button className="btn btn-primary" type="button" onClick={() => void sendReply()} disabled={sending || !replyText.trim()}>{sending ? 'Sending…' : 'Send'}</button></div>
              {sendError && <div className="conversation-send-error">{sendError}</div>}
            </div>
          </> : <div className="conversation-state conversation-empty-thread"><strong>{listLoading ? 'Loading inbox…' : 'Select a conversation'}</strong><span>{listLoading ? 'Fetching the latest customer activity.' : 'Choose a customer from the inbox to view the thread.'}</span></div>}
        </div>
      </div>
    </section>
  );
}

function ConversationListSkeleton() {
  return <div className="conversation-skeleton" aria-label="Loading conversations">{Array.from({ length: 5 }, (_, index) => <div className="conversation-skeleton-row" key={index}><i /><span /></div>)}</div>;
}

function getStatusTone(status: string) {
  if (status === 'escalated') return 'attention';
  if (status === 'handled' || status === 'booked') return 'handled';
  return 'active';
}

function getStatusLabel(status: string) {
  if (status === 'escalated') return 'Needs attention';
  if (status === 'booked') return 'Booked';
  if (status === 'handled') return 'Handled by OdinLink';
  return 'Active conversation';
}

function authorLabel(author: ConversationMessage['author']) {
  if (author === 'customer') return 'Customer';
  if (author === 'human') return 'You';
  if (author === 'system') return 'System';
  return 'OdinLink';
}

function formatChannelName(channel: string) {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  if (channel === 'messenger') return 'Messenger';
  if (channel === 'telegram') return 'Telegram';
  return channel || 'Customer channel';
}

function formatTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
