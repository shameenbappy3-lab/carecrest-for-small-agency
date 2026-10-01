// api/track.js
//
// Phase 3. Same file for BOTH sites (small agency + large agency).
// The only per-site setting is the SITE_ID env var in each Vercel project.
//
// What changed from phase 2:
//   - Handles inbound visitors (no tracking id) as well as tracked leads.
//   - Writes to ONE table, site_events, tagged with a `site` column.
//     Per-site views in Supabase (see supabase.sql) split the data up.
//   - Looks up the visitor's ASN (IPinfo Lite) so datacenter / cloud
//     traffic (email security scanners, crawlers) can be flagged.
//   - Scores every event for bot-likeness and stores the score + reasons.
//     Nothing is thrown away: bots are labelled, not deleted.
//   - Cheap abuse protection: same-origin check, event allow-list,
//     size limits, field sanitising.
//
// Env vars (Vercel -> Project -> Settings -> Environment Variables):
//   SITE_ID        small_agency   |   large_agency        (required)
//   SUPABASE_URL   https://xxxx.supabase.co               (required)
//   SUPABASE_KEY   the SECRET / service_role key          (required)
//   IPINFO_TOKEN   free IPinfo Lite token                 (optional but needed for ASN)
//   ALLOWED_HOSTS  extra hostnames allowed to post, comma-separated (optional)

const SITE_ID = (process.env.SITE_ID || "").trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_EVENTS = new Set([
  "page_view",
  "interaction",
  "scroll",
  "click",
  "heartbeat",
  "page_leave",
]);

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_BODY_CHARS = 8000;

/* ------------------------------------------------------------------ */
/* Bot knowledge                                                       */
/* ------------------------------------------------------------------ */

// User agents that announce themselves as automation, crawlers, link
// previewers or email security scanners.
const BOT_UA_RE = new RegExp(
  [
    "bot", "crawl", "spider", "slurp", "headless", "phantom", "puppeteer",
    "playwright", "selenium", "webdriver", "curl/", "wget/", "python-requests",
    "python-urllib", "aiohttp", "httpx", "axios", "node-fetch", "undici",
    "go-http-client", "java/", "okhttp", "libwww", "httpclient", "scrapy",
    "facebookexternalhit", "linkpreview", "linkpresentation", "preview",
    "lighthouse", "pingdom", "gtmetrix", "uptime", "monitor", "datadog",
    "mimecast", "proofpoint", "barracuda", "forcepoint", "symantec",
    "trendmicro", "safelinks", "urlscan", "virustotal", "bingpreview",
    "slackbot", "twitterbot", "linkedinbot", "whatsapp", "telegrambot",
    "discordbot", "skypeuripreview", "googleimageproxy", "ggpht",
  ].join("|"),
  "i"
);

// ASNs that are almost never a person at a keyboard: big clouds and
// hosting providers. Email link-scanners and crawlers come from these.
// (Matched by number so it works even if the org name changes.)
const DATACENTER_ASNS = new Set([
  "AS16509", "AS14618",            // Amazon / AWS
  "AS15169", "AS396982", "AS19527", // Google / Google Cloud
  "AS8075",                         // Microsoft (Azure, M365 scanners)
  "AS14061",                        // DigitalOcean
  "AS16276",                        // OVH
  "AS24940", "AS213230",            // Hetzner
  "AS63949",                        // Linode / Akamai Connected Cloud
  "AS20473",                        // Vultr / Choopa
  "AS31898",                        // Oracle Cloud
  "AS45102",                        // Alibaba Cloud
  "AS132203", "AS45090",            // Tencent Cloud
  "AS12876",                        // Scaleway
  "AS51167",                        // Contabo
  "AS60781", "AS28753",             // Leaseweb
  "AS19551",                        // Incapsula / Imperva
  "AS8100",                         // QuadraNet
  "AS36352",                        // ColoCrossing
  "AS46606",                        // Unified Layer / Bluehost
  "AS26496",                        // GoDaddy hosting
]);

// Same idea, but caught by organisation name for providers not listed.
// Deliberately SPECIFIC names. Generic words like "cloud" or "server" are
// left out because they also match harmless networks (e.g. Cloudflare,
// which real people reach through WARP / iCloud Private Relay).
const DATACENTER_NAME_RE =
  /hosting|datacenter|data center|colocation|\bvps\b|digital ?ocean|\bovh|hetzner|linode|vultr|choopa|leaseweb|contabo|scaleway|rackspace|equinix|amazon|microsoft corporation|google llc|oracle|alibaba|tencent|\bm247\b|serverius|psychz|quadranet|colocrossing|cloudsigma|clouvider|ionos|hostinger|hostwinds|kamatera|upcloud|worldstream|sharktech|datacamp|zenlayer|heroku|netlify/i;

