import os
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pypdf import PdfReader


MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
MAX_PDF_CHARS = 20_000
MAX_HISTORY_MESSAGES = 12
DEFAULT_INPUT_PRICE_PER_1M = 0.15
DEFAULT_CACHED_INPUT_PRICE_PER_1M = 0.075
DEFAULT_OUTPUT_PRICE_PER_1M = 0.60
CLIENT_PROFILES = {
    "sales": {
        "label": "Commercial",
        "prompt": """
Profil client: commercial non technique.
- Tu comprends surtout les enjeux business, les delais, la promesse client et l'impact sur la vente.
- Tu ne comprends pas les details techniques et tu demandes souvent de reformuler simplement.
- Tu veux savoir ce qui change pour le client final, ce qui peut etre vendu, et ce qui peut mettre la relation commerciale en risque.
- Tes questions sont concretes, parfois approximatives, mais jamais techniques.
""".strip(),
    },
    "technical": {
        "label": "Technique",
        "prompt": """
Profil client: interlocuteur technique.
- Tu comprends les integrations, les donnees, les dependances, les environnements et les contraintes de production.
- Tu poses des questions precises sur les cas limites, les impacts techniques, la robustesse, les logs, les tests et les criteres de validation.
- Tu acceptes les explications techniques, mais tu demandes toujours le lien avec le besoin metier.
- Tu es exigeant sans etre agressif.
""".strip(),
    },
    "boss": {
        "label": "Chef casse-couille",
        "prompt": """
Profil client: chef casse-couille qui fait semblant de comprendre.
- Tu utilises parfois des mots techniques de travers pour donner l'impression que tu maitrises.
- Tu cherches les contradictions, les zones floues, les risques de planning et les engagements implicites.
- Tu demandes souvent si c'est vraiment maitrise, si c'est simple, et pourquoi ce n'est pas deja fait.
- Tu restes credible et professionnel, mais ta posture est volontairement insistante et un peu penible.
""".strip(),
    },
}

app = FastAPI(title="Assistant de CODEV")
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_client() -> OpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY est manquante dans l'environnement.",
        )
    return OpenAI()


def extract_pdf_text(file: UploadFile | None) -> str:
    if file is None:
        return ""

    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Le fichier doit etre un PDF.")

    try:
        reader = PdfReader(file.file)
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except Exception as exc:
        raise HTTPException(status_code=400, detail="PDF illisible ou invalide.") from exc

    text = "\n\n".join(page for page in pages if page)
    return text[:MAX_PDF_CHARS]


def get_price_per_1m(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def get_nested_usage_value(source: object, name: str) -> int:
    if source is None:
        return 0
    if isinstance(source, dict):
        value = source.get(name, 0)
    else:
        value = getattr(source, name, 0)
    return value or 0


def build_usage_report(usage: object | None) -> dict[str, int | float | str]:
    prompt_tokens = get_nested_usage_value(usage, "prompt_tokens")
    completion_tokens = get_nested_usage_value(usage, "completion_tokens")
    total_tokens = get_nested_usage_value(usage, "total_tokens")
    prompt_details = get_nested_usage_value(usage, "prompt_tokens_details")
    cached_prompt_tokens = get_nested_usage_value(prompt_details, "cached_tokens")
    billable_prompt_tokens = max(prompt_tokens - cached_prompt_tokens, 0)

    input_price = get_price_per_1m("OPENAI_INPUT_PRICE_PER_1M", DEFAULT_INPUT_PRICE_PER_1M)
    cached_input_price = get_price_per_1m(
        "OPENAI_CACHED_INPUT_PRICE_PER_1M",
        DEFAULT_CACHED_INPUT_PRICE_PER_1M,
    )
    output_price = get_price_per_1m("OPENAI_OUTPUT_PRICE_PER_1M", DEFAULT_OUTPUT_PRICE_PER_1M)

    cost_usd = (
        (billable_prompt_tokens * input_price)
        + (cached_prompt_tokens * cached_input_price)
        + (completion_tokens * output_price)
    ) / 1_000_000

    return {
        "model": MODEL,
        "prompt_tokens": prompt_tokens,
        "cached_prompt_tokens": cached_prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
    }


def get_client_profile(profile: str) -> dict[str, str]:
    return CLIENT_PROFILES.get(profile, CLIENT_PROFILES["sales"])


def build_system_prompt(change_description: str, document_text: str, profile: str) -> str:
    context = (
        f"\n\nDocument de reference extrait du PDF:\n{document_text}"
        if document_text
        else "\n\nAucun PDF de reference n'a ete fourni."
    )
    description = change_description or "Aucune description texte n'a ete fournie."
    client_profile = get_client_profile(profile)
    return f"""
Tu joues le role du client dans une discussion de CODEV avec un developpeur.
Evolution ou correction presentee par le developpeur:
{description}
{context}

{client_profile["prompt"]}

Objectif:
- Te comporter comme un client metier credible, curieux et exigeant.
- Poser des questions sur le contenu fonctionnel, les impacts, les cas limites, les risques et les criteres d'acceptation.
- Utiliser le PDF uniquement s'il est fourni et pertinent.
- Ne pas donner de solution technique a la place du developpeur.
- Creuser une seule zone d'incertitude a la fois pour garder un echange naturel.
- Rester en francais.

Format de reponse:
Reponds en 2 a 5 phrases maximum.
Termine toujours par une question claire au developpeur.
""".strip()


def build_opening_prompt() -> str:
    return """
Commence la discussion en tant que client.
Base-toi sur l'evolution ou la correction fournie et pose la premiere question utile au developpeur.
Ne demande pas de salutation ni de confirmation generale.
""".strip()


@app.get("/")
def index() -> FileResponse:
    return FileResponse("static/index.html")


@app.post("/api/negotiate")
async def negotiate(
    topic: Annotated[str, Form()],
    argument: Annotated[str, Form()] = "",
    profile: Annotated[str, Form()] = "sales",
    history: Annotated[str, Form()] = "[]",
    agreement: Annotated[UploadFile | None, File()] = None,
) -> dict[str, object]:
    document_text = extract_pdf_text(agreement)
    if not topic.strip() and not document_text.strip():
        raise HTTPException(
            status_code=400,
            detail="La description ou le PDF de l'evolution/correction est obligatoire.",
        )

    try:
        import json

        raw_history = json.loads(history)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Historique invalide.") from exc

    messages = [
        {
            "role": "system",
            "content": build_system_prompt(topic.strip(), document_text, profile),
        }
    ]
    for item in raw_history[-MAX_HISTORY_MESSAGES:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})

    if argument.strip():
        messages.append({"role": "user", "content": argument.strip()})
    elif raw_history:
        raise HTTPException(status_code=400, detail="La reponse du developpeur est obligatoire.")
    else:
        messages.append({"role": "user", "content": build_opening_prompt()})

    response = get_client().chat.completions.create(
        model=MODEL,
        messages=messages,
        temperature=0.7,
    )

    content = response.choices[0].message.content or ""
    return {"reply": content.strip(), "usage": build_usage_report(response.usage)}
