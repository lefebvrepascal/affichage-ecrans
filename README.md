# Affichage — écrans connectés pour les établissements

[![Déployer sur Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/lefebvrepascal/affichage-ecrans)

**Installation en un clic :** cliquez sur le bouton ci-dessus, connectez-vous à Netlify (compte gratuit), choisissez un code d'installation, puis cliquez **Deploy**.
Au bout de 2 à 3 minutes, ouvrez `https://VOTRE-SITE.netlify.app/admin` et suivez l'écran **Installation** (étape 2 ci-dessous).

Application d'affichage dynamique, dans l'esprit d'OptiSigns, pour n'importe quel établissement :
une **console** pour gérer les contenus, et une **page écran** à ouvrir sur chaque TV.
Elle s'héberge gratuitement sur **Netlify** : aucun serveur à installer, les écrans ont seulement besoin d'Internet.

Chaque site Netlify a ses propres données : écrans, contenus, comptes. Une nouvelle installation démarre vide.

---

## 1. Déployer sans le bouton (méthode manuelle)

Il faut un compte Netlify gratuit (https://app.netlify.com) et **Node.js** installé sur l'ordinateur (https://nodejs.org, version LTS).

> Le glisser-déposer de dossier dans Netlify ne suffit pas : il ne publie pas la partie serveur (« functions »).
> Utilisez l'une des deux méthodes ci-dessous.

### Méthode A — en ligne de commande (la plus simple)

Ouvrez un terminal dans ce dossier, puis :

```
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

À la question « Create & configure a new project », choisissez **oui**, puis donnez un nom au site (ex. `affichage-mon-college`).
Publish directory : `public` (déjà indiqué dans `netlify.toml`).

### Méthode B — avec GitHub (mises à jour automatiques)

1. Mettez ce dossier dans un dépôt GitHub.
2. Netlify › **Add new project › Import an existing project** › choisissez le dépôt.
3. Laissez les réglages proposés (ils viennent de `netlify.toml`) et cliquez **Deploy**.

### Important : rendre le site accessible aux écrans

Dans Netlify › votre projet › **Project configuration › Access & security › Visitor access** :
vérifiez que l'accès n'est **pas** limité aux membres de l'équipe, sinon les TV ne pourront pas ouvrir la page.
La console reste protégée par ses propres comptes.

---

## 2. Installer (2 minutes)

1. Ouvrez `https://VOTRE-SITE.netlify.app/admin` **juste après le déploiement**.
2. L'écran **Installation** s'affiche : nom de l'établissement, votre nom, un identifiant et un mot de passe.
3. C'est tout : vous êtes connecté. Ajoutez vos collègues dans **Réglages & aide › Comptes administrateurs**.

**Code d'installation (recommandé) :** tant que le premier compte n'est pas créé, n'importe qui connaissant l'adresse pourrait le faire.
Avec le bouton « Déployer sur Netlify », Netlify vous demande un `SETUP_CODE` : choisissez un code secret, il sera exigé à l'écran d'installation.
Sans le bouton : *Project configuration › Environment variables* › ajouter `SETUP_CODE` (portée « Functions »), puis redéployer.

---

## 3. Mettre un écran en service

1. Connecter l'écran à Internet et ouvrir `https://VOTRE-SITE.netlify.app/` dans son navigateur.
2. Un code à 4 chiffres s'affiche : console › **Écrans** › saisir le code et un nom › **Appairer**.
3. Choisir la playlist, l'orientation, le bandeau, les créneaux horaires › **Enregistrer**.
4. OK sur la télécommande (ou un clic) pour passer en plein écran.
5. Si l'heure ou le bandeau sont coupés sur les bords : réglage **Marge** à 3 %.

**Fire TV :** navigateur *Silk* (simple) ou *Fully Kiosk Browser* installé via l'appli *Downloader* (recommandé : démarrage automatique, écran toujours allumé).
**Android TV / Google TV :** *Fully Kiosk Browser* depuis le Play Store.
**TV avec navigateur intégré :** la page écran est compatible avec les navigateurs anciens des TV.

---

## Fonctions

- **Écrans** : appairage par code, état en ligne, orientation paysage/portrait, marge anti-bords coupés, heure, bandeau défilant, commandes à distance (identifier, recharger), erreurs d'affichage signalées dans la console.
- **Contenus** : images, vidéos, annonces texte, pages web (`https://`), YouTube, horloge, **diaporamas PDF** (PowerPoint ou Keynote exportés en PDF : une page = une diapositive).
- **Playlists** et **programmation horaire** par écran.
- **Alerte générale** en plein écran sur tous les écrans (modèles Évacuation, Confinement, Information). Elle complète les signaux réglementaires et ne les remplace pas.
- **Comptes administrateurs** nominatifs, mot de passe provisoire à changer à la première connexion.

Limites : 300 Mo par fichier, 200 pages par diaporama ; mises à jour sur les écrans en 10 à 20 secondes.

---

## Pour les développeurs

| Élément | Rôle |
|---|---|
| `public/admin.html` | Console d'administration |
| `public/index.html` | Page écran — **générée**, ne pas modifier directement |
| `src/` | Sources de la page écran |
| `tools/build-player.mjs` | Génère `public/index.html` (CSS préfixé, JavaScript ES5 + compléments pour les vieux navigateurs de TV) |
| `netlify/functions/api.mts` | API : installation, comptes, écrans, contenus, playlists, alerte |
| `netlify/functions/media.mts` | Diffusion des médias (lecture par morceaux) |
| Netlify Blobs (store `affichage`) | Données et médias |

Après modification de `src/` : `cd tools && npm install && node build-player.mjs`, puis redéployer.
