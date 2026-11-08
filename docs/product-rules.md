# Règles produit validées par le propriétaire

Source de vérité pour l'API, le dashboard, le bot et l'application Android. Les valeurs chiffrées sont les valeurs par défaut (modifiables depuis le dashboard quand c'est indiqué).

## Jetons

| Règle | Valeur |
|---|---|
| Pubs récompensées par jour | 3 |
| Jetons par pub récompensée | 2 (soit 6 jetons par jour au maximum) |
| Code promo | 15 jetons par code, créé dans le dashboard admin, utilisable une fois par utilisateur |

Plans sans publicité achetables avec des jetons :

| Jetons | Durée |
|---|---|
| 10 | 1 jour |
| 30 | 7 jours |
| 60 | 14 jours |

- **Un nouveau plan par jetons annule l'ancien plan par jetons encore actif.** Les jetons déjà dépensés ne sont pas remboursés. Conséquence à connaître : acheter 1 jour alors qu'il reste 12 jours fait perdre ces 12 jours. L'application doit donc afficher une confirmation avant l'achat quand un plan est déjà actif.
- Cette règle ne touche pas les droits sans pub issus d'un don ou accordés par un admin.
- Le crédit d'une pub récompensée n'a lieu qu'après la vérification côté serveur d'AdMob (SSV). Le plafond de 3 par jour est appliqué par le serveur, jamais par l'application.
- Le « jour » du plafond suit le fuseau `America/Port-au-Prince` par défaut (réglage `rewarded_ads`, à confirmer).
- Un utilisateur qui a déjà un plan sans pub peut continuer à regarder des pubs récompensées pour gagner des jetons (décision par défaut).

## Publicités

- Formats : bannière, interstitielle, récompensée, ouverture d'application.
- Au lancement : écran logo, puis publicité d'ouverture, puis l'application. Un utilisateur sans pub ne la voit pas.
- Les publicités vidéo démarrent automatiquement et **sans son**, sauf si l'utilisateur active le son (`User.adSoundEnabled`, faux par défaut).
- Interstitielles : délai minimal entre deux affichages (180 s par défaut, `AdPlacement.minIntervalSeconds`).
- Emplacements et activation : table `AdPlacement`, désactivables depuis le dashboard.

## Bot Telegram

- Fichiers jusqu'à 2 Go (2000 Mo, maximum Telegram) : voir `architecture.md`.

## Design

- Logo : `docs/design/logo.png`. Maquettes de 8 écrans : `docs/design/ui-mockups.png` (accueil, catégories, recherche, détail, lecteur/bande-annonce, téléchargements, partage, profil). Palette noir et or.
- Écarts entre les maquettes et le cahier des charges, à trancher avant la phase Android :
  - Fiche de détail : note (8.5/10), durée (2h 46min) et onglet Acteurs ne sont ni définis ni modélisés.
  - Catégories : tuiles avec image de fond (aucune image rattachée à `Genre`).
  - Sélecteur de qualité 480p / 720p / 1080p : géré comme plusieurs `VideoAsset` de même langue et de hauteurs différentes ; il apparaît sur l'écran bande-annonce, or une bande-annonce n'a qu'un fichier aujourd'hui.
