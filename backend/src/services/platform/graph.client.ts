import { env } from '../../config/env';
import { loggerFor } from '../../observability/logger';

const log = loggerFor('graph');

/**
 * A thin client for Meta's Graph API, covering the calls a Tech Provider makes.
 *
 * Everything a Tech Provider does on a customer's behalf happens here, so there
 * is exactly one place that knows Meta's URL shapes, error envelope and token
 * rules. The rest of the platform deals in plain objects.
 *
 * Two tokens exist and must not be confused:
 *
 *   - The APP token (our app id + secret) exchanges an Embedded Signup code.
 *   - The BUSINESS token returned by that exchange acts on the customer's
 *     account and is what every later call for that tenant uses.
 */

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
    readonly fbtraceId: string | null
  ) {
    super(message);
    this.name = 'GraphApiError';
  }

  /**
   * Error 200 means the app lacks permission on an account it does not own —
   * in practice, that `whatsapp_business_management` has not been granted
   * Advanced access through App Review. It is called out because it is the
   * single most common Tech Provider failure and the message Meta returns
   * ("Permissions error") does not say so.
   */
  get isMissingAdvancedAccess(): boolean {
    return this.code === 200 || this.code === 10;
  }

  /** Token expired, revoked, or the user changed their password. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.code === 190;
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_msg?: string;
  };
}

const base = () => `https://graph.facebook.com/${env.metaGraphVersion}`;

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; token: string; body?: unknown; query?: Record<string, string> }
): Promise<T> {
  const { method = 'GET', token, body, query } = options;

  const url = new URL(`${base()}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.metaTimeoutMs);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T & GraphErrorBody) : ({} as T & GraphErrorBody);

    if (!response.ok) {
      const error = parsed.error ?? {};
      // error_user_msg is the message Meta intends an end user to read; it is
      // far more actionable than `message` when present.
      const message = error.error_user_msg ?? error.message ?? `Graph API returned ${response.status}`;

      log.warn(
        { path, status: response.status, code: error.code, fbtrace: error.fbtrace_id },
        'graph api error'
      );

      throw new GraphApiError(
        response.status,
        error.code ?? null,
        error.error_subcode ?? null,
        message,
        error.fbtrace_id ?? null
      );
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Embedded Signup --------------------------------------------------------

/**
 * Exchanges the short-lived code returned by Embedded Signup for the business
 * token that acts on the customer's account.
 *
 * This is deliberately a server-to-server call: it needs the app secret, which
 * must never be in the browser bundle. The browser only ever sees the code.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const url = new URL(`${base()}/oauth/access_token`);
  url.searchParams.set('client_id', env.metaAppId);
  url.searchParams.set('client_secret', env.metaAppSecret);
  url.searchParams.set('code', code);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.metaTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = (await response.json()) as { access_token?: string } & GraphErrorBody;

    if (!response.ok || !payload.access_token) {
      const error = payload.error ?? {};
      throw new GraphApiError(
        response.status,
        error.code ?? null,
        error.error_subcode ?? null,
        error.message ?? 'Code exchange did not return an access token.',
        error.fbtrace_id ?? null
      );
    }

    return payload.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

// --- account and number inspection -----------------------------------------

export interface WabaDetails {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  owner_business_info?: { id?: string; name?: string };
}

export async function getWabaDetails(wabaId: string, token: string): Promise<WabaDetails> {
  return request<WabaDetails>(`/${wabaId}`, {
    token,
    query: { fields: 'id,name,currency,timezone_id,owner_business_info' },
  });
}

export interface PhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
}

export async function listPhoneNumbers(wabaId: string, token: string): Promise<PhoneNumber[]> {
  const result = await request<{ data: PhoneNumber[] }>(`/${wabaId}/phone_numbers`, {
    token,
    query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type' },
  });
  return result.data ?? [];
}

// --- the two calls that actually make a number work -------------------------

/**
 * Registers the number for Cloud API with a two-step-verification PIN.
 *
 * Skipped for coexistence onboarding, where the number is already registered
 * because it was in use in the WhatsApp Business app. Meta returns an error
 * saying so, which the caller treats as success rather than failure.
 */
