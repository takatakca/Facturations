# Read-model du portail client

Ce read-model n’accepte jamais de customer_id provenant du navigateur.

Chaque lecture valide d’abord la session client passwordless, récupère le customer_id depuis cette session, impose le même business_id, exige une publication OWNER active, vérifie que le brouillon source appartient au même client, vérifie le SHA-256 du PDF qualifié publié et exclut toute publication révoquée.

## Données disponibles

La liste et le détail exposent uniquement le numéro officiel, les dates, la devise CAD, le total, l’ID et le hash du PDF qualifié publié, la date de publication et la projection financière lecture seule.

La projection financière conserve son proofScope. Une preuve synthétique n’est jamais présentée comme vérifiée.

## PDF

Le téléchargement retourne les octets du PDF qualifié uniquement lorsque la session appartient au client, la publication est active, l’ID de document correspond, le SHA-256 publié correspond au document stocké et le document est un QUALIFIED_INVOICE_PDF.

Une facture ou un PDF d’un autre client répond comme introuvable, sans révéler son existence.

## Frontière

Cette brique ne crée aucune route HTTP publique. Elle fournit seulement le read-model autorisé qui pourra être branché à une interface après validation navigateur et accessibilité.