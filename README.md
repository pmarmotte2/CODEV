# Simulateur de negociation

Application web locale ou le modele OpenAI joue le role de la direction.
L'utilisateur choisit un sujet, ajoute optionnellement un accord PDF, puis avance ses arguments.

## Installation

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Configuration

```powershell
$env:OPENAI_API_KEY="votre-cle-api"
$env:OPENAI_MODEL="gpt-4o-mini"
```

`OPENAI_MODEL` est optionnel. Par defaut, l'application utilise `gpt-4o-mini`.

## Lancement

```powershell
uvicorn app:app --reload
```

Ouvrir ensuite `http://127.0.0.1:8000`.

## Micro

Le bouton micro utilise la reconnaissance vocale native du navigateur.
Il fonctionne surtout sur Chrome ou Edge, avec autorisation d'acces au bon micro.
L'audio n'est pas envoye au serveur: seul le texte reconnu est ajoute au champ argument.

## Lecture vocale

La lecture des reponses utilise la synthese vocale native du navigateur.
Elle tourne localement avec les voix installees ou exposees par le navigateur.
Le panneau de gauche permet d'activer/desactiver la lecture, de choisir une voix et d'arreter la lecture en cours.

## Compteur de cout

Le compteur de session est incremente apres chaque appel a l'API OpenAI.
Il utilise les tokens retournes par l'API et les tarifs par defaut de `gpt-4o-mini`:

- input: `$0.15` par million de tokens
- input cache: `$0.075` par million de tokens
- output: `$0.60` par million de tokens

Ces tarifs peuvent etre surcharges avec:

```powershell
$env:OPENAI_INPUT_PRICE_PER_1M="0.15"
$env:OPENAI_CACHED_INPUT_PRICE_PER_1M="0.075"
$env:OPENAI_OUTPUT_PRICE_PER_1M="0.60"
```
