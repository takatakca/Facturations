# Resolver métier de mapping Wave vérifié

Le resolver part de l'**autorisation d'émission persistée** et recharge son snapshot immuable. L'appelant ne fournit jamais le brouillon.

Il vérifie ensuite en lecture seule :

- client Wave : même courriel que le snapshot et devise CAD;
- produit Wave : existe, vendu, non archivé;
- taxe Wave à la date de facture : même code, même taux, non composée, non archivée.

Le résultat est un mapping compatible avec le mapper strict snapshot → `InvoiceCreateInput`. Le token Wave est lié au resolver côté serveur et n'est jamais retourné.

Le resolver n'exécute aucune mutation. Les tests injectent des lecteurs synthétiques; le vrai compte Wave reste à valider séparément sur un environnement autorisé.
