const form = document.querySelector("#negotiation-form");
const topicInput = document.querySelector("#topic");
const argumentInput = document.querySelector("#argument");
const agreementInput = document.querySelector("#agreement");
const messagesNode = document.querySelector("#messages");
const sendButton = document.querySelector("#send");
const resetButton = document.querySelector("#reset");
const microphoneButton = document.querySelector("#microphone");
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
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynthesizer = window.speechSynthesis;
const SILENCE_TIMEOUT_MS = 2000;

function appendMessage(role, content) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const author = document.createElement("strong");
  author.textContent = role === "user" ? "Vous" : role === "error" ? "Erreur" : "Direction";

  const body = document.createElement("p");
  body.textContent = content;

  message.append(author, body);
  messagesNode.append(message);
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function setLoading(isLoading) {
  sendButton.disabled = isLoading;
  sendButton.textContent = isLoading ? "Reponse en cours..." : "Envoyer l'argument";
}

function setMicrophoneStatus(message, isError = false) {
  microphoneStatus.textContent = message;
  microphoneStatus.classList.toggle("error-text", isError);
}

function formatInteger(value) {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function renderSessionUsage() {
  costUsdNode.textContent = `$${sessionUsage.costUsd.toFixed(6)}`;
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
    setMicrophoneStatus("Silence detecte, envoi de l'argument...");
    recognition.stop();
  }, SILENCE_TIMEOUT_MS);
}

function setupSpeechRecognition() {
  if (!SpeechRecognition) {
    microphoneButton.disabled = true;
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
        if (topicInput.value.trim() && argumentInput.value.trim()) {
          form.requestSubmit();
        } else {
          setMicrophoneStatus("Texte ajoute. Renseignez le sujet avant l'envoi.", true);
        }
      } else {
        setMicrophoneStatus("Texte ajoute a votre argument.");
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const topic = topicInput.value.trim();
  const argument = argumentInput.value.trim();

  if (!topic || !argument) {
    appendMessage("error", "Le sujet et l'argument sont obligatoires.");
    return;
  }

  appendMessage("user", argument);
  if (recognition && isListening) {
    clearSilenceTimer();
    resetTranscriptState();
    recognition.stop();
  }
  setLoading(true);

  const payload = new FormData();
  payload.append("topic", topic);
  payload.append("argument", argument);
  payload.append("history", JSON.stringify(history));
  if (agreementInput.files[0]) {
    payload.append("agreement", agreementInput.files[0]);
  }

  try {
    const response = await fetch("/api/negotiate", {
      method: "POST",
      body: payload,
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
  resetSessionUsage();
  topicInput.value = "";
  argumentInput.value = "";
  agreementInput.value = "";
  messagesNode.innerHTML = "";
  appendMessage(
    "assistant",
    "Indiquez un sujet, ajoutez un accord si utile, puis avancez votre premier argument.",
  );
});

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
