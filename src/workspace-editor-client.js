'use strict';

// Browser-only, same-origin client. Never store session/CSRF tokens or customer data in browser storage.
(() => {
  const language = document.documentElement.lang === 'en' ? 'en' : 'fr';
  const COPY = {
    fr: {
      loading: 'Chargement de votre espace privé…', ready: 'Prêt. Aucune modification enregistrée pour le moment.',
      unsaved: 'Modifications non enregistrées.', saved: 'Enregistré sur le serveur. Révision ',
      pending: 'Enregistrement en cours…', unavailable: 'Service indisponible. Vos modifications restent dans ce formulaire.',
      unauthorized: 'Session expirée. Gardez cette page ouverte et reconnectez-vous dans un autre onglet.',
      conflict: 'Conflit de révision : rien n’a été remplacé. Copiez vos modifications avant de recharger la version enregistrée.',
      invalid: 'Le serveur a refusé ces données. Corrigez les champs; rien n’a été enregistré.',
      incompatible: 'Ce contenu ne peut pas être édité sans risque sur cet écran. Aucune modification autorisée.',
      confirm: 'Recharger la version du serveur et perdre toutes les modifications non enregistrées ?', error: 'Erreur inattendue. Rien n’a été confirmé comme enregistré.',
    },
    en: {
      loading: 'Loading your private workspace…', ready: 'Ready. No changes saved yet.',
      unsaved: 'Unsaved changes.', saved: 'Saved on the server. Revision ',
      pending: 'Saving…', unavailable: 'Service unavailable. Your changes remain in this form.',
      unauthorized: 'Session expired. Keep this page open and sign in again in another tab.',
      conflict: 'Revision conflict: nothing was overwritten. Copy your changes before reloading the saved version.',
      invalid: 'The server rejected these fields. Correct the inputs; nothing was saved.',
      incompatible: 'This content cannot be edited safely on this screen. Editing is disabled.',
      confirm: 'Reload the server version and discard all unsaved changes?', error: 'Unexpected error. No save has been confirmed.',
    },
  };
  const t = COPY[language];
  const form = document.getElementById('editor');
  const customer = document.getElementById('customer');
  const notes = document.getElementById('notes');
  const save = document.getElementById('save');
  const reload = document.getElementById('reload');
  const status = document.getElementById('status');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  let revision = null;
  let content = { currency: 'CAD', customer: {}, notes: '' };
  let creationKey = crypto.randomUUID().replaceAll('-', '');
  let csrfToken = null;
  let dirty = false;
  let busy = false;
  let blocked = false;

  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = error ? 'true' : 'false';
  }
  function controls() {
    save.disabled = blocked || busy || !csrfToken || !dirty;
    reload.disabled = blocked || busy || !id;
  }
  function editable(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      (!Object.hasOwn(value, 'customer') ||
        (value.customer && typeof value.customer === 'object' && !Array.isArray(value.customer))) &&
      (value.notes === undefined || value.notes === null || typeof value.notes === 'string') &&
      (value.customer?.name === undefined || value.customer.name === null || typeof value.customer.name === 'string');
  }
  function apply(row) {
    if (!row || !uuid.test(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        !editable(row.content) || row.status !== 'WORK_IN_PROGRESS' || row.invoiceIssued !== false || row.emailed !== false) {
      blocked = true;
      message(t.incompatible, true);
      controls();
      return false;
    }
    id = row.id;
    revision = row.revision;
    content = row.content;
    customer.value = row.content.customer?.name ?? '';
    notes.value = row.content.notes ?? '';
    dirty = false;
    controls();
    message(t.saved + revision);
    return true;
  }
  function payload() {
    // Preserve all undisplayed fields (lines, taxes, customer email/address, etc.).
    return { ...content, customer: { ...content.customer, name: customer.value }, notes: notes.value };
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...options.headers }, ...options });
    if (!response.ok) {
      const error = new Error('Request rejected');
      error.status = response.status;
      throw error;
    }
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
    if (!id) { dirty = true; message(t.ready); controls(); return; }
    busy = true;
    controls();
    message(t.loading);
    try { apply(await request('/internal/workspaces/' + id)); }
    catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  form.addEventListener('input', () => {
    if (blocked || busy) return;
    dirty = true;
    message(t.unsaved);
    controls();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (blocked || busy || !csrfToken || !dirty) return;
    busy = true;
    controls();
    message(t.pending);
    const before = { customer: customer.value, notes: notes.value };
    try {
      const data = payload();
      const path = id ? '/internal/workspaces/' + id : '/internal/workspaces';
      const body = id ? { expectedRevision: revision, content: data } : { creationKey, content: data };
      const row = await request(path, { method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Facturations-CSRF': csrfToken },
        body: JSON.stringify(body),
      });
      if (!row || !uuid.test(row.id) || !Number.isSafeInteger(row.revision) || !editable(row.content) ||
          row.status !== 'WORK_IN_PROGRESS' || row.invoiceIssued !== false || row.emailed !== false) {
        blocked = true;
        message(t.incompatible, true);
        return;
      }
      id = row.id;
      revision = row.revision;
      content = row.content;
      // The UUID is only a locator, not a secret or a credential; no customer data enters the URL.
      history.replaceState(null, '', '/internal/editor?lang=' + language + '&id=' + id);
      const changedWhileSaving = customer.value !== before.customer || notes.value !== before.notes;
      dirty = changedWhileSaving;
      message(changedWhileSaving ? t.unsaved : t.saved + revision);
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  });
  reload.addEventListener('click', async () => {
    if (!id || blocked || busy || (dirty && !confirm(t.confirm))) return;
    await load();
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
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
