# Test réel de Cloudflare R2

Ce test envoie de vrais fichiers à ton vrai bucket R2, les relit, vérifie leur contenu, puis les supprime. Aucune simulation. Il se lance depuis GitHub, sans commande locale.

## 1. Préparer R2 (tableau de bord Cloudflare)

1. **R2 Object Storage → Create bucket.** Nom conseillé : `movieshub-test` (un bucket dédié aux tests ; le bucket de production viendra plus tard). Laisse l'accès public **désactivé**.
2. **Account ID** : affiché sur la page R2 (panneau « Account details »), et dans l'adresse `dash.cloudflare.com/<ACCOUNT_ID>/r2`.
3. **Clés d'accès S3** : R2 → **Manage API tokens → Create API token**.
   - Permission : **Object Read & Write**.
   - Portée : uniquement le bucket de test.
   - Tu obtiens un **Access Key ID** et un **Secret Access Key** (affiché une seule fois). Ce sont ces deux valeurs qu'il faut, pas la « valeur du jeton Cloudflare ».
4. Facultatif mais conseillé : dans le bucket, **Settings → Object lifecycle rules** : ajouter « Abort incomplete multipart uploads » après 1 jour (évite que des envois interrompus occupent de l'espace).

## 2. Ajouter les 4 secrets dans GitHub

Dépôt → **Settings → Secrets and variables → Actions → New repository secret**. Noms exacts :

| Nom | Valeur |
|---|---|
| `R2_ACCOUNT_ID` | ton Account ID |
| `R2_ACCESS_KEY_ID` | l'Access Key ID |
| `R2_SECRET_ACCESS_KEY` | le Secret Access Key |
| `R2_BUCKET` | `movieshub-test` |

Ne colle jamais ces valeurs dans un message, un fichier du dépôt ou un journal.

## 3. Lancer le test

Onglet **Actions → « R2 réel » → Run workflow**. Compte 1 à 2 minutes. Vert = R2 validé en réel. Rouge = ouvre l'étape en échec et envoie-moi son journal.

## Ce que le test vérifie

- Envoi unique, lecture par lien signé, taille et contenu identiques (SHA-256).
- Nom de fichier de téléchargement (`attachment`).
- Lien altéré, lien expiré, adresse sans signature et mauvaise clé secrète : tous refusés. (L'adresse testée est le point d'accès S3 ; l'accès public par `r2.dev` ou domaine personnalisé n'est pas couvert : garde-le désactivé.)
- Envoi multipart (5 Mio + 1 Kio) : liste des morceaux, finalisation, intégrité du fichier final.
- Envoi multipart abandonné puis annulé.
- Parcours complet du service d'envoi : vidéo de 20 Mio en 2 morceaux (16 + 4 Mio), reprise après un morceau manquant, refus de finaliser un envoi incomplet, finalisation, annulation ; image en envoi unique.

## Ce qu'il crée et supprime

Environ 60 Mio écrits au total, sous le préfixe `ci-live-test/` (et `video/`, `image/` pour le parcours du service), puis supprimés à la fin, même si un test échoue. Coût : négligeable. Si une exécution est interrompue brutalement, supprime à la main ce qui reste sous ces préfixes.

## Ce que ce test ne couvre pas

Les très gros fichiers (2 Go) : la logique de morceaux est la même, mais aucun fichier de cette taille n'est envoyé. À tester à la main avec le bot ou le dashboard quand ils existeront.
