'use strict';

const GUIDES = Object.freeze({
  fr: Object.freeze({
    dashboard: Object.freeze({
      title: 'Tableau de bord',
      facts: Object.freeze([
        'Le bouton « Nouveau brouillon de travail » ouvre l’éditeur.',
        '« Mes brouillons enregistrés » ouvre les espaces de travail sauvegardés.',
        'Les outils « Répertoire clients » et « Réviser les brouillons » sont réservés aux parcours autorisés du propriétaire.',
        'Les montants du tableau de bord représentent des brouillons, pas des revenus ni des paiements reçus.',
      ]),
    }),
    'draft-editor': Object.freeze({
      title: 'Éditeur de brouillon',
      facts: Object.freeze([
        'L’éditeur sert à préparer un brouillon; il n’émet pas automatiquement une facture.',
        'Les calculs de l’aperçu sont refaits côté serveur par Facturations.',
        'Une soumission de brouillon crée un brouillon immuable seulement; l’émission exige un parcours propriétaire séparé.',
      ]),
    }),
    'saved-drafts': Object.freeze({
      title: 'Brouillons enregistrés',
      facts: Object.freeze([
        'Cette page sert à reprendre un espace de travail déjà sauvegardé.',
        'Un espace déjà soumis ne doit pas redevenir un brouillon modifiable trompeur; il est dirigé vers son parcours de révision.',
      ]),
    }),
    customers: Object.freeze({
      title: 'Répertoire clients',
      facts: Object.freeze([
        'Le répertoire clients est un outil autorisé côté propriétaire.',
        'La recherche et la consultation sont séparées des actions d’émission, d’envoi et de paiement.',
      ]),
    }),
    review: Object.freeze({
      title: 'Révision propriétaire',
      facts: Object.freeze([
        'La révision permet au propriétaire de vérifier un brouillon soumis.',
        'Une approbation interne ne signifie pas qu’une facture a été émise, envoyée, payée ou synchronisée avec Wave.',
        'L’autorisation d’émission est un contrôle séparé.',
      ]),
    }),
    'client-portal': Object.freeze({
      title: 'Portail client',
      facts: Object.freeze([
        'Le portail client est un parcours distinct du tableau de bord du personnel.',
        'L’assistant ne doit jamais prétendre qu’une facture a été publiée au portail sans confirmation du parcours prévu.',
      ]),
    }),
    assistant: Object.freeze({
      title: 'Assistant Facturations',
      facts: Object.freeze([
        'Le mode « Aide » explique le produit.',
        'Le mode « Préparer un brouillon » peut produire un aperçu structuré à partir d’une description.',
        'Un aperçu préparé par IA reste PREVIEW_ONLY: rien n’est sauvegardé, émis ou envoyé.',
        'Pour poursuivre manuellement, utiliser le lien « Ouvrir l’éditeur ».',
      ]),
    }),
    settings: Object.freeze({
      title: 'Paramètres',
      facts: Object.freeze([
        'Aucune procédure de paramètre sensible n’est autorisée dans le guide actuel.',
        'Ne jamais demander de mot de passe, clé API, secret MFA, URL de base de données ou donnée de carte.',
      ]),
    }),
    unknown: Object.freeze({
      title: 'Écran non identifié',
      facts: Object.freeze([
        'Le guide ne connaît pas l’écran courant.',
        'Répondre seulement avec des informations générales confirmées sur Facturations; ne pas inventer de bouton ou de parcours.',
      ]),
    }),
  }),
  en: Object.freeze({
    dashboard: Object.freeze({
      title: 'Dashboard',
      facts: Object.freeze([
        'The “New working draft” button opens the editor.',
        '“My saved drafts” opens saved workspaces.',
        '“Customer directory” and “Review drafts” are restricted to authorized owner workflows.',
        'Dashboard amounts represent drafts, not revenue or payments received.',
      ]),
    }),
    'draft-editor': Object.freeze({
      title: 'Draft editor',
      facts: Object.freeze([
        'The editor prepares a draft; it does not automatically issue an invoice.',
        'Preview calculations are recalculated server-side by Facturations.',
        'Submitting a draft creates an immutable draft only; issuance requires a separate owner workflow.',
      ]),
    }),
    'saved-drafts': Object.freeze({
      title: 'Saved drafts',
      facts: Object.freeze([
        'This page is used to resume a previously saved workspace.',
        'A submitted workspace must not reopen as a misleading editable draft; it is redirected to its review workflow.',
      ]),
    }),
    customers: Object.freeze({
      title: 'Customer directory',
      facts: Object.freeze([
        'The customer directory is an authorized owner-side tool.',
        'Search and viewing are separate from invoice issuance, delivery and payment actions.',
      ]),
    }),
    review: Object.freeze({
      title: 'Owner review',
      facts: Object.freeze([
        'Owner review is used to verify a submitted draft.',
        'Internal approval does not mean an invoice was issued, sent, paid or synchronized with Wave.',
        'Issuance authorization is a separate control.',
      ]),
    }),
    'client-portal': Object.freeze({
      title: 'Client portal',
      facts: Object.freeze([
        'The client portal is separate from the staff dashboard.',
        'The assistant must never claim that an invoice was published to the portal without confirmation from the intended workflow.',
      ]),
    }),
    assistant: Object.freeze({
      title: 'Facturations Assistant',
      facts: Object.freeze([
        'Help mode explains the product.',
        'Prepare a draft mode can produce a structured preview from a description.',
        'An AI-prepared preview remains PREVIEW_ONLY: nothing is saved, issued or sent.',
        'Use “Open editor” to continue manually.',
      ]),
    }),
    settings: Object.freeze({
      title: 'Settings',
      facts: Object.freeze([
        'No sensitive settings procedure is authorized in the current guide.',
        'Never request a password, API key, MFA secret, database URL or payment-card data.',
      ]),
    }),
    unknown: Object.freeze({
      title: 'Unknown screen',
      facts: Object.freeze([
        'The guide does not know the current screen.',
        'Answer only with confirmed general Facturations information; do not invent a button or workflow.',
      ]),
    }),
  }),
});

function getProductGuide(language, screenId) {
  if (!Object.hasOwn(GUIDES, language)) throw new TypeError('Unsupported guide language');
  const localized = GUIDES[language];
  const guide = Object.hasOwn(localized, screenId) ? localized[screenId] : localized.unknown;
  return Object.freeze({
    version: 1,
    language,
    screenId: Object.hasOwn(localized, screenId) ? screenId : 'unknown',
    title: guide.title,
    facts: Object.freeze([...guide.facts]),
  });
}

module.exports = { getProductGuide };
