'use strict';

// Injected exclusively by the disposable local TLS smoke fixture. Never used by app.js.
function loginDriver(lang, email, password, code) {
  return `
(async () => {
  try {
    const lang = ${JSON.stringify(lang)};
    if ((await fetch('/internal/workspaces/csrf')).status !== 401) throw Error('Anonymous workspace access');
    const formResponse = await fetch('/internal/login?lang=' + lang);
    const form = new DOMParser().parseFromString(await formResponse.text(), 'text/html');
    if (formResponse.status !== 200 || form.documentElement.lang !== lang ||
        !form.querySelector('input[name="code"]')) throw Error('MFA login form unavailable');
    const response = await fetch('/internal/login?lang=' + lang, { method: 'POST',
      credentials: 'same-origin', redirect: 'follow',
      body: new URLSearchParams({ email: ${JSON.stringify(email)},
        password: ${JSON.stringify(password)}, code: ${JSON.stringify(code)} }) });
    if (response.status !== 200 || new URL(response.url).pathname !== '/internal/dashboard')
      throw Error('MFA login failed');
    if (document.cookie.includes('__Host-facturations-session')) throw Error('Session cookie readable');
    location.replace('/smoke-editor?lang=' + lang);
  } catch (error) {
    document.documentElement.dataset.completeOwnerJourney = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;
}

function editorDriver(lang) {
  return `
(async () => {
  const lang = ${JSON.stringify(lang)};
  const get = id => document.getElementById(id);
  const wait = async (predicate, label) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('Timeout: ' + label);
  };
  const edit = (id, value) => {
    const element = get(id);
    if (!element) throw Error('Missing editor field: ' + id);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const parse = async response => new DOMParser().parseFromString(await response.text(), 'text/html');
  const checkedForm = (doc, count) => {
    const form = doc.querySelector('form[method="post"]');
    if (!form) throw Error('Explicit owner form missing');
    const checks = [...form.querySelectorAll('input[type="checkbox"]')];
    if (checks.length !== count || checks.some(check => check.checked))
      throw Error('Owner acknowledgement is not deliberate');
    for (const check of checks) check.checked = true;
    return new URLSearchParams(new FormData(form));
  };
  try {
    await wait(() => get('editing-fields') && !get('editing-fields').disabled &&
      get('save') && !get('save').disabled, 'editor ready');
    edit('customer', 'Fictional customer ' + lang);
    edit('email', 'review-' + lang + '@example.test');
    edit('line-1-description', 'Synthetic service');
    edit('line-1-quantity', '2');
    edit('line-1-price', '12,50');
    await wait(() => !get('preview').hidden &&
      /Revision 1|Révision 1/.test(get('status').textContent), 'autosave create');
    const previewLink = new URL(get('preview').href);
    const workspaceId = previewLink.pathname.split('/')[3];
    if (!/^[a-f0-9-]{36}$/.test(workspaceId)) throw Error('Invalid saved workspace');
    edit('notes', 'Second fictional revision ' + lang);
    await wait(() => !get('preview').hidden &&
      /Revision 2|Révision 2/.test(get('status').textContent), 'autosave update');
    const saved = await fetch('/internal/workspaces/' + workspaceId, { cache: 'no-store' });
    const workspace = await saved.json();
    if (saved.status !== 200 || workspace.revision !== 2 ||
      workspace.content.customer.email !== 'review-' + lang + '@example.test')
      throw Error('Autosaved workspace not durable');
    const preview = await fetch(previewLink.pathname + previewLink.search);
    const previewHtml = await preview.text();
    if (preview.status !== 200 || !previewHtml.includes('/internal/submit/' + workspaceId))
      throw Error('Owner submission link unavailable');
    const submissionUrl = '/internal/submit/' + workspaceId + '?lang=' + lang;
    const submission = await fetch(submissionUrl, { cache: 'no-store' });
    if (submission.status !== 200) throw Error('Saved revision not submittable');
    const submitForm = checkedForm(await parse(submission), 1);
    if (submitForm.get('confirmation') !== 'CREATE_IMMUTABLE_DRAFT_ONLY' ||
      submitForm.get('expectedRevision') !== '2' ||
      submitForm.get('expectedTotalCents') !== '2500') throw Error('Submission details mismatch');
    const converted = await fetch(submissionUrl, { method: 'POST', body: submitForm,
      credentials: 'same-origin', redirect: 'follow' });
    const reviewUrl = new URL(converted.url);
    if (converted.status !== 200 || !/^\/internal\/review\/[a-f0-9-]{36}$/.test(reviewUrl.pathname))
      throw Error('Immutable conversion failed');
    const printUrl = reviewUrl.pathname + '/print?lang=' + lang;
    if ((await fetch(printUrl)).status !== 409) throw Error('Printing allowed before approval');
    const review = await parse(converted);
    const reviewForm = checkedForm(review, 4);
    if (reviewForm.get('confirmation') !== 'APPROVE_DRAFT_ONLY' ||
      reviewForm.get('expectedTotalCents') !== '2500') throw Error('Owner approval details mismatch');
    const approved = await fetch(reviewUrl.pathname + reviewUrl.search, { method: 'POST',
      credentials: 'same-origin', body: reviewForm });
    if (approved.status !== 200 || !(await approved.text()).includes('internal'))
      throw Error('Internal approval was not saved');
    const reloaded = await fetch(reviewUrl.pathname + reviewUrl.search, { cache: 'no-store' });
    const reloadedDoc = await parse(reloaded);
    if (reloaded.status !== 200 || reloadedDoc.querySelector('form[method="post"]'))
      throw Error('Owner approval not persistent');
    const printable = await fetch(printUrl, { cache: 'no-store' });
    const printed = await printable.text();
    if (printable.status !== 200 ||
      !/BROUILLON NON ÉMIS|UNISSUED DRAFT/.test(printed) ||
      !printed.includes('review-' + lang + '@example.test'))
      throw Error('Unissued draft print access failed');
    if (document.cookie.includes('__Host-facturations-session')) throw Error('Session cookie readable');
    document.documentElement.dataset.completeOwnerJourney = 'passed';
  } catch (error) {
    document.documentElement.dataset.completeOwnerJourney = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;
}

module.exports = { loginDriver, editorDriver };
