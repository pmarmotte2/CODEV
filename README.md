# Assistant de CODEV

Application web locale ou le modele OpenAI joue le role du client dans une discussion de CODEV.
Le developpeur renseigne une evolution ou une correction en texte, ajoute optionnellement un PDF, puis laisse le client demarrer la discussion avec une premiere question sur le contenu.

Le profil de l'interlocuteur client est selectionnable avant le demarrage:

- Commercial
- Technique
- Responsable

Le fournisseur LLM est aussi selectionnable dans l'interface:

- OpenAI, avec une cle API OpenAI
- Copilot GitHub, via GitHub Models avec un fine-grained token GitHub ayant `Models` en lecture

## Installation

Sous Windows, lancer:

```cmd
install.bat
```

Ou manuellement:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Configuration

```powershell
$env:OPENAI_MODEL="gpt-4o-mini"
$env:GITHUB_MODELS_MODEL="openai/gpt-4.1"
```

Les tokens API sont saisis dans l'interface avant de demarrer la discussion.
`OPENAI_MODEL` et `GITHUB_MODELS_MODEL` sont optionnels.

## Lancement

Sous Windows:

```cmd
run.bat
```

Ou manuellement:

```powershell
uvicorn app:app --reload
```

Ouvrir ensuite `http://127.0.0.1:8000`.

## Micro

Le bouton micro utilise la reconnaissance vocale native du navigateur.
Il fonctionne surtout sur Chrome ou Edge, avec autorisation d'acces au bon micro.
L'audio n'est pas envoye au serveur: seul le texte reconnu est ajoute au champ reponse.

## Lecture vocale

La lecture des questions du client utilise la synthese vocale native du navigateur.
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
