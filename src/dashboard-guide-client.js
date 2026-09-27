'use strict';

const DASHBOARD_GUIDE_CLIENT = String.raw`'use strict';
(() => {
  const STORAGE_KEY = 'takatak.facturations.guide.v1';
  const root = document.documentElement;
  const language = root.lang === 'en' ? 'en' : 'fr';
  const dialog = document.getElementById('product-tour');
  const openButton = document.getElementById('tour-open');
  const closeButton = document.getElementById('tour-skip');
  const backButton = document.getElementById('tour-back');
  const nextButton = document.getElementById('tour-next');
  const title = document.getElementById('tour-title');
  const text = document.getElementById('tour-text');
  const counter = document.getElementById('tour-counter');

  if (!dialog || !openButton || !closeButton || !backButton || !nextButton || !title || !text || !counter) return;

  const copy = {
    fr: {
      steps: [
        ['overview', 'Votre tableau de bord', 'Commencez ici pour voir vos brouillons, vos clients et le montant total des brouillons. Ces chiffres ne sont pas des revenus encaissés.'],
        ['new-draft', 'Créer un brouillon', 'Utilisez Nouveau brouillon pour préparer une facture. Rien n’est émis, envoyé ou payé à cette étape.'],
        ['saved-drafts', 'Retrouver votre travail', 'Mes brouillons enregistrés permet de reprendre un brouillon et de vérifier son état de sauvegarde.'],
        ['customers', 'Gérer les clients', 'Le répertoire clients est réservé aux rôles autorisés et permet de retrouver ou corriger les coordonnées sans modifier les anciennes copies immuables.'],
        ['review', 'Réviser avant émission', 'La révision propriétaire est séparée de l’émission. Une approbation ne déclenche jamais automatiquement un envoi ou un paiement.']
      ],
      step: 'Étape',
      of: 'sur',
      back: 'Retour',
      next: 'Suivant',
      finish: 'Terminer',
      skip: 'Passer le tutoriel'
    },
    en: {
      steps: [
        ['overview', 'Your dashboard', 'Start here to see drafts, customers and total draft value. These figures are not collected revenue.'],
        ['new-draft', 'Create a draft', 'Use New working draft to prepare an invoice. Nothing is issued, sent or paid at this stage.'],
        ['saved-drafts', 'Resume your work', 'My saved drafts lets you reopen a draft and verify its saved state.'],
        ['customers', 'Manage customers', 'The customer directory is limited to authorized roles and lets you find or correct contact details without rewriting immutable historical copies.'],
        ['review', 'Review before issuance', 'Owner review is separate from issuance. Approval never automatically sends an email or triggers a payment.']
      ],
      step: 'Step',
      of: 'of',
      back: 'Back',
      next: 'Next',
      finish: 'Finish',
      skip: 'Skip tutorial'
    }
  };

  const t = copy[language];
  const steps = t.steps.filter((entry) => document.querySelector('[data-guide-id="' + entry[0] + '"]'));
  let index = 0;
  let opener = null;
  let activeTarget = null;

  function rememberDone() {
    try { window.localStorage.setItem(STORAGE_KEY, 'done'); } catch { /* Preference only; fail silently. */ }
  }

  function hasCompleted() {
    try { return window.localStorage.getItem(STORAGE_KEY) === 'done'; } catch { return false; }
  }

  function clearHighlight() {
    if (activeTarget) activeTarget.removeAttribute('data-guide-active');
    activeTarget = null;
  }

  function renderStep() {
    clearHighlight();
    if (!steps.length) {
      dialog.close();
      return;
    }
    const current = steps[index];
    title.textContent = current[1];
    text.textContent = current[2];
    counter.textContent = t.step + ' ' + String(index + 1) + ' ' + t.of + ' ' + String(steps.length);
    backButton.textContent = t.back;
    closeButton.textContent = t.skip;
    nextButton.textContent = index === steps.length - 1 ? t.finish : t.next;
    backButton.disabled = index === 0;
    activeTarget = document.querySelector('[data-guide-id="' + current[0] + '"]');
    if (activeTarget) {
      activeTarget.setAttribute('data-guide-active', 'true');
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      activeTarget.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    }
    nextButton.focus();
  }

  function openTour({ automatic = false } = {}) {
    if (!steps.length || dialog.open) return;
    opener = automatic ? null : document.activeElement;
    index = 0;
    dialog.showModal();
    renderStep();
  }

  function finishTour() {
    rememberDone();
    clearHighlight();
    dialog.close();
  }

  openButton.addEventListener('click', () => openTour());
  backButton.addEventListener('click', () => {
    if (index > 0) {
      index -= 1;
      renderStep();
    }
  });
  nextButton.addEventListener('click', () => {
    if (index >= steps.length - 1) finishTour();
    else {
      index += 1;
      renderStep();
    }
  });
  closeButton.addEventListener('click', () => {
    rememberDone();
    clearHighlight();
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    clearHighlight();
    if (opener && typeof opener.focus === 'function') opener.focus();
  });
  dialog.addEventListener('cancel', () => {
    rememberDone();
    clearHighlight();
  });

  if (!hasCompleted()) window.setTimeout(() => openTour({ automatic: true }), 250);
})();
`;

module.exports = { DASHBOARD_GUIDE_CLIENT };
