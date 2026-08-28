import type { Business, IntegrationHealth, IntegrationKey } from '../types/dashboard';

export type IntegrationFieldKey =
  | 'calendarId'
  | 'timezone'
  | 'instagramPageId'
  | 'instagramAccountId'
  | 'instagramAccessToken'
  | 'instagramWebhookVerifyToken'
  | 'messengerPageId'
  | 'messengerAccessToken'
  | 'messengerAppSecret'
  | 'messengerWebhookVerifyToken'
  | 'telegramToken'
  | 'telegramAdminChatId'
  | 'whatsappPhoneNumberId'
  | 'whatsappBusinessAccountId'
  | 'whatsappAccessToken'
  | 'whatsappWebhookVerifyToken';

export interface IntegrationFieldDefinition {
  key: IntegrationFieldKey;
  label: string;
  help: string;
  secret?: boolean;
  optional?: boolean;
  advanced?: boolean;
  preserveWhenBlank?: boolean;
  example: string;
  visual: IntegrationStepVisual;
}

export interface IntegrationStepVisual {
  type: 'illustration' | 'approved_screenshot' | 'fallback';
  path: string[];
  targetIndex: number;
  imageSrc?: string;
  highlight?: { left: string; top: string; width: string; height: string };
}

export interface IntegrationProviderDefinition {
  key: IntegrationKey;
  title: string;
  description: string;
  destinationLabel: string;
  destinationUrl: string;
  startTitle: string;
  startCopy: string;
  startVisual: IntegrationStepVisual;
  fields: IntegrationFieldDefinition[];
  authorizationOpportunity: 'official_authorization_possible' | 'manual_required' | 'future_improvement';
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProviderDefinition[] = [
  {
    key: 'google_calendar',
    title: 'Google Calendar',
    description: 'Keep availability and new bookings in the business calendar.',
    destinationLabel: 'Open Google Calendar settings',
    destinationUrl: 'https://calendar.google.com/calendar/u/0/r/settings',
    startTitle: 'Open the calendar settings',
    startCopy: 'Choose the calendar OdinLink should use, then open Settings and sharing.',
    startVisual: { type: 'illustration', path: ['Google Calendar', 'Settings', 'Settings and sharing'], targetIndex: 2 },
    authorizationOpportunity: 'official_authorization_possible',
    fields: [
      { key: 'calendarId', label: 'Calendar ID', example: 'business@example.com', visual: { type: 'illustration', path: ['Settings and sharing', 'Integrate calendar', 'Calendar ID'], targetIndex: 2 }, help: 'In Google Calendar, open Settings and sharing, then Integrate calendar. Copy the Calendar ID and paste it here.' },
      { key: 'timezone', label: 'Timezone', example: 'Europe/Stockholm', visual: { type: 'illustration', path: ['Settings and sharing', 'General', 'Time zone'], targetIndex: 2 }, help: 'Choose the same timezone used by the business calendar so appointment times stay correct.' },
    ],
  },
  {
    key: 'instagram',
    title: 'Instagram',
    description: 'Connect Instagram messages and comments to OdinLink.',
    destinationLabel: 'Open Meta for Developers',
    destinationUrl: 'https://developers.facebook.com/apps/',
    startTitle: 'Open your Meta app',
    startCopy: 'Choose the Meta app and business Page connected to the Instagram professional account.',
    startVisual: { type: 'illustration', path: ['Meta for Developers', 'My Apps', 'Select business app', 'Instagram'], targetIndex: 3 },
    authorizationOpportunity: 'future_improvement',
    fields: [
      { key: 'instagramPageId', label: 'Instagram Page ID', example: '123456789012345', visual: { type: 'illustration', path: ['Meta business settings', 'Accounts', 'Pages', 'Page ID'], targetIndex: 3 }, help: 'In Meta, open the connected Facebook Page settings. Copy the Page ID linked to this Instagram account.' },
      { key: 'instagramAccountId', label: 'Instagram Account ID', example: '17841400000000000', visual: { type: 'illustration', path: ['Select business app', 'Instagram', 'API setup', 'Instagram Account ID'], targetIndex: 3 }, help: 'In the Meta app, open Instagram API setup. Copy the Instagram professional account ID.' },
      { key: 'instagramAccessToken', label: 'Access Token', example: 'EAAB…example only', secret: true, visual: { type: 'illustration', path: ['Instagram', 'API setup', 'Generate access token', 'Copy token'], targetIndex: 3 }, help: 'In the Meta app, create an access token with permission for the connected Instagram professional account. Paste only the token value.' },
      { key: 'instagramWebhookVerifyToken', label: 'Webhook Verify Token', example: '••••••••', secret: true, advanced: true, visual: { type: 'fallback', path: [], targetIndex: 0 }, help: 'This field is retained for existing manual configurations. Webhook verification is managed by the OdinLink server; change it only with OdinLink support.' },
    ],
  },
  {
    key: 'messenger',
    title: 'Facebook Messenger',
    description: 'Connect Facebook Page messages and comments to OdinLink.',
    destinationLabel: 'Open Meta for Developers',
    destinationUrl: 'https://developers.facebook.com/apps/',
    startTitle: 'Open your Meta app',
    startCopy: 'Choose the Meta app that contains the Facebook Page used for Messenger.',
    startVisual: { type: 'illustration', path: ['Meta for Developers', 'My Apps', 'Select business app', 'Messenger'], targetIndex: 3 },
    authorizationOpportunity: 'future_improvement',
    fields: [
      { key: 'messengerPageId', label: 'Facebook Page ID', example: '123456789012345', visual: { type: 'illustration', path: ['Meta business settings', 'Accounts', 'Pages', 'Page ID'], targetIndex: 3 }, help: 'Open the Facebook Page settings in Meta and copy the Page ID.' },
      { key: 'messengerAccessToken', label: 'Page Access Token', example: 'EAAB…example only', secret: true, visual: { type: 'illustration', path: ['Messenger', 'API setup', 'Select Page', 'Generate token'], targetIndex: 3 }, help: 'In Messenger API setup, select the Page and generate its Page access token. Paste only the token value.' },
      { key: 'messengerAppSecret', label: 'App Secret', example: '••••••••', secret: true, advanced: true, visual: { type: 'fallback', path: [], targetIndex: 0 }, help: 'In the Meta app, open App settings, then Basic. Reveal and copy the App Secret only when support asks for it.' },
      { key: 'messengerWebhookVerifyToken', label: 'Webhook Verify Token', example: '••••••••', secret: true, advanced: true, visual: { type: 'fallback', path: [], targetIndex: 0 }, help: 'This field is retained for existing manual configurations. Webhook verification is managed by the OdinLink server; change it only with OdinLink support.' },
    ],
  },
  {
    key: 'telegram',
    title: 'Telegram',
    description: 'Connect a Telegram bot for customer conversations.',
    destinationLabel: 'Open BotFather',
    destinationUrl: 'https://t.me/BotFather',
    startTitle: 'Open BotFather',
    startCopy: 'Choose your existing bot or create a new bot, then open its token settings.',
    startVisual: { type: 'illustration', path: ['Telegram', 'BotFather', 'Choose or create bot', 'API Token'], targetIndex: 1 },
    authorizationOpportunity: 'manual_required',
    fields: [
      { key: 'telegramToken', label: 'Bot Token', example: '123456789:AA_example_only', secret: true, visual: { type: 'illustration', path: ['BotFather', 'Choose bot', 'API Token', 'Copy token'], targetIndex: 3 }, help: 'In BotFather, choose the bot and copy its HTTP API token. Paste only the token value.' },
      { key: 'telegramAdminChatId', label: 'Admin Chat ID', example: '123456789', optional: true, preserveWhenBlank: true, visual: { type: 'illustration', path: ['Telegram', 'Notification chat', 'Chat ID', 'Paste into OdinLink'], targetIndex: 2 }, help: 'Optional: paste the Telegram chat ID that should receive business booking notifications.' },
    ],
  },
  {
    key: 'whatsapp',
    title: 'WhatsApp Business',
    description: 'Connect WhatsApp Business customer messages to OdinLink.',
    destinationLabel: 'Open Meta for Developers',
    destinationUrl: 'https://developers.facebook.com/apps/',
    startTitle: 'Open WhatsApp API setup',
    startCopy: 'Choose the Meta app, then open WhatsApp and API Setup for the correct business.',
    startVisual: { type: 'illustration', path: ['Meta for Developers', 'My Apps', 'Select business app', 'WhatsApp', 'API Setup'], targetIndex: 4 },
    authorizationOpportunity: 'future_improvement',
    fields: [
      { key: 'whatsappPhoneNumberId', label: 'Phone Number ID', example: '123456789012345', visual: { type: 'illustration', path: ['WhatsApp', 'API Setup', 'From', 'Phone Number ID'], targetIndex: 3 }, help: 'In WhatsApp API Setup, copy the Phone number ID shown for the number customers will message.' },
      { key: 'whatsappBusinessAccountId', label: 'WhatsApp Business Account ID', example: '123456789012345', visual: { type: 'illustration', path: ['WhatsApp', 'API Setup', 'WhatsApp Business Account ID'], targetIndex: 2 }, help: 'In WhatsApp API Setup, copy the WhatsApp Business Account ID for the same Meta business.' },
      { key: 'whatsappAccessToken', label: 'Access Token', example: 'EAAB…example only', secret: true, visual: { type: 'illustration', path: ['WhatsApp', 'API Setup', 'Temporary access token', 'Copy token'], targetIndex: 3 }, help: 'In WhatsApp API Setup, create or copy an access token for the same Phone Number ID. Paste only the token value.' },
      { key: 'whatsappWebhookVerifyToken', label: 'Webhook Verify Token', example: '••••••••', secret: true, advanced: true, visual: { type: 'fallback', path: [], targetIndex: 0 }, help: 'This field is retained for existing manual configurations. Webhook verification is managed by the OdinLink server; change it only with OdinLink support.' },
    ],
  },
] as const;

export type IntegrationValues = Record<IntegrationFieldKey, string>;

export function getGuidedIntegrationFields(
  provider: IntegrationProviderDefinition,
): IntegrationFieldDefinition[] {
  return provider.fields.filter((field) => !field.advanced);
}

export function getInitialIntegrationValues(business: Business): IntegrationValues {
  return {
    calendarId: business.calendarId || '',
    timezone: business.timezone || '',
    instagramPageId: business.instagramPageId || '',
    instagramAccountId: business.instagramAccountId || '',
    instagramAccessToken: '',
    instagramWebhookVerifyToken: '',
    messengerPageId: business.messengerPageId || '',
    messengerAccessToken: '',
    messengerAppSecret: '',
    messengerWebhookVerifyToken: '',
    telegramToken: '',
    telegramAdminChatId: business.telegramAdminChatId || '',
    whatsappPhoneNumberId: business.whatsappPhoneNumberId || '',
    whatsappBusinessAccountId: business.whatsappBusinessAccountId || '',
    whatsappAccessToken: '',
    whatsappWebhookVerifyToken: '',
  };
}

export function getProviderPayload(
  provider: IntegrationProviderDefinition,
  values: IntegrationValues,
): Partial<Business> {
  return Object.fromEntries(
    provider.fields
      .filter((field) => (!field.secret && !field.preserveWhenBlank) || values[field.key].trim())
      .map((field) => [field.key, values[field.key]]),
  ) as Partial<Business>;
}

export function hasUnsavedProviderChanges(
  provider: IntegrationProviderDefinition,
  values: IntegrationValues,
  business: Business,
): boolean {
  const saved = getInitialIntegrationValues(business);
  return provider.fields.some((field) => field.secret
    ? Boolean(values[field.key].trim())
    : values[field.key] !== saved[field.key]);
}

export type IntegrationDisplayState = {
  label: 'Connected' | 'Not connected' | 'Needs attention' | 'Checking connection' | 'Connection failed';
  tone: 'connected' | 'disconnected' | 'attention' | 'checking' | 'error';
  verified: boolean;
};

export function getIntegrationDisplayState(
  health?: IntegrationHealth,
  checking = false,
): IntegrationDisplayState {
  if (checking || health?.status === 'checking') return { label: 'Checking connection', tone: 'checking', verified: false };
  if (health?.status === 'connected' || health?.status === 'synced') return { label: 'Connected', tone: 'connected', verified: true };
  if (health?.status === 'setup_required') return { label: 'Not connected', tone: 'disconnected', verified: false };
  if (health?.status === 'disconnected' || health?.status === 'error') return { label: 'Connection failed', tone: 'error', verified: false };
  return { label: 'Needs attention', tone: 'attention', verified: false };
}

export function missingRequiredFields(
  provider: IntegrationProviderDefinition,
  values: IntegrationValues,
  health?: IntegrationHealth,
): IntegrationFieldDefinition[] {
  const configuredBefore = health?.reasonCode !== 'not_configured' && health?.status !== 'setup_required';
  return provider.fields.filter((field) => {
    if (field.optional || field.advanced) return false;
    if (field.secret && configuredBefore && !values[field.key].trim()) return false;
    return !values[field.key].trim();
  });
}
