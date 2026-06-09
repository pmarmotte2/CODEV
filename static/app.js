const form = document.querySelector("#negotiation-form");
const topicInput = document.querySelector("#topic");
const profileInput = document.querySelector("#profile");
const llmProviderInput = document.querySelector("#llm-provider");
const apiTokenInput = document.querySelector("#api-token");
const tokenHintNode = document.querySelector("#token-hint");
const argumentInput = document.querySelector("#argument");
const agreementInput = document.querySelector("#agreement");
const projectDocsInput = document.querySelector("#project-docs");
const projectDocDirectoryInput = document.querySelector("#project-doc-directory");
const messagesNode = document.querySelector("#messages");
const sendButton = document.querySelector("#send");
const startButton = document.querySelector("#start");
const resetButton = document.querySelector("#reset");
const microphoneButton = document.querySelector("#microphone");
const helpAnswerButton = document.querySelector("#help-answer");
const microphoneStatus = document.querySelector("#microphone-status");
const autoReadInput = document.querySelector("#auto-read");
const voiceSelect = document.querySelector("#voice");
const stopVoiceButton = document.querySelector("#stop-voice");
const costUsdNode = document.querySelector("#cost-usd");
const costCallsNode = document.querySelector("#cost-calls");
const costInputNode = document.querySelector("#cost-input");
const costOutputNode = document.querySelector("#cost-output");
const costTotalNode = document.querySelector("#cost-total");

