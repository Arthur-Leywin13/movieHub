# MoviesHub Android

Application Android native en Kotlin + Jetpack Compose, avec une identité sombre et dorée inspirée de la maquette validée.

## Ouvrir le projet

Ouvre le dossier `apps/android` dans Android Studio, puis laisse Gradle synchroniser les dépendances.

- JDK 17
- Android SDK 35
- Gradle 8.9 ou version compatible avec Android Gradle Plugin 8.7.3

## Connexion à l'API

L'URL de développement est définie dans `app/build.gradle.kts` :

- Émulateur Android : `http://10.0.2.2:3000`
- Téléphone physique : remplace cette valeur par l'adresse IP locale de l'ordinateur qui exécute l'API.

L'API doit être démarrée et accessible depuis l'appareil. Le manifeste autorise HTTP en développement ; utilise HTTPS et désactive le trafic en clair avant une publication.

## État de cette première étape

- Interface Compose : écran d'ouverture, accueil, catégories, recherche, détails, lecteur préparatoire, téléchargements, partage et profil.
- Connexions publiques commencées : `GET /home` et `GET /search?q=`.
- Les affiches utilisent les URL renvoyées par l'API lorsqu'elles sont présentes.
- Authentification, favoris, téléchargements en arrière-plan, lecture Media3 et partage Wi-Fi direct/QR restent à connecter aux services correspondants.
- Les écrans qui ne sont pas encore reliés à un service affichent explicitement leur état préparatoire.

Cette étape est une fondation d'interface ; elle ne prétend pas fournir déjà le lecteur vidéo ou le transfert local complet.