// Not bots on their own: real people sit behind these (iCloud Private
// Relay, Cloudflare WARP). Small nudge only; behaviour decides.
const PROXY_ASNS = new Set([
  "AS13335",             // Cloudflare
  "AS54113",             // Fastly
  "AS20940", "AS16625", "AS36183", // Akamai
]);

// Apple's own network: iMessage / Mail link previews fetch from here.
const APPLE_ASNS = new Set(["AS714", "AS6185"]);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function cleanInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function cleanId(value) {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

function cleanTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_e) {
    return null;
  }
}

function cleanObject(obj, maxChars) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  try {
    const s = JSON.stringify(obj);
    return s.length <= maxChars ? obj : null;
  } catch (_e) {
    return null;
  }
}

function getIp(req) {
  // Vercel overwrites x-forwarded-for with the real client IP, and
  // x-vercel-forwarded-for carries the same value even behind a proxy.
  const raw =
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"];
  const first = typeof raw === "string" ? raw.split(",")[0].trim() : "";
  return first || req.socket?.remoteAddress || null;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return (
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80")
  );
}

/* ---- ASN lookup (IPinfo Lite), cached per warm function instance ---- */

const ASN_CACHE = new Map(); // ip -> { at, value }
const ASN_TTL_MS = 6 * 60 * 60 * 1000;
const ASN_CACHE_MAX = 5000;

async function lookupAsn(ip) {
  if (!IPINFO_TOKEN || isPrivateIp(ip)) return null;

  const hit = ASN_CACHE.get(ip);
  if (hit && Date.now() - hit.at < ASN_TTL_MS) return hit.value;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const r = await fetch(
      `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(IPINFO_TOKEN)}`,
      { signal: ctrl.signal }
    );
    if (!r.ok) return null; // not cached: try again next time
    const j = await r.json();
    const value = {
      asn: clip(j.asn, 20),
      as_name: clip(j.as_name, 120),
    };
    if (ASN_CACHE.size >= ASN_CACHE_MAX) {
      ASN_CACHE.delete(ASN_CACHE.keys().next().value);
    }
    ASN_CACHE.set(ip, { at: Date.now(), value });
    return value;
  } catch (_e) {
    return null; // lookup failure must never block tracking
  } finally {
    clearTimeout(timer);
  }
}

/* ---- bot score: 0 (looks human) .. 100 (certainly automated) ---- */

