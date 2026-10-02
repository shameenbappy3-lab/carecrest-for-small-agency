/* tracker.js
 *
 * One file, used by BOTH sites. Add it to every page, last thing before </body>:
 *
 *   <script src="/tracker.js" defer></script>
 *
 * What it does:
 *   - Works for tracked leads (?c=<tracking_id> in the URL) AND for inbound
 *     visitors who found the site themselves (no tracking id).
 *   - Gives every browser a persistent visitor id, and every visit a session id.
 *   - Sends: page_view, interaction (first REAL human input), scroll
 *     milestones, link/button clicks, heartbeat (time on page), page_leave.
 *   - Reports a few facts about the browser so the server can spot automation.
 *
 * Label any link or button you care about with data-track="some-name":
 *   <a href="https://app.carecrest.ai/demo" data-track="hero-demo-cta">Book a demo</a>
 * Unlabelled links are still tracked, using their text/URL.
 *
 * No cookies are used. IDs live in localStorage / sessionStorage.
 */
(function () {
  "use strict";

  if (window.__siteTrackerLoaded) return;
  window.__siteTrackerLoaded = true;

  var ENDPOINT = "/api/track";
  var HEARTBEAT_MS = 15000;
  var MAX_HEARTBEATS = 60; // 15 minutes of foreground time, then stop sending beats
  var MAX_EVENTS = 80; // hard cap per page load
  var ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

  /* ---------- safe storage (private mode / blocked storage) ---------- */

  var memory = {};
  function store(kind) {
    return {
      get: function (k) {
        try {
          return window[kind].getItem(k);
        } catch (e) {
          return memory[kind + k] || null;
        }
      },
      set: function (k, v) {
        try {
          window[kind].setItem(k, v);
        } catch (e) {
          memory[kind + k] = v;
        }
      },
    };
  }
  var local = store("localStorage");
  var session = store("sessionStorage");

  function randomId() {
    try {
      if (window.crypto && crypto.randomUUID) {
        return crypto.randomUUID().replace(/-/g, "");
      }
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.prototype.map
        .call(a, function (b) {
          return ("0" + b.toString(16)).slice(-2);
        })
        .join("");
    } catch (e) {
      return (
        Date.now().toString(36) +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2)
      );
    }
  }

  /* ---------- identity ---------- */

  var params = new URLSearchParams(window.location.search);

  // Visitor id: same browser = same id, forever. Works for inbound visitors.
  var visitorId = local.get("st_vid");
  if (!visitorId || !ID_RE.test(visitorId)) {
    visitorId = randomId();
    local.set("st_vid", visitorId);
  }

  // Session id: one per browser tab visit.
  var sessionId = session.get("st_sid");
  if (!sessionId || !ID_RE.test(sessionId)) {
    sessionId = randomId();
    session.set("st_sid", sessionId);
  }

  // Tracking id: from the email link (?c=), remembered so later page
  // views in the same browser (without ?c=) still belong to that lead.
  var urlTid = params.get("c");
  var viaLink = !!(urlTid && ID_RE.test(urlTid));
  if (viaLink) local.set("st_tid", urlTid);
  var storedTid = local.get("st_tid");
  var trackingId = viaLink
    ? urlTid
    : storedTid && ID_RE.test(storedTid)
    ? storedTid
    : null;

  /* ---------- state ---------- */

  var startedAt = Date.now();
  var sentCount = 0;
  var heartbeats = 0;

  var engagedMs = 0;
  var visibleSince = document.visibilityState === "visible" ? Date.now() : null;

  var interactionCount = 0;
  var firstInteractionSent = false;
  var maxScroll = 0;
  var scrollMarks = {};

  function currentEngaged() {
    return engagedMs + (visibleSince ? Date.now() - visibleSince : 0);
  }

  /* ---------- browser facts for bot detection ---------- */

  function collectSignals() {
    var ua = navigator.userAgent || "";
    return {
      webdriver: navigator.webdriver === true,
      headlessUA: /HeadlessChrome|PhantomJS|Electron/i.test(ua),
      languages: navigator.languages ? Array.prototype.slice.call(navigator.languages, 0, 5) : [],
      screenW: window.screen ? screen.width : null,
      screenH: window.screen ? screen.height : null,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      touch: navigator.maxTouchPoints || 0,
      cores: navigator.hardwareConcurrency || null,
      tz: (function () {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        } catch (e) {
          return null;
        }
      })(),
    };
  }

  /* ---------- sending ---------- */

  function utm() {
    return {
      source: params.get("utm_source"),
      medium: params.get("utm_medium"),
      campaign: params.get("utm_campaign"),
    };
  }

  function send(event, extra) {
    if (sentCount >= MAX_EVENTS) return;
    sentCount++;

    var payload = {
      event: event,
      visitorId: visitorId,
      sessionId: sessionId,
      trackingId: trackingId,
      viaLink: viaLink,
      timestamp: new Date().toISOString(),
      path: location.pathname,
      title: document.title,
      referrer: document.referrer || null,
      utm: utm(),
      engagedMs: currentEngaged(),
      scrollDepth: maxScroll,
      interactionCount: interactionCount,
    };
    if (event === "page_view") payload.signals = collectSignals();
    if (extra) for (var k in extra) payload[k] = extra[k];

    var json = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(ENDPOINT, new Blob([json], { type: "application/json" }));
        if (ok) return;
      }
    } catch (e) {
      /* fall through to fetch */
    }
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* tracking must never break the page */
    }
  }

  /* ---------- page view ---------- */

  send("page_view");

  /* ---------- real human interaction ----------
   * event.isTrusted is true only for input the browser itself generated
   * (a real mouse, finger or keyboard). Scripts that fake events produce
   * isTrusted = false, so those are ignored.
   */

  function onInteraction(type) {
    return function (e) {
      if (e && e.isTrusted === false) return;
      interactionCount++;
      if (!firstInteractionSent) {
        firstInteractionSent = true;
        send("interaction", {
          data: { type: type, msToFirst: Date.now() - startedAt },
        });
      }
    };
  }

  var opts = { passive: true, capture: true };
  document.addEventListener("mousemove", onInteraction("mouse"), opts);
  document.addEventListener("pointerdown", onInteraction("pointer"), opts);
  document.addEventListener("touchstart", onInteraction("touch"), opts);
  document.addEventListener("keydown", onInteraction("key"), opts);
  window.addEventListener("wheel", onInteraction("wheel"), opts);

  /* ---------- scroll depth ---------- */

  var scrollTimer = null;
  function checkScroll() {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    var pct = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 100;
    if (pct > maxScroll) maxScroll = Math.min(100, pct);
    [25, 50, 75, 100].forEach(function (mark) {
      if (maxScroll >= mark && !scrollMarks[mark]) {
        scrollMarks[mark] = true;
        send("scroll", { scrollDepth: mark });
      }
    });
  }
  window.addEventListener(
    "scroll",
    function (e) {
      if (e && e.isTrusted === false) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(checkScroll, 150);
    },
    { passive: true }
  );

  /* ---------- link + button clicks ---------- */

  function classifyLink(a) {
    var href = a.getAttribute("href") || "";
    if (/^mailto:/i.test(href)) return { type: "mailto", url: href, host: null };
    if (/^tel:/i.test(href)) return { type: "tel", url: href, host: null };
    if (href.charAt(0) === "#") return { type: "anchor", url: href, host: location.hostname };
    var u;
    try {
      u = new URL(a.href, location.href);
    } catch (e) {
      return { type: "other", url: href, host: null };
    }
    var type = u.hostname === location.hostname ? "internal" : "outbound";
    if (type === "internal" && /\.(pdf|docx?|xlsx?|pptx?|zip|csv)$/i.test(u.pathname)) {
      type = "file";
    }
    return { type: type, url: u.href, host: u.hostname };
  }

  function cleanText(s) {
    return (s || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e && e.isTrusted === false) return;
      var el = e.target && e.target.closest ? e.target.closest("a[href], button, [role='button'], [role='tab'], [data-track]") : null;
      if (!el) return;

      var labelAttr = el.getAttribute("data-track");
      var text = cleanText(el.innerText || el.textContent || el.getAttribute("aria-label"));
      var link;

      if (el.tagName === "A" && el.hasAttribute("href")) {
        link = classifyLink(el);
      } else {
        link = { type: "button", url: null, host: null };
      }

      send("click", {
        link: {
          type: link.type,
          url: link.url,
          host: link.host,
          text: text,
          label: labelAttr || text || el.id || link.url,
        },
      });
    },
    true
  );

  /* ---------- time on page ---------- */

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (visibleSince) {
        engagedMs += Date.now() - visibleSince;
        visibleSince = null;
      }
      send("page_leave");
    } else {
      visibleSince = Date.now();
    }
  });

  // pagehide covers browsers that skip visibilitychange when a tab closes.
  window.addEventListener("pagehide", function () {
    if (visibleSince) {
      engagedMs += Date.now() - visibleSince;
      visibleSince = null;
      send("page_leave");
    }
  });

  setInterval(function () {
    if (heartbeats >= MAX_HEARTBEATS) return;
    // Tab in the foreground = the page is being read. Someone reading for
    // 3-4 minutes without touching the mouse still counts.
    if (document.visibilityState !== "visible") return;
    heartbeats++;
    send("heartbeat");
  }, HEARTBEAT_MS);
})();
