import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, ConversationMessage } from '../../types/dashboard';
import { mergeConversationPages } from '../../conversations/inbox';
import type { ConversationActivityRange, ConversationStatusFilter } from '../../conversations/inbox';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';
import { isMobileConversationLocked } from './dashboard-navigation';

interface ConversationsPanelProps { businessId: string; active?: boolean; }

const PAGE_SIZE = 25;
const THREAD_PAGE_SIZE = 75;
const channelTabs = [
  { id: 'all', label: 'All' }, { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'instagram', label: 'Instagram' }, { id: 'messenger', label: 'Messenger' },
  { id: 'telegram', label: 'Telegram' },
] as const;
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

export default function ConversationsPanel({ businessId, active = true }: ConversationsPanelProps) {
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
  const [singlePane, setSinglePane] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  const [mobileViewport, setMobileViewport] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  const [listRetry, setListRetry] = useState(0);
  const [threadRetry, setThreadRetry] = useState(0);
  const listRequest = useRef(0);
  const threadRequest = useRef(0);
  const replyContext = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inboxRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const scrollToLatest = useRef(true);
  const activeRangeLabel = rangeTabs.find((tab) => tab.id === activeRange)?.label ?? 'Recent';

  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const updateMobile = () => setMobileViewport(media.matches);
    media.addEventListener('change', updateMobile);
    let previousSingle: boolean | undefined;
    // 300px list + 440px thread + divider room. Measure this workspace because
    // the existing tablet sidebar consumes part of the viewport width. Short workspaces
    // also use the existing list/thread mode so the header and composer can fit.
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (!width) return; // Inactive mounted workspaces have no measurable width.
      const compact = width < 760 || entry.contentRect.height < 480 || media.matches;
      if (previousSingle === false && compact && selectedRef.current) setMobileChatOpen(true);
      previousSingle = compact;
      setSinglePane(compact);
    });
    observer.observe(inboxRef.current!);
    return () => { observer.disconnect(); media.removeEventListener('change', updateMobile); };
  }, []);

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
    document.body.classList.toggle('mobile-conversation-open', isMobileConversationLocked(active, mobileChatOpen && mobileViewport));
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !active || !mobileChatOpen) return;
      setMobileChatOpen(false);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('.conversation-item.active')?.focus({ preventScroll: true }));
    };
    window.addEventListener('keydown', escape);
    return () => {
      document.body.classList.remove('mobile-conversation-open');
      window.removeEventListener('keydown', escape);
    };
  }, [mobileChatOpen, active, mobileViewport]);

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
    if (singlePane) {
      setMobileChatOpen(true);
      requestAnimationFrame(() => inboxRef.current?.querySelector<HTMLElement>('.conversation-mobile-back')?.focus({ preventScroll: true }));
    }
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
    const previousPreview = selected.preview;
    const previousUpdatedAt = selected.updatedAt;
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
      setConversations((current) => current.map((item) => item.id === conversationId
        ? { ...item, preview: previousPreview, updatedAt: previousUpdatedAt }
        : item));
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
    <section ref={inboxRef} id="conversations" translate="no" className={`card dashboard-section conversation-inbox${singlePane ? ' conversation-single-pane' : ''}${mobileChatOpen && mobileViewport ? ' mobile-chat-open' : ''}`}>
      <div className="conversation-toolbar">
        <div className="conversation-toolbar-stats">
          <span className="conversation-toolbar-stat active">{t("{count} conversations loaded · {range}", { count: formatNumber(total), range: t(activeRangeLabel) })}</span>
          <span className="conversation-toolbar-stat">{t("{count} unread in loaded results", { count: formatNumber(loadedUnread) })}</span>
        </div>
        <input className="form-input dashboard-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search names or messages…")} aria-label={t("Search conversations")} />
      </div>

      <div className="conversation-filters">
      <div className="conversation-filter-group"><span className="conversation-filter-label">{t('Channel')}</span><div className="conversation-channel-tabs" aria-label={t('Filter conversations by channel')}>
        {channelTabs.map((tab) => <button className={activeChannel === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveChannel(tab.id)} aria-pressed={activeChannel === tab.id}>
          {tab.id !== 'all' && <span className="conversation-channel-icon"><ChannelIcon channel={tab.id} /></span>}<span>{t(tab.label)}</span>
        </button>)}
      </div></div>

      <div className="conversation-filter-group"><span className="conversation-filter-label">{t('Activity')}</span><div className="conversation-channel-tabs conversation-range-tabs" aria-label={t('Filter conversations by activity range')}>
        {rangeTabs.map((tab) => <button className={activeRange === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveRange(tab.id)} aria-pressed={activeRange === tab.id}>
          <span>{t(tab.label)}</span>
        </button>)}
      </div></div>

      <div className="conversation-filter-group"><span className="conversation-filter-label">{t('Status')}</span><div className="conversation-channel-tabs conversation-status-tabs" aria-label={t('Filter conversations by status')}>
        {statusTabs.map((tab) => <button className={activeStatus === tab.id ? 'conversation-channel-tab active' : 'conversation-channel-tab'} key={tab.id} type="button" onClick={() => setActiveStatus(tab.id)} aria-pressed={activeStatus === tab.id}>
          <span>{t(tab.label)}</span>
        </button>)}
      </div></div>

      </div>

      <div className="conversation-layout">
        <div ref={listRef} className="conversation-list" role="region" aria-label={t("Customer conversations")} tabIndex={0} aria-busy={listLoading} hidden={singlePane && mobileChatOpen}>
          {listLoading && <ConversationListSkeleton label={t("Loading conversations")} />}
          {!listLoading && listError && conversations.length === 0 && <div className="conversation-state" role="alert"><strong>{t("Inbox unavailable")}</strong><span>{listError}</span><button type="button" onClick={() => setListRetry((value) => value + 1)}>{t("Retry")}</button></div>}
          {!listLoading && !listError && conversations.length === 0 && <div className="conversation-state"><strong>{t("No conversations found")}</strong><span>{t("Try another search or channel.")}</span></div>}
          {conversations.map((conversation) => {
            const unread = Number(conversation.unreadCount || 0);
            return <button className={`conversation-item${conversation.id === selectedId ? ' active' : ''}${unread ? ' unread' : ''}`} key={conversation.id} type="button" aria-pressed={conversation.id === selectedId} onClick={() => selectConversation(conversation)}>
              <div className="conversation-avatar"><ChannelIcon channel={conversation.channel} /></div>
              <div className="conversation-main">
                <div className="conversation-title"><span translate="no" dir="auto">{conversation.customerName}</span><div className="conversation-title-right"><small dir="ltr"><bdi>{formatTime(conversation.updatedAt, locale)}</bdi></small>{unread > 0 && <span className="conversation-unread-badge" aria-label={t("Unread")}>{unread > 99 ? '99+' : formatNumber(unread)}</span>}</div></div>
                <div className="conversation-preview" dir="auto" translate="no">{conversation.preview}</div>
                <div className="conversation-meta"><span className={`conversation-status ${getStatusTone(conversation.status)}`} translate="no"><i aria-hidden="true" />{t(getStatusLabel(conversation.status))}</span><span className="conversation-channel-name">{formatChannelName(conversation.channel)}</span></div>
              </div>
            </button>;
          })}
          {listCursor !== null && <button className="conversation-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t('Loading…') : t('Load more ({loaded} of {total})', { loaded: conversations.length, total })}</button>}
          {listError && conversations.length > 0 && <div className="conversation-inline-error" role="alert">{listError} <button type="button" onClick={() => void loadMore()}>{t("Retry")}</button></div>}
        </div>

        <div className="conversation-detail" hidden={singlePane && !mobileChatOpen}>
          {selected ? <>
            <div className="conversation-detail-head" tabIndex={singlePane ? 0 : undefined} role={singlePane ? "region" : undefined} aria-labelledby={singlePane ? `conversation-customer-${businessId}` : undefined}>
              <button className="conversation-mobile-back" type="button" onClick={() => { setMobileChatOpen(false); requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('.conversation-item.active')?.focus({ preventScroll: true })); }} aria-label={t("Back to inbox")}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg><span>{t("Inbox")}</span></button>
              <div className="conversation-detail-identity"><div className="conversation-detail-avatar"><ChannelIcon channel={selected.channel} /></div><div><div id={`conversation-customer-${businessId}`} className="conversation-detail-name" translate="no" dir="auto">{selected.customerName}</div><div className="conversation-detail-sub"><span className={`conversation-status ${getStatusTone(selected.status)}`} translate="no"><i aria-hidden="true" />{t(getStatusLabel(selected.status))}</span><span>{formatChannelName(selected.channel)}</span></div></div></div>
            </div>
            <div className="chat-transcript" tabIndex={0} role="region" aria-label={t("Messages")} aria-busy={threadLoading} ref={transcriptRef}>
              {threadCursor !== null && <button className="conversation-load-earlier" type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>{loadingEarlier ? t('Loading…') : t('Load earlier messages')}</button>}
              {threadLoading && <div className="conversation-thread-loading" role="status">{t("Loading messages…")}</div>}
              {threadError && messages.length === 0 && <div className="conversation-state" role="alert"><strong>{t("Thread unavailable")}</strong><span>{threadError}</span><button type="button" onClick={() => setThreadRetry((value) => value + 1)}>{t("Retry")}</button></div>}
              {messages.map((message) => <div className={`transcript-message ${message.author}`} key={message.id}><span className="transcript-author">{t(authorLabel(message.author))}</span><div className={`transcript-bubble ${message.author}`} dir="auto" translate="no">{message.text}</div><time dir="ltr"><bdi>{formatTime(message.createdAt, locale)}</bdi></time></div>)}
            </div>
            <div className="conversation-reply-box">
              <label className="conversation-reply-label" htmlFor={`conversation-reply-${businessId}`}>{t("Reply")}</label>
              <textarea id={`conversation-reply-${businessId}`} aria-describedby={`conversation-reply-help-${businessId}${sendError ? ` conversation-send-error-${businessId}` : ''}`} aria-invalid={Boolean(sendError)} dir="auto" className="form-input conversation-reply-input" value={replyText} onChange={(event) => setReplyText(event.target.value)} onKeyDown={handleReplyKeyDown} placeholder={t("Reply via {channel}…", { channel: formatChannelName(selected.channel) })} rows={2} disabled={sending || threadLoading} maxLength={4000} />
              <div className="conversation-reply-actions"><span id={`conversation-reply-help-${businessId}`} className="conversation-reply-hint">{t("Enter to send · Shift+Enter for a new line")}<span className="conversation-reply-counter"><bdi>{formatNumber(replyText.length)} / {formatNumber(4000)}</bdi></span></span><button className="btn btn-primary" type="button" onClick={() => void sendReply()} disabled={sending || !replyText.trim()}>{sending ? t('Sending…') : t('Send')}</button></div>
              {sendError && <div id={`conversation-send-error-${businessId}`} className="conversation-send-error" role="alert">{sendError}</div>}
            </div>
          </> : <div className="conversation-state conversation-empty-thread"><strong>{t(listLoading ? 'Loading inbox…' : 'Select a conversation')}</strong><span>{t(listLoading ? 'Fetching the latest customer activity.' : 'Choose a customer from the inbox to view the thread.')}</span></div>}
        </div>
      </div>
    </section>
  );
}

function ConversationListSkeleton({ label }: { label: string }) {
  return <div className="conversation-skeleton" aria-label={label} role="status"><span className="dashboard-state-label">{label}</span>{Array.from({ length: 5 }, (_, index) => <div className="conversation-skeleton-row" key={index}><i /><span /></div>)}</div>;
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
