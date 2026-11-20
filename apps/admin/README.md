# MovieHub — Dashboard d’administration

Interface web d’administration du catalogue MovieHub. Cette première version est volontairement légère : HTML, CSS et JavaScript natifs, sans dépendance de build ni framework à installer.

## Fonctions disponibles

- Connexion avec un compte utilisateur possédant un rôle administrateur actif (`SUPER_ADMIN`, `ADMIN` ou `EDITOR`).
- Tableau de bord et compteurs de catalogue.
- Recherche, filtres et pagination du catalogue.
- Création de fiches Film, Série et Animé.
- Prévisualisation des modifications d’une fiche avant confirmation.
- Publication, dépublication, archivage et changements de statut autorisés par l’API.
- Création de saisons et d’épisodes ; ajout de versions vidéo aux films et aux épisodes.
- Association d’affiches et de bandes-annonces.
- Envoi direct vers Cloudflare R2 : fichiers IMAGE/SUBTITLE en envoi simple et VIDEO/TRAILER_VIDEO en multipart, avec vérification finale par l’API.
- Programmation des publications et annulation des actions en attente.
- Envoi de notifications dans la boîte de réception de l’application.
- Programmation et annulation de retraits de contenus.

Toutes les autorisations et transitions de statut sont vérifiées par l’API. Le navigateur ne peut pas accorder de rôle administrateur.

## Lancer en local

1. Démarrer l’API MoviesHub sur le port configuré (par défaut `3000`).
2. Ajouter temporairement `API_CORS_ORIGINS=http://localhost:4173` à la configuration de l’API puis redémarrer celle-ci. En production, utiliser uniquement l’origine HTTPS réelle du dashboard.\n3. Depuis la racine du dépôt, servir le dossier statique :

   ```bash
   python -m http.server 4173 --directory apps/admin
   ```

3. Ouvrir `http://localhost:4173`.
4. Dans le formulaire, indiquer l’URL de l’API (par défaut `http://localhost:3000`) et se connecter avec le compte administrateur.

Le serveur Python ne fait que servir les fichiers statiques. Il ne stocke aucun jeton et ne relaie aucune requête API.

## Configuration en production

- Héberger le dossier `apps/admin` sur un domaine HTTPS statique (par exemple Cloudflare Pages).
- Définir `API_CORS_ORIGINS` côté API avec l’origine exacte du dashboard, sans chemin ni slash final. Exemple : `https://admin.exemple.com`.
- Vérifier que l’URL publique de l’API est accessible en HTTPS depuis le navigateur.
- Pour l’envoi direct vers R2, configurer la politique CORS du bucket pour autoriser l’origine exacte du dashboard et la méthode `PUT`. Les liens signés sont créés par l’API ; les clés R2 ne sont jamais exposées au navigateur.
- Créer le premier compte administrateur au démarrage de l’API avec `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (12 caractères minimum) et `BOOTSTRAP_ADMIN_TELEGRAM_ID`. Ces variables doivent rester côté serveur.

## Sécurité et limites

- Les jetons d’accès et de rafraîchissement sont gardés dans `sessionStorage` : ils sont effacés à la fermeture de l’onglet/session du navigateur. Le jeton de rafraîchissement est renouvelé via `/auth/refresh`.
- La connexion est validée en appelant une route d’administration protégée ; un simple compte utilisateur ne suffit pas.
- Les opérations catalogue, médias, programmation et notifications utilisent les routes `/admin/*` déjà protégées et journalisées côté API.
- Les fichiers sont envoyés directement vers R2. Ne ferme pas l’onglet pendant un envoi multipart ; la reprise après fermeture de page n’est pas encore intégrée à l’interface.
- Les compteurs de statuts de la vue générale sont calculés sur les 50 premières fiches chargées ; le total affiché vient du nombre global renvoyé par l’API.
- Les journaux d’audit existent côté API, mais une page de consultation des journaux et une gestion des comptes/rôles administrateurs restent à développer.
- Les notifications sont actuellement des notifications internes à l’application ; l’envoi push FCM n’est pas inclus.
- N’envoie que des médias que MovieHub est autorisé à distribuer.
