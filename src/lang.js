// Lightweight language/script detection for v1.
// Returns one of: "gu" (Gujarati script/Roman), "hi" (Devanagari), "hinglish"
// (Roman Hindi/Hinglish), "en" (English), or "und" (undetermined — no language
// signal at all, e.g. a bare "ok" or "60 lakh"). The caller treats "und" as
// "keep the language already in use" so short/neutral replies don't reset a
// Gujarati/Hinglish conversation back to English mid-flow.

const GUJARATI_RANGE = /[\u0A80-\u0AFF]/;
const DEVANAGARI_RANGE = /[\u0900-\u097F]/;

// Common Hinglish/Hindi tokens written in Roman script.
// NOTE: keep only tokens that are distinctly Hindi/Hinglish. Generic English
// real-estate words ("flat", "budget", "area") are intentionally absent — they
// made pure English leads (e.g. "I want a 3BHK flat") misclassify as Hinglish.
const HINGLISH_HINTS = [
  "hai", "haan", "nahi", "nahin", "kya", "kaise", "kaisa", "kitna",
  "kitne", "chahiye", "chaiye", "milega", "batao", "bata", "karo", "kar",
  "karwa", "acha", "accha", "theek", "thik", "ghar", "lena", "lege", "lunga",
  "dekhna", "dikhao", "dikha", "paisa", "rupaye", "hajar", "hazar", "tak",
  "subah", "shaam", "sham", "wala", "wali", "bhai", "ji",
  "aap", "tum", "mujhe", "mereko", "apna", "kal", "aaj", "abhi", "kab",
];

// Common Roman-Gujarati tokens (helps bias toward Gujarati register).
const GUJARATI_ROMAN_HINTS = [
  "chhe", "che", "shu", "kem", "tame", "tamne", "hu", "mane", "amne", "joiye",
  "ketlo", "ketli", "ketla", "ketlu", "ghar", "aapo", "batavo", "kaho", "kyare",
  "rakho", "rakhyu", "saru", "saras", "sudhi", "levu", "leva", "bhade", "bhav",
  "gothvi", "barabar", "shanivar", "ravivar", "maate", "mate", "aavso", "karva",
  "thai", "gayu", "vagya", "vagye", "saro", "lage", "kayo", "kayu", "kai",
  "divas", "rubaru", "parmadivse", "kale", "aaje", "vandho",
];

// Distinctly English function/words — used to tell "clearly English" apart from
// "no signal". Real-estate nouns that also appear in Hinglish are excluded.
// Loanwords used across all three languages ("visit", "book", "do") are
// deliberately excluded — they aren't English discriminators.
const ENGLISH_HINTS = [
  "the", "is", "are", "what", "want", "you", "your", "can", "does",
  "i", "we", "for", "with", "have", "will", "would",
  "please", "yes", "looking", "buy", "rent", "price", "this", "that", "how",
  "when", "where", "which", "and", "of", "my", "need", "show",
  "available", "interested", "morning", "evening", "works", "fine",
];

function countHits(text, words) {
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const set = new Set(tokens);
  let hits = 0;
  for (const w of words) if (set.has(w)) hits++;
  return hits;
}

export function detectLanguage(text = "") {
  const t = String(text).trim();
  if (!t) return "und";

  if (GUJARATI_RANGE.test(t)) return "gu";
  if (DEVANAGARI_RANGE.test(t)) return "hi";

  const guHits = countHits(t, GUJARATI_ROMAN_HINTS);
  const hiHits = countHits(t, HINGLISH_HINTS);
  const enHits = countHits(t, ENGLISH_HINTS);

  // No evidence in any language — let the caller keep the current language.
  if (guHits === 0 && hiHits === 0 && enHits === 0) return "und";

  // Pick the strongest signal. Roman Gujarati and Hinglish share many tokens,
  // so ties between them lean Gujarati (this is an Ahmedabad business).
  if (guHits >= hiHits && guHits >= enHits && guHits > 0) return "gu";
  if (hiHits >= enHits && hiHits > 0) return "hinglish";
  return "en";
}

// Human-readable label for the system prompt.
export function languageLabel(code) {
  switch (code) {
    case "gu":
      return "Gujarati (reply in Roman Gujarati unless the lead used Gujarati script)";
    case "hi":
      return "Hindi (Devanagari script)";
    case "hinglish":
      return "Hinglish (Roman script Hindi)";
    default:
      return "English";
  }
}
