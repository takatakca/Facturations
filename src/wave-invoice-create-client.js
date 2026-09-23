'use strict';

const WAVE_GRAPHQL_URL = 'https://gql.waveapps.com/graphql/public';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CREATE_DRAFT_MUTATION = `mutation TakatakCreateDraftInvoice($input: InvoiceCreateInput!) {
  invoiceCreate(input: $input) {
    didSucceed
    inputErrors { code message path }
    invoice {
      id
      invoiceNumber
      status
      invoiceDate
      dueDate
      customer { id }
      currency { code }
      total { value }
    }
  }
}`;

class WaveInvoiceCreateError extends Error {
  constructor(code, statusCode, classification = 'FINAL') {
    super(code);
    this.name = 'WaveInvoiceCreateError';
    this.code = code;
    this.statusCode = statusCode;
    this.classification = classification;
  }
}

function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000_000_000) {
    throw new WaveInvoiceCreateError('INVALID_MONEY', 422);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function decimalToCents(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.test(text)) {
    throw new WaveInvoiceCreateError('WAVE_INVALID_TOTAL', 502, 'AMBIGUOUS');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) {
    throw new WaveInvoiceCreateError('WAVE_INVALID_TOTAL', 502, 'AMBIGUOUS');
  }
  return cents;
}
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      plan.status !== 'READY_FOR_WAVE_ADAPTER' ||
      plan.operation !== 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY' ||
      plan.currency !== 'CAD' ||
      typeof plan.businessId !== 'string' || !plan.businessId ||
      typeof plan.customerId !== 'string' || !plan.customerId ||
      typeof plan.invoiceDate !== 'string' || typeof plan.dueDate !== 'string' ||
      !Array.isArray(plan.items) || !plan.items.length ||
      !plan.expected || !Number.isSafeInteger(plan.expected.totalCents)) {
    throw new WaveInvoiceCreateError('INVALID_WAVE_PLAN', 422);
  }
  for (const item of plan.items) {
    if (!item || typeof item.productId !== 'string' || !item.productId ||
        typeof item.description !== 'string' || !item.description ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
        !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 ||
        !Array.isArray(item.salesTaxIds) ||
        item.salesTaxIds.some(id => typeof id !== 'string' || !id)) {
      throw new WaveInvoiceCreateError('INVALID_WAVE_PLAN', 422);
    }
  }
  return plan;
}
function buildVariables(plan) {
  validatePlan(plan);
  return Object.freeze({
    input: Object.freeze({
      businessId: plan.businessId,
      customerId: plan.customerId,
      status: 'DRAFT',
      currency: 'CAD',
      invoiceDate: plan.invoiceDate,
      dueDate: plan.dueDate,
      ...(plan.memo ? { memo: plan.memo } : {}),
      items: plan.items.map(item => Object.freeze({
        productId: item.productId,
        description: item.description,
        quantity: String(item.quantity),
        unitPrice: centsToDecimal(item.unitPriceCents),
        taxes: item.salesTaxIds.map(salesTaxId => Object.freeze({ salesTaxId })),
      })),
    }),
  });
}
async function readLimitedJson(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new WaveInvoiceCreateError('WAVE_CREATE_INVALID_RESPONSE', 502, 'AMBIGUOUS');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new WaveInvoiceCreateError('WAVE_CREATE_RESPONSE_TOO_LARGE', 502, 'AMBIGUOUS');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WaveInvoiceCreateError) throw error;
    throw new WaveInvoiceCreateError('WAVE_CREATE_INVALID_RESPONSE', 502, 'AMBIGUOUS');
  } finally {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
  }
}

async function createWaveDraftInvoice({
  token,
  plan,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof token !== 'string' || token.length < 1) {
    throw new WaveInvoiceCreateError('WAVE_NOT_CONFIGURED', 503, 'FINAL');
  }
  if (typeof fetchImpl !== 'function') {
    throw new WaveInvoiceCreateError('EXPLICIT_WAVE_TRANSPORT_REQUIRED', 503, 'FINAL');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new WaveInvoiceCreateError('INVALID_TIMEOUT', 422);
  }
  const variables = buildVariables(plan);
  let response;
  try {
    response = await fetchImpl(WAVE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: CREATE_DRAFT_MUTATION, variables }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new WaveInvoiceCreateError('WAVE_CREATE_TRANSPORT_AMBIGUOUS', 504, 'AMBIGUOUS');
  }

  if (response.status === 401) {
    throw new WaveInvoiceCreateError('WAVE_AUTH_FAILED', 502, 'FINAL');
  }
  if (response.status === 403) {
    throw new WaveInvoiceCreateError('WAVE_ACCESS_DENIED', 502, 'FINAL');
  }
  if (response.status === 429) {
    throw new WaveInvoiceCreateError('WAVE_RATE_LIMITED', 503, 'RETRYABLE');
  }
  if (!response.ok) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_UPSTREAM_AMBIGUOUS', 502, 'AMBIGUOUS');
  }

  const payload = await readLimitedJson(response);
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_GRAPHQL_AMBIGUOUS', 502, 'AMBIGUOUS');
  }
  const result = payload?.data?.invoiceCreate;
  if (!result || typeof result.didSucceed !== 'boolean' || !Array.isArray(result.inputErrors)) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_INVALID_RESPONSE', 502, 'AMBIGUOUS');
  }
  if (!result.didSucceed) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_REJECTED', 422, 'FINAL');
  }
  if (result.inputErrors.length) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_INVALID_RESPONSE', 502, 'AMBIGUOUS');
  }

  const invoice = result.invoice;
  if (!invoice || typeof invoice.id !== 'string' || !invoice.id ||
      typeof invoice.invoiceNumber !== 'string' || !invoice.invoiceNumber ||
      invoice.status !== 'DRAFT' ||
      invoice.invoiceDate !== plan.invoiceDate ||
      invoice.dueDate !== plan.dueDate ||
      invoice.customer?.id !== plan.customerId ||
      invoice.currency?.code !== 'CAD') {
    throw new WaveInvoiceCreateError('WAVE_CREATE_MISMATCH', 502, 'AMBIGUOUS');
  }
  const totalCents = decimalToCents(invoice.total?.value);
  if (totalCents !== plan.expected.totalCents) {
    throw new WaveInvoiceCreateError('WAVE_CREATE_TOTAL_MISMATCH', 409, 'AMBIGUOUS');
  }

  return Object.freeze({
    provider: 'WAVE',
    providerInvoiceId: invoice.id,
    officialInvoiceNumber: invoice.invoiceNumber,
    status: 'DRAFT_CREATED_AT_PROVIDER',
    totalCents,
    approved: false,
    sent: false,
  });
}

module.exports = {
  createWaveDraftInvoice,
  WaveInvoiceCreateError,
  CREATE_DRAFT_MUTATION,
  WAVE_GRAPHQL_URL,
  buildWaveDraftVariables: buildVariables,
};