let history = [];
let hasStarted = false;
let documentSessionId = "";
let documentSessionSignature = "";
let recognition = null;
let isListening = false;
let transcriptBase = "";
let finalTranscript = "";
let latestInterimTranscript = "";
let silenceTimer = null;
let shouldAutoSubmitAfterRecognition = false;
let sessionUsage = {
  calls: 0,
  promptTokens: 0,
  cachedPromptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  hasUnpricedProvider: false,
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynthesizer = window.speechSynthesis;
const SILENCE_TIMEOUT_MS = 2000;

function appendMessage(role, content) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const author = document.createElement("strong");
  author.textContent =
    role === "user"
      ? "Developpeur"
      : role === "error"
        ? "Erreur"
        : role === "helper"
          ? "Aide"
          : "Client";

  const body = document.createElement("p");
  body.textContent = content;

  message.append(author, body);
  messagesNode.append(message);
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function setLoading(isLoading) {
  sendButton.disabled = isLoading || !hasStarted;
  helpAnswerButton.disabled = isLoading || !hasStarted;
  startButton.disabled = isLoading || hasStarted;
  sendButton.textContent = isLoading ? "Question en cours..." : "Envoyer la reponse";
  startButton.textContent = isLoading ? "Client en cours..." : "Demarrer la discussion";
}

function setComposerEnabled(isEnabled) {
  argumentInput.disabled = !isEnabled;
  microphoneButton.disabled = !isEnabled || !recognition;
  helpAnswerButton.disabled = !isEnabled;
  sendButton.disabled = !isEnabled;
}

function setSetupEnabled(isEnabled) {
  topicInput.disabled = !isEnabled;
  llmProviderInput.disabled = !isEnabled;
  apiTokenInput.disabled = !isEnabled;
  agreementInput.disabled = !isEnabled;
  projectDocsInput.disabled = !isEnabled;
  projectDocDirectoryInput.disabled = !isEnabled;
}

function hasSourceContent() {
  return Boolean(topicInput.value.trim() || agreementInput.files[0]);
}

function hasApiToken() {
  return Boolean(apiTokenInput.value.trim());
}

function getProjectDocumentFiles() {
  const selectedFiles = [...projectDocsInput.files];
  const directoryFiles = [...projectDocDirectoryInput.files].filter((file) => {
    const name = file.name.toLowerCase();
    return name.endsWith(".md") || name.endsWith(".markdown");
  });
  return [...selectedFiles, ...directoryFiles];
}

function getProjectDocumentSignature(files) {
  return files
    .map((file) => `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`)
    .join("|");
}

async function ensureDocumentSession() {
  const files = getProjectDocumentFiles();
  if (files.length === 0) {
    documentSessionId = "";
    documentSessionSignature = "";
    return;
  }

  const signature = getProjectDocumentSignature(files);
  if (documentSessionId && documentSessionSignature === signature) {
    return;
  }

  const payload = new FormData();
  payload.append("llm_provider", llmProviderInput.value);
  payload.append("api_token", apiTokenInput.value.trim());
  for (const file of files) {
    payload.append("project_docs", file, file.webkitRelativePath || file.name);
  }

  const response = await fetch("/api/document-session", {
    method: "POST",
    body: payload,
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || "Documentation projet invalide.");
  }

  documentSessionId = data.document_session_id;
  documentSessionSignature = signature;
  setMicrophoneStatus(
    `Documentation indexee: ${data.sources} source(s), ${data.chunks} extrait(s), mode ${data.retrieval_mode}.`,
  );
}

function buildPayload(argument = "") {
  const payload = new FormData();
  payload.append("topic", topicInput.value.trim());
  payload.append("profile", profileInput.value);
  payload.append("llm_provider", llmProviderInput.value);
  payload.append("api_token", apiTokenInput.value.trim());
  payload.append("argument", argument);
  payload.append("history", JSON.stringify(history));
  payload.append("document_session_id", documentSessionId);
  if (agreementInput.files[0]) {
    payload.append("agreement", agreementInput.files[0]);
  }
  return payload;
}

function renderProviderHelp() {
  const isGithubCopilot = llmProviderInput.value === "github_copilot";
  apiTokenInput.placeholder = isGithubCopilot ? "github_pat_..." : "sk-...";
  if (isGithubCopilot) {
    tokenHintNode.textContent = "";
    tokenHintNode.append(
      document.createTextNode("Utilisez un fine-grained token GitHub avec Models en lecture. "),
    );
    const link = document.createElement("a");
    link.href =
      "https://github.com/settings/personal-access-tokens/new?name=CODEV%20GitHub%20Models&user_models=read";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Creer le token";
    tokenHintNode.append(link);
  } else {
    tokenHintNode.textContent = "Utilisez une cle API OpenAI.";
  }
}

function setMicrophoneStatus(message, isError = false) {
  microphoneStatus.textContent = message;
  microphoneStatus.classList.toggle("error-text", isError);
}

function formatInteger(value) {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function renderSessionUsage() {
  costUsdNode.textContent = sessionUsage.hasUnpricedProvider
    ? "n/a"
    : `$${sessionUsage.costUsd.toFixed(6)}`;
  costCallsNode.textContent = formatInteger(sessionUsage.calls);
  costInputNode.textContent = formatInteger(sessionUsage.promptTokens);
  costOutputNode.textContent = formatInteger(sessionUsage.completionTokens);
  costTotalNode.textContent = formatInteger(sessionUsage.totalTokens);
}

function addSessionUsage(usage) {
  if (!usage) {
    return;
  }

  sessionUsage.calls += 1;
  sessionUsage.promptTokens += usage.prompt_tokens || 0;
  sessionUsage.cachedPromptTokens += usage.cached_prompt_tokens || 0;
  sessionUsage.completionTokens += usage.completion_tokens || 0;
  sessionUsage.totalTokens += usage.total_tokens || 0;
  sessionUsage.costUsd += usage.cost_usd || 0;
  sessionUsage.hasUnpricedProvider ||= usage.provider !== "openai";
  renderSessionUsage();
}

function resetSessionUsage() {
  sessionUsage = {
    calls: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    hasUnpricedProvider: false,
  };
  renderSessionUsage();
}

function getFrenchVoices() {
  if (!speechSynthesizer) {
    return [];
  }

  const voices = speechSynthesizer.getVoices();
  const frenchVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("fr"));
  return frenchVoices.length ? frenchVoices : voices;
}

function populateVoices() {
  const voices = getFrenchVoices();
  voiceSelect.innerHTML = "";

  if (!speechSynthesizer || voices.length === 0) {
    voiceSelect.disabled = true;
    stopVoiceButton.disabled = true;
    const option = document.createElement("option");
    option.textContent = "TTS non disponible";
    voiceSelect.append(option);
    return;
  }

  voiceSelect.disabled = false;
  stopVoiceButton.disabled = false;
  voices.forEach((voice, index) => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (index === 0) {
      option.selected = true;
    }
    voiceSelect.append(option);
  });
}

function getSelectedVoice() {
  return getFrenchVoices().find((voice) => voice.voiceURI === voiceSelect.value) || null;
}

