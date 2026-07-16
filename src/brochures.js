// Per-client brochure catalog. Primary source is the CRM: the broker uploads
// PDFs in the CRM's Inventory page and the agent pulls the catalog from
//   GET {CRM_URL}/api/integrations/whatsapp/brochures  (bearer CRM_BOT_TOKEN)
// so no redeploy is needed when brochures change. Each entry's `url` is a
// PUBLIC direct-download link the WhatsApp Cloud API fetches itself.
//
// Fallback: if the CRM isn't configured (or hasn't answered yet), a static
// BROCHURES env JSON array is used instead — handy for standalone deploys and
// tests:
//   BROCHURES=[{"project":"Skyline Heights","aliases":["skyline"],
//     "url":"https://.../Skyline-Heights.pdf","filename":"Skyline Heights.pdf"}]

const CATALOG_PATH = "/api/integrations/whatsapp/brochures";
const TTL_MS = 60_000;

function crmConfig() {
  const url = (process.env.CRM_URL || "").replace(/\/+$/, "");
  const token = process.env.CRM_BOT_TOKEN || "";
  return url && token ? { url, token } : null;
}

function normalize(list) {
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && b.project && b.url)
    .map((b) => ({
      project: String(b.project).trim(),
      url: String(b.url).trim(),
      filename: (b.filename || `${b.project}.pdf`).trim(),
      aliases: Array.isArray(b.aliases)
        ? b.aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean)
        : [],
    }));
}

// --- Static env fallback ---
let _envCache = null;
let _envRaw;
function envList() {
  const raw = process.env.BROCHURES || "";
  if (_envCache && raw === _envRaw) return _envCache;
  _envRaw = raw;
  let list = [];
  if (raw.trim()) {
    try {
      list = normalize(JSON.parse(raw));
    } catch {
      list = []; // malformed BROCHURES: treat as empty, never crash
    }
  }
  _envCache = list;
  return _envCache;
}

// --- CRM catalog (fetched, cached) ---
let _crmCatalog = null; // null until a successful fetch
let _fetchedAt = 0;
let _inflight = null;

// Refresh the CRM catalog into cache. Cheap + safe to call every turn: it
// no-ops when the cache is fresh, and swallows all errors (keeps old cache)
// so a CRM hiccup never breaks a reply.
export async function refreshBrochures({ force = false } = {}) {
  const crm = crmConfig();
  if (!crm) return;
  const now = Date.now();
  if (!force && _crmCatalog && now - _fetchedAt < TTL_MS) return;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await fetch(crm.url + CATALOG_PATH, {
        headers: { Authorization: `Bearer ${crm.token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      _crmCatalog = normalize(data?.brochures);
      _fetchedAt = Date.now();
    } catch {
      /* keep the previous cache */
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// Active catalog: CRM once fetched, else the env fallback.
function active() {
  return _crmCatalog ?? envList();
}

export function listBrochures() {
  return active().map((b) => b.project);
}

// Find a brochure by project name. Matches (in order): exact name, alias,
// then substring either way so "skyline" finds "Skyline Heights" and vice
// versa. Returns null when nothing matches — the caller must NOT invent one.
export function findBrochure(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;
  const all = active();

  let hit = all.find((b) => b.project.toLowerCase() === q);
  if (hit) return hit;

  hit = all.find((b) => b.aliases.includes(q));
  if (hit) return hit;

  hit = all.find((b) => {
    const name = b.project.toLowerCase();
    return name.includes(q) || q.includes(name) || b.aliases.some((a) => q.includes(a));
  });
  return hit || null;
}

export default { listBrochures, findBrochure, refreshBrochures };
