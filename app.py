import os
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pypdf import PdfReader


OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GITHUB_MODELS_MODEL = os.getenv("GITHUB_MODELS_MODEL", "openai/gpt-4.1")
GITHUB_MODELS_BASE_URL = os.getenv(
    "GITHUB_MODELS_BASE_URL",
    "https://models.github.ai/inference",
)
MAX_PDF_CHARS = 20_000
MAX_DOCUMENT_CHARS = 60_000
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
        "label": "Responsable",
        "prompt": """
Profil client: responsable exigeant.
- Tu connais les grands principes mais tu n'entres pas dans les details d'implementation.
- Tu cherches les contradictions, les zones floues, les risques de planning et les engagements implicites.
- Tu demandes souvent si c'est vraiment maitrise, si c'est simple, et pourquoi ce n'est pas deja fait.
- Tu restes credible et professionnel, avec une posture insistante et orientee engagement.
""".strip(),
    },
}

app = FastAPI(title="Assistant de CODEV")
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_openai_client(api_token: str) -> OpenAI:
    token = api_token.strip() or os.getenv("OPENAI_API_KEY", "")
    if not token:
        raise HTTPException(
            status_code=400,
            detail="Le token API OpenAI est obligatoire.",
        )
    return OpenAI(api_key=token)


def get_github_models_client(api_token: str) -> OpenAI:
    token = api_token.strip() or os.getenv("GITHUB_MODELS_TOKEN", "")
    if not token:
        raise HTTPException(
            status_code=400,
            detail="Le token GitHub Models est obligatoire.",
        )
    return OpenAI(
        api_key=token,
        base_url=GITHUB_MODELS_BASE_URL,
        default_headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )


def get_llm_config(provider: str, api_token: str) -> tuple[OpenAI, str, str]:
    if provider == "openai":
        return get_openai_client(api_token), OPENAI_MODEL, "openai"
    if provider == "github_copilot":
        return get_github_models_client(api_token), GITHUB_MODELS_MODEL, "github_copilot"
    raise HTTPException(status_code=400, detail="Fournisseur LLM invalide.")


def extract_pdf_text(file: UploadFile | None, max_chars: int = MAX_PDF_CHARS) -> str:
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
    return text[:max_chars]


async def extract_project_document_text(files: list[UploadFile] | None) -> str:
    if not files:
        return ""

    sections: list[str] = []
    remaining_chars = MAX_DOCUMENT_CHARS
    for file in files:
        if remaining_chars <= 0:
            break

        filename = file.filename or "document"
        lowered = filename.lower()
        text = ""

        if lowered.endswith(".pdf"):
            file.file.seek(0)
            text = extract_pdf_text(file, remaining_chars)
        elif lowered.endswith((".md", ".markdown")):
            raw_content = await file.read()
            text = raw_content.decode("utf-8", errors="replace")
        else:
            continue

        text = text.strip()
        if not text:
            continue

        section = f"Document: {filename}\n{text[:remaining_chars]}"
        sections.append(section)
        remaining_chars -= len(section)

    return "\n\n---\n\n".join(sections)


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


def build_usage_report(
    usage: object | None,
    provider: str,
    model: str,
) -> dict[str, int | float | str]:
    prompt_tokens = get_nested_usage_value(usage, "prompt_tokens")
    completion_tokens = get_nested_usage_value(usage, "completion_tokens")
    total_tokens = get_nested_usage_value(usage, "total_tokens")
    prompt_details = get_nested_usage_value(usage, "prompt_tokens_details")
    cached_prompt_tokens = get_nested_usage_value(prompt_details, "cached_tokens")
    billable_prompt_tokens = max(prompt_tokens - cached_prompt_tokens, 0)

    cost_usd = 0.0
    if provider == "openai":
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
        "provider": provider,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "cached_prompt_tokens": cached_prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
    }


def get_client_profile(profile: str) -> dict[str, str]:
    return CLIENT_PROFILES.get(profile, CLIENT_PROFILES["sales"])