function speakText(text) {
  if (!speechSynthesizer || !autoReadInput.checked || !text.trim()) {
    return;
  }

  speechSynthesizer.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  utterance.rate = 1;
  utterance.pitch = 1;

  const selectedVoice = getSelectedVoice();
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  }

  speechSynthesizer.speak(utterance);
}

function setListening(nextIsListening) {
  isListening = nextIsListening;
  microphoneButton.classList.toggle("is-listening", isListening);
  microphoneButton.setAttribute("aria-pressed", String(isListening));
  microphoneButton.textContent = isListening ? "Arreter le micro" : "Demarrer le micro";
}

function renderTranscript(interimTranscript = "") {
  const spokenText = `${finalTranscript} ${interimTranscript}`.trim();
  argumentInput.value = `${transcriptBase} ${spokenText}`.trim();
  argumentInput.focus();
}

function resetTranscriptState() {
  transcriptBase = "";
  finalTranscript = "";
  latestInterimTranscript = "";
  shouldAutoSubmitAfterRecognition = false;
}

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

function scheduleSilenceStop() {
  clearSilenceTimer();
  silenceTimer = setTimeout(() => {
    if (!recognition || !isListening) {
      return;
    }

    shouldAutoSubmitAfterRecognition = true;
    setMicrophoneStatus("Silence detecte, envoi de la reponse...");
    recognition.stop();
  }, SILENCE_TIMEOUT_MS);
}

function setupSpeechRecognition() {
  if (!SpeechRecognition) {
    setComposerEnabled(false);
    setMicrophoneStatus("Reconnaissance vocale non supportee par ce navigateur.", true);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.addEventListener("start", () => {
    transcriptBase = argumentInput.value.trim();
    finalTranscript = "";
    latestInterimTranscript = "";
    shouldAutoSubmitAfterRecognition = false;
    setListening(true);
    setMicrophoneStatus("Ecoute en cours...");
    scheduleSilenceStop();
  });

  recognition.addEventListener("result", (event) => {
    let interimTranscript = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) {
        finalTranscript = `${finalTranscript} ${transcript}`.trim();
        latestInterimTranscript = "";
      } else {
        interimTranscript = `${interimTranscript} ${transcript}`.trim();
      }
    }

    latestInterimTranscript = interimTranscript;
    renderTranscript(interimTranscript);
    setMicrophoneStatus(interimTranscript ? `Brouillon: ${interimTranscript}` : "Ecoute en cours...");
    scheduleSilenceStop();
  });

  recognition.addEventListener("end", () => {
    clearSilenceTimer();
    setListening(false);
    if (!finalTranscript && latestInterimTranscript) {
      finalTranscript = latestInterimTranscript;
      latestInterimTranscript = "";
    }
    if (finalTranscript) {
      renderTranscript();
      if (shouldAutoSubmitAfterRecognition) {
        shouldAutoSubmitAfterRecognition = false;
        if (hasStarted && hasSourceContent() && argumentInput.value.trim()) {
          form.requestSubmit();
        } else {
          setMicrophoneStatus("Texte ajoute. Demarrez la discussion avant l'envoi.", true);
        }
      } else {
        setMicrophoneStatus("Texte ajoute a votre reponse.");
      }
    } else {
      setMicrophoneStatus("");
    }
  });

  recognition.addEventListener("error", (event) => {
    clearSilenceTimer();
    const messages = {
      "not-allowed": "Acces au micro refuse par le navigateur.",
      "no-speech": "Aucune parole detectee.",
      "audio-capture": "Aucun micro disponible.",
    };
    setMicrophoneStatus(messages[event.error] || "Erreur de reconnaissance vocale.", true);
    setListening(false);
  });
}

microphoneButton.addEventListener("click", () => {
  if (!recognition) {
    return;
  }

  if (isListening) {
    recognition.stop();
    return;
  }

  try {
    recognition.start();
  } catch {
    setMicrophoneStatus("Le micro est deja en cours d'utilisation.", true);
  }
});

