export const PROVIDERS = {
  groq: {
    label: "Groq (free, fast)",
    base: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
      "qwen/qwen3-32b"
    ],
    keysUrl: "https://console.groq.com/keys"
  },
  nvidia: {
    label: "NVIDIA NIM (free credits)",
    base: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    models: [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1"
    ],
    keysUrl: "https://build.nvidia.com/"
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.5-flash",
    models: [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite-preview",
      "google/gemini-3.1-pro-preview",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-exp:free",
      "deepseek/deepseek-chat:free"
    ],
    keysUrl: "https://openrouter.ai/keys"
  },
  cerebras: {
    label: "Cerebras (free tier)",
    base: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    models: ["llama-3.3-70b", "llama3.1-8b"],
    keysUrl: "https://cloud.cerebras.ai/"
  },
  gemini: {
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    models: [
      "gemini-2.0-flash",
      "gemini-2.0-flash-exp",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b"
    ],
    keysUrl: "https://aistudio.google.com/apikey"
  }
};

// If the key prefix unambiguously belongs to a different provider than the one
// selected, fail fast with a clear redirect rather than letting the upstream
// service return an opaque "API key not valid".
function detectKeyProvider(key) {
  if (!key) return null;
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("sk-or-")) return "openrouter";
  return null;
}

function validateKeyMatchesProvider(provider, apiKey) {
  const detected = detectKeyProvider(apiKey);
  if (detected && detected !== provider) {
    throw new Error(
      `Your API key looks like a ${detected} key (starts "${apiKey.slice(0, 6)}…"), ` +
      `but PROVIDER is set to "${provider}". Fix one or the other: ` +
      `set PROVIDER=${detected} in .env (and use the ${detected.toUpperCase()}_API_KEY slot), ` +
      `or paste a real ${provider} key (gemini→AIza…, groq→gsk_…) into the ${provider.toUpperCase()}_API_KEY slot.`
    );
  }
}

// Auto-correct common cross-provider model name confusion.
// Most useful: a Gemini-direct model name typed in while on OpenRouter.
function normalizeModelForProvider(provider, model) {
  if (!model) return model;
  if (provider === "openrouter") {
    if (/^gemini-/i.test(model) && !model.includes("/")) {
      return `google/${model}`;
    }
  }
  return model;
}

export async function chat({
  provider, apiKey, model, messages, tools, signal,
  temperature = 0.4
}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error("Missing API key. Open Settings.");
  validateKeyMatchesProvider(provider, apiKey);
  model = normalizeModelForProvider(provider, model);

  const body = {
    model: model || cfg.defaultModel,
    messages,
    temperature
  };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let hint = "";
    if (provider === "openrouter" && res.status === 404 && /No endpoints found/i.test(text)) {
      hint = ` — OpenRouter expects "<vendor>/<model>" (e.g. google/gemini-2.5-flash). ` +
             `Update MODEL in .env or Settings, or leave it blank to use the default (${cfg.defaultModel}).`;
    } else if (res.status === 401 || res.status === 403) {
      hint = ` — your ${provider.toUpperCase()}_API_KEY may be invalid, expired, or missing the right scope.`;
    }
    throw new Error(`${provider} ${res.status}: ${text.slice(0, 400)}${hint}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("Empty response from LLM");
  return {
    content: msg.content || "",
    tool_calls: msg.tool_calls || null
  };
}
