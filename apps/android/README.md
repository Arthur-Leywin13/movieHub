# MoviesHub Android

Application Android native en Kotlin + Jetpack Compose, avec une identité sombre et dorée inspirée de la maquette validée.

## Ouvrir le projet

Ouvre le dossier `apps/android` dans Android Studio, puis laisse Gradle synchroniser les dépendances.

- JDK 17
- Android SDK 35
- Gradle 8.9 / Android Gradle Plugin 8.7.3

## Connexion à l'API

L'URL de l'API est configurable avec la propriété Gradle `movieshubApiBaseUrl` :

- Émulateur Android par défaut : `http://10.0.2.2:3000`
- API déployée sur Railway : utilise son domaine HTTPS public.

Exemple depuis `apps/android` : `./gradlew :app:assembleDebug -PmovieshubApiBaseUrl=https://TON-DOMAINE-API.up.railway.app`

L'API doit être démarrée et accessible depuis l'appareil. Le manifeste autorise HTTP en développement ; utilise HTTPS et désactive le trafic en clair avant une publication.

## Test de transfert cloud

Dans Téléchargements, ouvre **Transfert cloud (test)**. Connecte-toi, choisis une vidéo de 40 Mio maximum, puis partage le lien généré. Sur le deuxième appareil, connecte-toi au même backend, colle le lien et lance la réception. Le fichier reçu est placé dans `downloads/shared`, dans l'espace privé de l'application.

Le transfert utilise le fournisseur configuré par l'API (`TRANSFER_STORAGE_PROVIDER`). Les URL de partage sont temporaires ; ce parcours de test ne reprend pas encore un upload interrompu.

## État de cette étape

- Interface Compose : écran d'ouverture, accueil, catégories, recherche, détails, lecteur, téléchargements, partage et profil.
- Connexions publiques : `GET /home`, `GET /contents`, `GET /contents/:slugOuId` et `GET /search?q=`.
- Lecteur AndroidX Media3 opérationnel pour les URL HTTPS de bandes-annonces renvoyées par la fiche publique.
- Les affiches utilisent les URL renvoyées par l'API lorsqu'elles sont présentes.
- Lecture des films complets : nécessite une authentification et l'obtention d'un lien temporaire via `POST /versions/:id/download`.
- Authentification, téléchargement local en arrière-plan, partage Wi-Fi direct/QR, favoris et historique restent à connecter.

Le workflow GitHub Actions `.github/workflows/android.yml` compile l'APK debug sur les changements Android. Le test réel R2 reste volontairement reporté.


Build de validation: chaque mise à jour de ce dossier déclenche la compilation Android sur GitHub Actions et publie l'APK debug en artifact (conservation 14 jours).