startButton.addEventListener("click", async () => {
  if (!hasSourceContent()) {
    appendMessage("error", "La description ou le PDF de l'evolution/correction est obligatoire.");
    return;
  }

  if (!hasApiToken()) {
    appendMessage("error", "Le token API est obligatoire pour demarrer la discussion.");
    apiTokenInput.focus();
    return;
  }

  if (speechSynthesizer) {
    speechSynthesizer.cancel();
  }
  if (recognition && isListening) {
    recognition.stop();
  }

  history = [];
  hasStarted = false;
  messagesNode.innerHTML = "";
  argumentInput.value = "";
  resetTranscriptState();
  resetSessionUsage();
  setComposerEnabled(false);
  setLoading(true);

  try {
    await ensureDocumentSession();
    const response = await fetch("/api/negotiate", {
      method: "POST",
      body: buildPayload(),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "Erreur inconnue.");
    }

    history.push({ role: "assistant", content: data.reply });
    hasStarted = true;
    appendMessage("assistant", data.reply);
    addSessionUsage(data.usage);
    speakText(data.reply);
    setSetupEnabled(false);
    setComposerEnabled(true);
  } catch (error) {
    appendMessage("error", error.message);
    setComposerEnabled(false);
  } finally {
    setLoading(false);
    if (hasStarted) {
      argumentInput.focus();
    }
  }
});

helpAnswerButton.addEventListener("click", async () => {
  if (!hasStarted) {
    appendMessage("error", "Demarrez la discussion avant de demander de l'aide.");
    return;
  }

  if (!hasApiToken()) {
    appendMessage("error", "Le token API est obligatoire.");
    apiTokenInput.focus();
    return;
  }

  setLoading(true);

  try {
    await ensureDocumentSession();
    const response = await fetch("/api/help-answer", {
      method: "POST",
      body: buildPayload(argumentInput.value.trim()),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "Erreur inconnue.");
    }

    appendMessage("helper", data.reply);
    addSessionUsage(data.usage);
  } catch (error) {
    appendMessage("error", error.message);
  } finally {
    setLoading(false);
    argumentInput.focus();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const argument = argumentInput.value.trim();

  if (!hasStarted) {
    appendMessage("error", "Demarrez la discussion pour laisser le client poser la premiere question.");
    return;
  }

  if (!argument) {
    appendMessage("error", "La reponse du developpeur est obligatoire.");
    return;
  }

  if (!hasApiToken()) {
    appendMessage("error", "Le token API est obligatoire.");
    apiTokenInput.focus();
    return;
  }

  appendMessage("user", argument);
  if (recognition && isListening) {
    clearSilenceTimer();
    resetTranscriptState();
    recognition.stop();
  }
  setLoading(true);

  try {
    await ensureDocumentSession();
    const response = await fetch("/api/negotiate", {
      method: "POST",
      body: buildPayload(argument),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "Erreur inconnue.");
    }

    history.push({ role: "user", content: argument }, { role: "assistant", content: data.reply });
    appendMessage("assistant", data.reply);
    addSessionUsage(data.usage);
    speakText(data.reply);
    argumentInput.value = "";
    resetTranscriptState();
  } catch (error) {
    appendMessage("error", error.message);
  } finally {
    setLoading(false);
    argumentInput.focus();
  }
});

resetButton.addEventListener("click", () => {
  if (speechSynthesizer) {
    speechSynthesizer.cancel();
  }
  if (recognition && isListening) {
    recognition.stop();
  }
  history = [];
  hasStarted = false;
  documentSessionId = "";
  documentSessionSignature = "";
  resetSessionUsage();
  topicInput.value = "";
  argumentInput.value = "";
  agreementInput.value = "";
  projectDocsInput.value = "";
  projectDocDirectoryInput.value = "";
  messagesNode.innerHTML = "";
  appendMessage(
    "assistant",
    "Decrivez l'evolution ou la correction, ajoutez un PDF si utile, puis demarrez la discussion.",
  );
  setSetupEnabled(true);
  setComposerEnabled(false);
  setLoading(false);
  renderProviderHelp();
});

llmProviderInput.addEventListener("change", renderProviderHelp);

stopVoiceButton.addEventListener("click", () => {
  if (speechSynthesizer) {
    speechSynthesizer.cancel();
  }
});

if (speechSynthesizer) {
  populateVoices();
  speechSynthesizer.addEventListener("voiceschanged", populateVoices);
} else {
  populateVoices();
}

setupSpeechRecognition();
renderSessionUsage();
renderProviderHelp();
setComposerEnabled(false);