export async function registerPhoneNumber(
  phoneNumberId: string,
  token: string,
  pin: string
): Promise<void> {
  await request(`/${phoneNumberId}/register`, {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', pin },
  });
}

/**
 * Subscribes OUR app to the customer's account webhooks.
 *
 * Without this nothing is ever delivered — and nothing in Meta's dashboard
 * says so. It is the step that silently breaks most integrations, including
 * this one during development, which is why it is called explicitly and its
 * result is persisted on the connection.
 */
export async function subscribeApp(wabaId: string, token: string): Promise<void> {
  await request(`/${wabaId}/subscribed_apps`, { method: 'POST', token });
}

export async function listSubscribedApps(
  wabaId: string,
  token: string
): Promise<Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }>> {
  const result = await request<{ data: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }> }>(
    `/${wabaId}/subscribed_apps`,
    { token }
  );
  return result.data ?? [];
}

// --- messaging --------------------------------------------------------------

export interface SendTextOptions {
  phoneNumberId: string;
  token: string;
  to: string;
  body: string;
}

export async function sendText(options: SendTextOptions): Promise<string> {
  const result = await request<{ messages?: Array<{ id?: string }> }>(
    `/${options.phoneNumberId}/messages`,
    {
      method: 'POST',
      token: options.token,
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: options.to.replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body: options.body },
      },
    }
  );

  const id = result.messages?.[0]?.id;
  if (!id) throw new Error('Graph API accepted the message but returned no id.');
  return id;
}

export interface SendTemplateOptions {
  phoneNumberId: string;
  token: string;
  to: string;
  templateName: string;
  language: string;
  variables?: string[];
}

/**
 * Sends an approved template.
 *
 * Templates are the only way to open a conversation that the customer did not
 * start, which is why a broadcast must use one and cannot use free text.
 */
export async function sendTemplate(options: SendTemplateOptions): Promise<string> {
  const components = options.variables?.length
    ? [
        {
          type: 'body',
          parameters: options.variables.map((text) => ({ type: 'text', text })),
        },
      ]
    : undefined;

  const result = await request<{ messages?: Array<{ id?: string }> }>(
    `/${options.phoneNumberId}/messages`,
    {
      method: 'POST',
      token: options.token,
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: options.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: options.templateName,
          language: { code: options.language },
          ...(components ? { components } : {}),
        },
      },
    }
  );

  const id = result.messages?.[0]?.id;
  if (!id) throw new Error('Graph API accepted the template but returned no id.');
  return id;
}

// --- templates --------------------------------------------------------------

export interface CreateTemplateOptions {
  wabaId: string;
  token: string;
  name: string;
  language: string;
  category: string;
  header?: string;
  body: string;
  footer?: string;
  bodyExamples?: string[];
}

export async function createTemplate(options: CreateTemplateOptions): Promise<{ id: string; status: string }> {
  const components: Array<Record<string, unknown>> = [];

  if (options.header) components.push({ type: 'HEADER', format: 'TEXT', text: options.header });

  const bodyComponent: Record<string, unknown> = { type: 'BODY', text: options.body };
  // Meta rejects a template containing {{1}} unless an example value is given
  // for every variable, so examples are supplied whenever variables exist.
  if (options.bodyExamples?.length) {
    bodyComponent.example = { body_text: [options.bodyExamples] };
  }
  components.push(bodyComponent);

  if (options.footer) components.push({ type: 'FOOTER', text: options.footer });

  return request<{ id: string; status: string }>(`/${options.wabaId}/message_templates`, {
    method: 'POST',
    token: options.token,
    body: {
      name: options.name,
      language: options.language,
      category: options.category,
      components,
    },
  });
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejected_reason?: string;
}

export async function listTemplates(wabaId: string, token: string): Promise<MetaTemplate[]> {
  const result = await request<{ data: MetaTemplate[] }>(`/${wabaId}/message_templates`, {
    token,
    query: { fields: 'id,name,language,status,category,rejected_reason', limit: '200' },
  });
  return result.data ?? [];
}