function scoreEvent({ ua, headers, signals, asnInfo, sameOrigin }) {
  let score = 0;
  const reasons = [];
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };

  if (!ua) add(50, "no_user_agent");
  else if (BOT_UA_RE.test(ua)) add(100, "bot_user_agent");

  // Real browsers always send these.
  if (!headers["accept-language"]) add(20, "no_accept_language");
  const fetchSite = headers["sec-fetch-site"];
  if (!fetchSite) add(15, "no_sec_fetch");
  else if (fetchSite !== "same-origin") add(30, "unexpected_sec_fetch:" + fetchSite);

  if (!sameOrigin) add(25, "origin_not_confirmed");

  // Signals the browser script reported about itself.
  const s = signals || {};
  if (s.webdriver === true) add(100, "webdriver");
  if (s.headlessUA === true) add(100, "headless_ua");
  if (Array.isArray(s.languages) && s.languages.length === 0) add(30, "no_languages");
  if (s.screenW === 0 || s.screenH === 0) add(40, "zero_screen");
  if (s.innerW === 0 || s.innerH === 0) add(40, "zero_viewport");

  let isDatacenter = false;
  if (asnInfo && asnInfo.asn) {
    if (DATACENTER_ASNS.has(asnInfo.asn)) {
      isDatacenter = true;
      add(60, "datacenter_asn:" + asnInfo.asn);
    } else if (APPLE_ASNS.has(asnInfo.asn)) {
      add(30, "apple_network");
    } else if (PROXY_ASNS.has(asnInfo.asn)) {
      add(10, "proxy_asn"); // checked BEFORE the name match on purpose
    } else if (asnInfo.as_name && DATACENTER_NAME_RE.test(asnInfo.as_name)) {
      isDatacenter = true;
      add(50, "datacenter_name");
    }
  }

  return { score: Math.min(100, score), reasons, isDatacenter };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // --- same-origin check ------------------------------------------------
  // The tracker script lives on the same domain as this endpoint, so a
  // genuine post always comes from our own host. This stops casual
  // cross-site spam. (A determined attacker can fake headers, so it is a
  // speed bump, not a lock.)
  const host = String(req.headers.host || "").toLowerCase();
  const originHost =
    hostOf(req.headers.origin) || hostOf(req.headers.referer) || null;
  let sameOrigin = false;
  if (originHost) {
    const okHost = originHost === host.split(":")[0] || originHost === host;
    if (!okHost && !ALLOWED_HOSTS.includes(originHost)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    sameOrigin = true;
  }

  // --- body ---------------------------------------------------------------
  let body;
  try {
    if (typeof req.body === "string") {
      if (req.body.length > MAX_BODY_CHARS) {
        res.status(413).json({ error: "Payload too large" });
        return;
      }
      body = JSON.parse(req.body);
    } else {
      body = req.body;
      if (body && JSON.stringify(body).length > MAX_BODY_CHARS) {
        res.status(413).json({ error: "Payload too large" });
        return;
      }
    }
  } catch (_err) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  body = body && typeof body === "object" ? body : {};

  const event = clip(body.event, 30);
  const visitorId = cleanId(body.visitorId);
  if (!event || !ALLOWED_EVENTS.has(event) || !visitorId) {
    res.status(400).json({ error: "Missing or invalid event / visitorId" });
    return;
  }

  // trackingId is OPTIONAL now: no id = inbound visitor.
  const trackingId = cleanId(body.trackingId);

  const site = SITE_ID || clip(body.site, 40) || "unknown";

  // --- request metadata ---------------------------------------------------
  const ip = getIp(req);
  const ua = clip(req.headers["user-agent"], 400);
  const country = clip(req.headers["x-vercel-ip-country"], 8);
  const region = clip(req.headers["x-vercel-ip-country-region"], 40);
  let city = req.headers["x-vercel-ip-city"] || null;
  if (city) {
    try {
      city = decodeURIComponent(city); // Vercel URL-encodes this header
    } catch (_e) {
      /* keep raw */
    }
  }

  const asnInfo = await lookupAsn(ip);

  const signals = cleanObject(body.signals, 1500);
  const { score, reasons, isDatacenter } = scoreEvent({
    ua,
    headers: req.headers,
    signals,
    asnInfo,
    sameOrigin,
  });

  const row = {
    site,
    traffic_source: trackingId ? "lead" : "inbound",
    tracking_id: trackingId,
    visitor_id: visitorId,
    session_id: cleanId(body.sessionId),
    event,
    event_timestamp: cleanTimestamp(body.timestamp),

    page_path: clip(body.path, 300),
    page_title: clip(body.title, 200),
    referrer: clip(body.referrer, 500),
    referrer_host: hostOf(body.referrer),
    utm_source: clip(body.utm && body.utm.source, 100),
    utm_medium: clip(body.utm && body.utm.medium, 100),
    utm_campaign: clip(body.utm && body.utm.campaign, 100),
    via_link: body.viaLink === true,

    link_url: clip(body.link && body.link.url, 500),
    link_text: clip(body.link && body.link.text, 120),
    link_label: clip(body.link && body.link.label, 120),
    link_type: clip(body.link && body.link.type, 20),
    link_host: clip(body.link && body.link.host, 120),

    scroll_depth: cleanInt(body.scrollDepth, 0, 100),
    engaged_ms: cleanInt(body.engagedMs, 0, 24 * 3600 * 1000),
    interaction_count: cleanInt(body.interactionCount, 0, 100000),

    signals,
    data: cleanObject(body.data, 1500),

    ip_address: ip,
    asn: asnInfo ? asnInfo.asn : null,
    as_name: asnInfo ? asnInfo.as_name : null,
    is_datacenter: isDatacenter,
    country,
    region,
    city: clip(city, 80),
    user_agent: ua,
    bot_score: score,
    bot_reasons: reasons,
  };

  // Short live log (Vercel keeps these for a limited time).
  console.log("[track]", site, event, row.traffic_source, trackingId || "-", {
    ip,
    asn: row.asn,
    score,
    reasons,
  });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("[track] SUPABASE_URL or SUPABASE_KEY not set - event not persisted");
    res.status(204).end();
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/site_events`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
      signal: ctrl.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[track] Supabase insert failed:", response.status, errText);
    }
  } catch (err) {
    console.error("[track] Supabase request threw:", err.message);
  } finally {
    clearTimeout(timer);
  }

  // Always 204: our infrastructure problems are not the visitor's.
  res.status(204).end();
};

// Exposed for tests only.
module.exports._internal = { scoreEvent, lookupAsn, getIp, ASN_CACHE };
