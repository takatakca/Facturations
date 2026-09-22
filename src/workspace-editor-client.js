'use strict';

// Private same-origin browser client. No session, CSRF or customer data in browser storage.
(() => {
  const language = document.documentElement.lang === 'en' ? 'en' : 'fr';
  const COPY = {
    fr: {
      loading: 'Chargement de votre espace privé…', ready: 'Prêt. Aucune modification enregistrée pour le moment.',
      unsaved: 'Modifications non enregistrées.', saved: 'Enregistré sur le serveur. Révision ',
      pending: 'Enregistrement en cours…', unavailable: 'Service indisponible. Vos modifications restent dans ce formulaire.',
      unauthorized: 'Session expirée. Gardez cette page ouverte et reconnectez-vous dans un autre onglet.',
      conflict: 'Conflit de révision : rien n’a été remplacé. Copiez vos modifications avant de recharger la version enregistrée.',
      invalid: 'Vérifiez les champs : dates, articles complets, prix à deux décimales, rabais, taxes et taux à trois décimales. Rien n’a été enregistré.',
      incompatible: 'Ce contenu ne peut pas être édité sans risque sur cet écran limité à cinq articles. Aucune modification autorisée.',
      confirm: 'Recharger la version du serveur et perdre toutes les modifications non enregistrées ?',
      error: 'Erreur inattendue. Rien n’a été confirmé comme enregistré.',
    },
    en: {
      loading: 'Loading your private workspace…', ready: 'Ready. No changes saved yet.',
      unsaved: 'Unsaved changes.', saved: 'Saved on the server. Revision ',
      pending: 'Saving…', unavailable: 'Service unavailable. Your changes remain in this form.',
      unauthorized: 'Session expired. Keep this page open and sign in again in another tab.',
      conflict: 'Revision conflict: nothing was overwritten. Copy your changes before reloading the saved version.',
      invalid: 'Check dates, complete lines, two-decimal prices, discounts, tax codes and three-decimal tax rates. Nothing was saved.',
      incompatible: 'This content cannot be edited safely on this five-line screen. Editing is disabled.',
      confirm: 'Reload the server version and discard all unsaved changes?',
      error: 'Unexpected error. No save has been confirmed.',
    },
  };
  const t = COPY[language];
  const el = name => document.getElementById(name);
  const form = el('editor');
  const fields = el('editing-fields');
  const preview = el('preview');
  const customer = el('customer');
  const email = el('email');
  const address = el('address');
  const invoiceDate = el('invoiceDate');
  const dueDate = el('dueDate');
  const notes = el('notes');
  const save = el('save');
  const reload = el('reload');
  const status = el('status');
  const lineFields = Array.from({ length: 5 }, (_, i) => {
    const key = `line-${i + 1}-`;
    return { description: el(key + 'description'), quantity: el(key + 'quantity'),
      price: el(key + 'price'), discount: el(key + 'discount'), taxable: el(key + 'taxable') };
  });
  const taxFields = Array.from({ length: 3 }, (_, i) => {
    const key = `tax-${i + 1}-`;
    return { code: el(key + 'code'), label: el(key + 'label'), rate: el(key + 'rate') };
  });
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  let revision = null;
  let content = { currency: 'CAD', customer: {}, notes: '', lines: [], taxes: [] };
  const creationKey = crypto.randomUUID().replaceAll('-', '');
  let csrfToken = null;
  let dirty = false;
  let busy = false;
  let blocked = false;
  // An edit schedules one server save after a quiet period; never persist customer data locally.
  const AUTOSAVE_DELAY_MS = 3000;
  let autosaveTimer = null;
  let autosavePaused = false; // Stop silent retries after a conflict, expired session or outage.

  function cancelAutosave() {
    if (autosaveTimer !== null && typeof clearTimeout === 'function') clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  function scheduleAutosave() {
    cancelAutosave();
    if (blocked || busy || autosavePaused || typeof setTimeout !== 'function' ||
        typeof clearTimeout !== 'function') return;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      // The existing submit handler owns CSRF, creation idempotency, revision CAS and errors.
      if (!blocked && !busy && !autosavePaused && csrfToken && dirty &&
          (!id || revision !== null) && !fields.disabled && !save.disabled) form.requestSubmit();
    }, AUTOSAVE_DELAY_MS);
  }

  function message(value, error = false) {
    status.textContent = value;
    status.dataset.error = error ? 'true' : 'false';
  }
  function controls() {
    // A pending initial load or reload must never overwrite keystrokes entered mid-request.
    // After a failed initial load, the existing UUID is not safe to save until its revision loads.
    fields.disabled = blocked || busy || !csrfToken || Boolean(id && revision === null);
    save.disabled = blocked || busy || !csrfToken || !dirty || Boolean(id && revision === null);
    reload.disabled = blocked || busy || !id;
    const saved = !blocked && !busy && !dirty && Boolean(id) && Number.isSafeInteger(revision) && revision >= 1;
    preview.hidden = !saved;
    if (saved) preview.href = '/internal/workspaces/' + id + '/preview?lang=' + language;
  }
  function simple(value) { return value === undefined || value === null || typeof value === 'string'; }
  function allowedRecord(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).every(key => keys.includes(key));
  }
  function editable(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.currency !== undefined && value.currency !== 'CAD') ||
        !value.customer || typeof value.customer !== 'object' || Array.isArray(value.customer) ||
        !['name', 'email', 'address'].every(key => simple(value.customer[key])) ||
        !['notes', 'invoiceDate', 'dueDate'].every(key => simple(value[key])) ||
        (value.lines !== undefined && (!Array.isArray(value.lines) || value.lines.length > 5)) ||
        (value.taxes !== undefined && (!Array.isArray(value.taxes) || value.taxes.length > 3))) return false;
    if ((value.lines || []).some(line => !allowedRecord(line,
      ['description', 'quantity', 'unitPriceCents', 'discountCents', 'taxable']) ||
      !simple(line.description) ||
      ['quantity', 'unitPriceCents', 'discountCents'].some(key => line[key] !== undefined &&
        (!Number.isSafeInteger(line[key]) || line[key] < 0)) ||
      (line.taxable !== undefined && typeof line.taxable !== 'boolean'))) return false;
    return !(value.taxes || []).some(tax => !allowedRecord(tax,
      ['code', 'label', 'rateMilliPercent']) || !simple(tax.code) || !simple(tax.label) ||
      (tax.rateMilliPercent !== undefined && (!Number.isSafeInteger(tax.rateMilliPercent) ||
        tax.rateMilliPercent < 0 || tax.rateMilliPercent > 100000)));
  }
  function rowValid(row) {
    return row && uuid.test(row.id) && Number.isSafeInteger(row.revision) && row.revision >= 1 &&
      editable(row.content) && row.status === 'WORK_IN_PROGRESS' &&
      row.invoiceIssued === false && row.emailed === false;
  }
  function money(value) {
    return value === undefined || value === null ? '' :
      `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
  }
  function taxRate(value) {
    return value === undefined || value === null ? '' :
      `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`;
  }
  function apply(row) {
    if (!rowValid(row) || (id && row.id !== id)) {
      blocked = true;
      cancelAutosave();
      message(t.incompatible, true);
      controls();
      return false;
    }
    id = row.id;
    revision = row.revision;
    content = row.content;
    customer.value = row.content.customer.name ?? '';
    email.value = row.content.customer.email ?? '';
    address.value = row.content.customer.address ?? '';
    invoiceDate.value = row.content.invoiceDate ?? '';
    dueDate.value = row.content.dueDate ?? '';
    notes.value = row.content.notes ?? '';
    lineFields.forEach((field, index) => {
      const line = row.content.lines?.[index] || {};
      field.description.value = line.description ?? '';
      field.quantity.value = line.quantity === undefined || line.quantity === null ? '' : String(line.quantity);
      field.price.value = money(line.unitPriceCents);
      field.discount.value = money(line.discountCents);
      field.taxable.checked = line.taxable === true;
    });
    taxFields.forEach((field, index) => {
      const tax = row.content.taxes?.[index] || {};
      field.code.value = tax.code ?? '';
      field.label.value = tax.label ?? '';
      field.rate.value = taxRate(tax.rateMilliPercent);
    });
    dirty = false;
    autosavePaused = false;
    controls();
    message(t.saved + revision);
    return true;
  }
  function formSnapshot() {
    return JSON.stringify({
      customer: customer.value, email: email.value, address: address.value,
      invoiceDate: invoiceDate.value, dueDate: dueDate.value, notes: notes.value,
      lines: lineFields.map(field => ({ description: field.description.value,
        quantity: field.quantity.value, price: field.price.value,
        discount: field.discount.value, taxable: field.taxable.checked })),
      taxes: taxFields.map(field => ({ code: field.code.value,
        label: field.label.value, rate: field.rate.value })),
    });
  }
  function invalid() { const error = new Error('Invalid input'); error.status = 422; throw error; }
  function cents(raw) {
    const value = raw.trim();
    if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value)) invalid();
    const [whole, fraction = ''] = value.replace(',', '.').split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result > 100000000) invalid();
    return result;
  }
  function milliPercent(raw) {
    const value = raw.trim();
    if (!/^\d{1,3}(?:[.,]\d{1,3})?$/.test(value)) invalid();
    const [whole, fraction = ''] = value.replace(',', '.').split('.');
    const result = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
    if (result > 100000) invalid();
    return result;
  }
  function validDate(value) {
    if (!value) return true; // Partial working drafts may be saved without dates.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function payload() {
    if (!validDate(invoiceDate.value) || !validDate(dueDate.value) ||
        (invoiceDate.value && dueDate.value && dueDate.value < invoiceDate.value)) invalid();
    const lines = [];
    lineFields.forEach((field, index) => {
      const description = field.description.value.trim();
      const quantity = field.quantity.value.trim();
      const price = field.price.value.trim();
      const discount = field.discount.value.trim();
      if (!description && !quantity && !price && !discount && !field.taxable.checked) return;
      if (!description || description.length > 250 || !/^\d{1,4}$/.test(quantity)) invalid();
      const count = Number(quantity);
      if (count < 1 || count > 1000) invalid();
      const unitPriceCents = cents(price);
      const discountCents = discount ? cents(discount) : 0;
      if (discountCents > count * unitPriceCents) invalid();
      lines.push({ ...(content.lines?.[index] || {}), description,
        quantity: count, unitPriceCents, discountCents, taxable: field.taxable.checked });
    });
    const taxes = [];
    taxFields.forEach((field, index) => {
      const code = field.code.value.trim().toUpperCase();
      const label = field.label.value.trim();
      const rate = field.rate.value.trim();
      if (!code && !label && !rate) return;
      if (!/^[A-Z0-9_-]{1,20}$/.test(code) || !label || label.length > 80 ||
          taxes.some(tax => tax.code === code)) invalid();
      taxes.push({ ...(content.taxes?.[index] || {}), code, label,
        rateMilliPercent: milliPercent(rate) });
    });
    return { ...content, currency: 'CAD',
      customer: { ...content.customer, name: customer.value, email: email.value, address: address.value },
      invoiceDate: invoiceDate.value, dueDate: dueDate.value, notes: notes.value, lines, taxes };
  }
  async function request(path, options = {}) {
    const { headers = {}, ...rest } = options;
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...rest, headers: { Accept: 'application/json', ...headers } });
    if (!response.ok) { const error = new Error('Request rejected'); error.status = response.status; throw error; }
    return response.json();
  }
  function failure(error) {
    if (error.status === 401 || error.status === 403) message(t.unauthorized, true);
    else if (error.status === 409) message(t.conflict, true);
    else if (error.status === 422 || error.status === 413) message(t.invalid, true);
    else if (error.status === 503 || error.status === 502) message(t.unavailable, true);
    else message(t.error, true);
  }
  async function load() {
    cancelAutosave();
    if (!id) { dirty = true; message(t.ready); controls(); return; }
    busy = true; controls(); message(t.loading);
    try { apply(await request('/internal/workspaces/' + id)); }
    catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  form.addEventListener('input', () => {
    if (blocked) return;
    dirty = true;
    if (!busy) message(t.unsaved);
    controls();
    scheduleAutosave();
  });
  form.addEventListener('change', () => {
    if (blocked) return;
    dirty = true;
    if (!busy) message(t.unsaved);
    controls();
    scheduleAutosave();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    cancelAutosave();
    if (blocked || busy || !csrfToken || !dirty || (id && revision === null)) return;
    let data;
    try { data = payload(); } catch (error) { failure(error); return; }
    busy = true; controls(); message(t.pending);
    const before = formSnapshot();
    try {
      const path = id ? '/internal/workspaces/' + id : '/internal/workspaces';
      const body = id ? { expectedRevision: revision, content: data } : { creationKey, content: data };
      const row = await request(path, { method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Facturations-CSRF': csrfToken },
        body: JSON.stringify(body) });
      if (!rowValid(row) || (id && row.id !== id)) {
        blocked = true; message(t.incompatible, true); return;
      }
      id = row.id; revision = row.revision; content = row.content;
      // UUID is a locator, not a credential. No customer data enters the URL.
      history.replaceState(null, '', '/internal/editor?lang=' + language + '&id=' + id);
      dirty = formSnapshot() !== before;
      autosavePaused = false;
      message(dirty ? t.unsaved : t.saved + revision);
    } catch (error) {
      // No silent retries on conflict, revoked session or unavailable storage.
      // Invalid incomplete fields remain editable and can schedule after the next input.
      if (error.status !== 422 && error.status !== 413) autosavePaused = true;
      failure(error);
    }
    finally { busy = false; controls(); }
  });
  reload.addEventListener('click', async () => {
    if (!id || blocked || busy || (dirty && !confirm(t.confirm))) return;
    await load();
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.addEventListener('pagehide', cancelAutosave);
  async function start() {
    message(t.loading);
    if (id && !uuid.test(id)) { blocked = true; message(t.incompatible, true); controls(); return; }
    try {
      const value = await request('/internal/workspaces/csrf');
      if (!value || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) {
        throw new Error('Invalid CSRF response');
      }
      csrfToken = value.csrfToken;
      await load();
    } catch (error) { failure(error); }
    controls();
  }
  void start();
})();