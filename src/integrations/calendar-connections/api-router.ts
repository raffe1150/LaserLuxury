import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedRequest } from '../../auth/types';

import {
  buildGoogleCalendarAuthorizationUrl,
  exchangeGoogleCalendarCode,
} from './google-oauth';

import {
  disconnectCalendarConnection,
  getCalendarConnection,
  saveCalendarConnection,
} from './repository';

import {
  CALENDAR_AUTHORIZATION_COOKIE,
  CALENDAR_AUTHORIZATION_TTL_MS,
  calendarAuthorizationCookie,
  calendarDashboardReturnUrl,
  clearCalendarAuthorizationCookie,
  googleCalendarCallbackUrl,
  hashAuthorizationValue,
  parseCookie,
  randomAuthorizationValue,
} from './security';

type RouterOptions = {
  client: SupabaseClient;
  requireAuth: RequestHandler;
  requireBusinessPermission: (
    permission: 'settings.manage',
  ) => RequestHandler;
};

function asyncRoute(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    void handler(request, response, next).catch(next);
  };
}

function safeErrorCode(error: unknown): string {
  const code = String(
    (error as Error)?.message || 'calendar_connection_failed',
  );

  return /^[a-z0-9_:-]{1,100}$/i.test(code)
    ? code.replace(/:.*/, '')
    : 'calendar_connection_failed';
}

async function createAuthorizationSession(
  client: SupabaseClient,
  input: {
    businessId: number;
    userId: string;
    state: string;
    browserNonce: string;
    redirectUri: string;
  },
) {
  await client
    .from('calendar_authorization_sessions')
    .delete()
    .eq('business_id', input.businessId)
    .lt('expires_at', new Date().toISOString());

  const { error } = await client
    .from('calendar_authorization_sessions')
    .insert({
      business_id: input.businessId,
      user_id: input.userId,
      provider: 'google',
      state_hash: hashAuthorizationValue(input.state),
      browser_nonce_hash: hashAuthorizationValue(input.browserNonce),
      redirect_uri: input.redirectUri,
      expires_at: new Date(
        Date.now() + CALENDAR_AUTHORIZATION_TTL_MS,
      ).toISOString(),
    });

  if (error) throw error;
}

async function consumeAuthorizationSession(
  client: SupabaseClient,
  state: string,
  browserNonce: string,
) {
  const { data, error } = await client.rpc(
    'consume_calendar_authorization_session',
    {
      p_state_hash: hashAuthorizationValue(state),
      p_browser_nonce_hash: hashAuthorizationValue(browserNonce),
    },
  );

  if (error) throw error;

  const session = Array.isArray(data) ? data[0] : data;

  if (!session) {
    throw new Error('calendar_authorization_state_invalid');
  }

  if (session.redirect_uri !== googleCalendarCallbackUrl()) {
    throw new Error('calendar_authorization_redirect_mismatch');
  }

  return session;
}

async function assertAuthorizationOwnerStillActive(
  client: SupabaseClient,
  session: {
    business_id: unknown;
    user_id: unknown;
  },
) {
  const { data, error } = await client
    .from('business_memberships')
    .select('role,status')
    .eq('business_id', Number(session.business_id))
    .eq('user_id', String(session.user_id))
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw error;

  if (
    !data ||
    !['owner', 'admin', 'manager'].includes(String(data.role))
  ) {
    throw new Error('calendar_authorization_owner_inactive');
  }
}

export function createCalendarConnectionsRouter(
  options: RouterOptions,
): express.Router {
  const router = express.Router();

  const manage =
    options.requireBusinessPermission('settings.manage');

  router.get(
    '/:businessId',
    options.requireAuth,
    manage,
    asyncRoute(async (request, response) => {
      const businessId =
        (request as AuthenticatedRequest).businessAccess!.businessId;

      const connection = await getCalendarConnection(
        options.client,
        businessId,
      );

      response.json({
        success: true,
        data: connection,
      });
    }),
  );

  router.delete(
    '/:businessId/google',
    options.requireAuth,
    manage,
    asyncRoute(async (request, response) => {
      const businessId =
        (request as AuthenticatedRequest).businessAccess!.businessId;

      const disconnected =
        await disconnectCalendarConnection(
          options.client,
          businessId,
        );

      response.json({
        success: true,
        disconnected,
      });
    }),
  );

  router.post(
    '/:businessId/google/authorize',
    options.requireAuth,
    manage,
    asyncRoute(async (request, response) => {
      const authenticated = request as AuthenticatedRequest;

      const state = randomAuthorizationValue();
      const browserNonce = randomAuthorizationValue();
      const redirectUri = googleCalendarCallbackUrl();

      await createAuthorizationSession(options.client, {
        businessId:
          authenticated.businessAccess!.businessId,
        userId: authenticated.auth!.userId,
        state,
        browserNonce,
        redirectUri,
      });

      response.setHeader(
        'Set-Cookie',
        calendarAuthorizationCookie(browserNonce),
      );

      response.json({
        success: true,
        mode: 'redirect',
        authorizationUrl:
          buildGoogleCalendarAuthorizationUrl(
            state,
            redirectUri,
          ),
      });
    }),
  );

  router.get(
    '/google/callback',
    asyncRoute(async (request, response) => {
      const state = String(request.query.state || '');
      const code = String(request.query.code || '');

      const browserNonce =
        parseCookie(
          request.header('cookie'),
          CALENDAR_AUTHORIZATION_COOKIE,
        ) || '';

      try {
        if (
          !state ||
          !code ||
          !browserNonce ||
          request.query.error
        ) {
          throw new Error(
            'calendar_authorization_callback_invalid',
          );
        }

        const session =
          await consumeAuthorizationSession(
            options.client,
            state,
            browserNonce,
          );

        await assertAuthorizationOwnerStillActive(
          options.client,
          session,
        );

        const completed =
          await exchangeGoogleCalendarCode(
            code,
            session.redirect_uri,
          );

        if (!completed.refreshToken) {
          throw new Error(
            'google_calendar_refresh_token_missing',
          );
        }

        const selectedCalendar =
          completed.calendars.find(
            calendar => calendar.primary,
          ) || completed.calendars[0];

        await saveCalendarConnection(options.client, {
          businessId: Number(session.business_id),
          providerAccountId: selectedCalendar.id,
          calendarId: selectedCalendar.id,
          credential: {
            accessToken: completed.accessToken,
            refreshToken: completed.refreshToken,
            tokenType: completed.tokenType,
          },
          tokenExpiresAt: completed.expiresAt,
          grantedScopes: completed.grantedScopes,
          metadata: {
            display_name: selectedCalendar.name,
            time_zone: selectedCalendar.timeZone,
            available_calendars:
              completed.calendars.map(calendar => ({
                id: calendar.id,
                name: calendar.name,
                primary: calendar.primary,
                accessRole: calendar.accessRole,
                timeZone: calendar.timeZone,
              })),
          },
        });

        response.setHeader(
          'Set-Cookie',
          clearCalendarAuthorizationCookie(),
        );

        response.redirect(
          303,
          calendarDashboardReturnUrl('connected'),
        );
      } catch (error) {
        response.setHeader(
          'Set-Cookie',
          clearCalendarAuthorizationCookie(),
        );

        response.redirect(
          303,
          calendarDashboardReturnUrl(
            safeErrorCode(error),
          ),
        );
      }
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      console.error('[CalendarConnection]', {
        category: safeErrorCode(error),
      });

      response.status(500).json({
        error: safeErrorCode(error),
      });
    },
  );

  return router;
}