def build_system_prompt(
    change_description: str,
    change_document_text: str,
    project_document_text: str,
    profile: str,
) -> str:
    change_context = (
        f"\n\nDocument de l'evolution/correction extrait du PDF:\n{change_document_text}"
        if change_document_text
        else "\n\nAucun PDF d'evolution/correction n'a ete fourni."
    )
    project_context = (
        f"\n\nDocumentation projet disponible:\n{project_document_text}"
        if project_document_text
        else "\n\nAucune documentation projet n'a ete fournie."
    )
    description = change_description or "Aucune description texte n'a ete fournie."
    client_profile = get_client_profile(profile)
    return f"""
Tu joues le role du client dans une discussion de CODEV avec un developpeur.
Evolution ou correction presentee par le developpeur:
{description}
{change_context}
{project_context}

{client_profile["prompt"]}

Objectif:
- Te comporter comme un client metier credible, curieux et exigeant.
- Poser des questions sur le contenu fonctionnel, les impacts, les cas limites, les risques et les criteres d'acceptation.
- Utiliser la documentation uniquement si elle est fournie et pertinente.
- Quand la documentation projet apporte un point utile, t'en servir pour rendre tes remarques plus precises selon ton profil.
- Ne pas donner de solution technique a la place du developpeur.
- Creuser une seule zone d'incertitude a la fois pour garder un echange naturel.
- Rester en francais.

Format de reponse:
Reponds en 2 a 5 phrases maximum.
Termine toujours par une question claire au developpeur.
""".strip()


def build_answer_help_prompt(
    change_description: str,
    change_document_text: str,
    project_document_text: str,
) -> str:
    change_context = (
        f"\n\nDocument de l'evolution/correction extrait du PDF:\n{change_document_text}"
        if change_document_text
        else "\n\nAucun PDF d'evolution/correction n'a ete fourni."
    )
    project_context = (
        f"\n\nDocumentation projet disponible:\n{project_document_text}"
        if project_document_text
        else "\n\nAucune documentation projet n'a ete fournie."
    )
    description = change_description or "Aucune description texte n'a ete fournie."
    return f"""
Tu aides un developpeur a preparer sa reponse pendant une discussion de CODEV.
Evolution ou correction:
{description}
{change_context}
{project_context}

Objectif:
- Proposer une approche de reponse, sans rediger la reponse finale a sa place.
- T'appuyer sur la documentation projet si elle est disponible et pertinente.
- Identifier les points a clarifier, les arguments fonctionnels/techniques utiles et les risques a reconnaitre.
- Rester concret, court et actionnable.
- Rester en francais.

Format:
1. Angle de reponse conseille.
2. Points a verifier dans la documentation ou dans le code.
3. Formulations possibles, sous forme de fragments et non de reponse complete.
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
    llm_provider: Annotated[str, Form()] = "openai",
    api_token: Annotated[str, Form()] = "",
    history: Annotated[str, Form()] = "[]",
    agreement: Annotated[UploadFile | None, File()] = None,
    project_docs: Annotated[list[UploadFile] | None, File()] = None,
) -> dict[str, object]:
    change_document_text = extract_pdf_text(agreement)
    project_document_text = await extract_project_document_text(project_docs)
    if not topic.strip() and not change_document_text.strip():
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
            "content": build_system_prompt(
                topic.strip(),
                change_document_text,
                project_document_text,
                profile,
            ),
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

    client, model, provider = get_llm_config(llm_provider, api_token)
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.7,
    )

    content = response.choices[0].message.content or ""
    return {
        "reply": content.strip(),
        "usage": build_usage_report(response.usage, provider, model),
    }


@app.post("/api/help-answer")
async def help_answer(
    topic: Annotated[str, Form()],
    argument: Annotated[str, Form()] = "",
    profile: Annotated[str, Form()] = "sales",
    llm_provider: Annotated[str, Form()] = "openai",
    api_token: Annotated[str, Form()] = "",
    history: Annotated[str, Form()] = "[]",
    agreement: Annotated[UploadFile | None, File()] = None,
    project_docs: Annotated[list[UploadFile] | None, File()] = None,
) -> dict[str, object]:
    change_document_text = extract_pdf_text(agreement)
    project_document_text = await extract_project_document_text(project_docs)
    if not topic.strip() and not change_document_text.strip():
        raise HTTPException(
            status_code=400,
            detail="La description ou le PDF de l'evolution/correction est obligatoire.",
        )

    try:
        import json

        raw_history = json.loads(history)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Historique invalide.") from exc

    client_profile = get_client_profile(profile)
    messages = [
        {
            "role": "system",
            "content": build_answer_help_prompt(
                topic.strip(),
                change_document_text,
                project_document_text,
            ),
        },
        {
            "role": "user",
            "content": f"Profil actuel du client: {client_profile['label']}.",
        },
    ]
    for item in raw_history[-MAX_HISTORY_MESSAGES:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})

    draft = argument.strip()
    messages.append(
        {
            "role": "user",
            "content": (
                f"Voici mon brouillon de reponse: {draft}\nAide-moi a l'ameliorer sans repondre a ma place."
                if draft
                else "Aide-moi a preparer une reponse au dernier message du client sans repondre a ma place."
            ),
        }
    )

    client, model, provider = get_llm_config(llm_provider, api_token)
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.5,
    )

    content = response.choices[0].message.content or ""
    return {
        "reply": content.strip(),
        "usage": build_usage_report(response.usage, provider, model),
    }
