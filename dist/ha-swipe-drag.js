/* ha-swipe-drag v6
 * Finger-following swipe between Lovelace views.
 * Active only when hass.user.name is in CONFIG.users (default "tab")
 * and the dashboard config has swipe_drag.enable.
 */
(function () {
  "use strict";

  var LOG = "[ha-swipe-drag]";
  var VERSION = 6;
  // Dashboard key swipe_drag overrides these. The installed file is replaced on update.
  var CONFIG = {
    users: ["tab"],
    layoutPanel: "dacha-heating",
    layoutViews: {
      heating: "heating",
      summary: "summary",
      boiler: "boiler"
    }
  };
  var LOCK_PX = 10;
  var COMMIT_RATIO = 0.3;
  var FLING_V = 0.5;
  var OUT_MS = 180;
  var IN_MS = 220;
  var PEEK_W = 132;

  var attached = false;
  var listenersBound = false;
  var animating = false;
  var tracking = false;
  var locked = null;
  var startX = 0;
  var startY = 0;
  var startT = 0;
  var lastX = 0;
  var lastT = 0;
  var vel = 0;
  var dx = 0;
  var viewEl = null;
  var rafId = 0;
  var pendingX = 0;
  var styleEl = null;
  var dotsEl = null;
  var peekEl = null;
  var hostEl = null;

  function log() {
    try {
      var a = [LOG];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  }

  function warn() {
    try {
      var a = [LOG];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.warn.apply(console, a);
    } catch (e) {}
  }

  function qs(root, sel) {
    try {
      return root && root.querySelector ? root.querySelector(sel) : null;
    } catch (e) {
      return null;
    }
  }

  function deepQuery(root, sel) {
    if (!root) return null;
    var found = qs(root, sel);
    if (found) return found;
    if (root.shadowRoot) {
      found = deepQuery(root.shadowRoot, sel);
      if (found) return found;
    }
    var ch = root.children;
    if (ch) {
      for (var i = 0; i < ch.length; i++) {
        found = deepQuery(ch[i], sel);
        if (found) return found;
      }
    }
    return null;
  }

  function getHa() {
    return document.querySelector("home-assistant");
  }

  function getHass() {
    var ha = getHa();
    return ha && ha.hass ? ha.hass : null;
  }

  function userList(value, fallback) {
    if (typeof value === "string" && value) return [value];
    if (Object.prototype.toString.call(value) !== "[object Array]") return fallback.slice();
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (value[i] != null && String(value[i]) !== "") out.push(String(value[i]));
    }
    return out;
  }

  function layoutViewsFrom(sd) {
    var base = {
      heating: CONFIG.layoutViews.heating,
      summary: CONFIG.layoutViews.summary,
      boiler: CONFIG.layoutViews.boiler
    };
    var ov = sd && sd.layout_views;
    if (!ov || typeof ov !== "object") return base;
    if (typeof ov.heating === "string" && ov.heating) base.heating = ov.heating;
    if (typeof ov.summary === "string" && ov.summary) base.summary = ov.summary;
    if (typeof ov.boiler === "string" && ov.boiler) base.boiler = ov.boiler;
    return base;
  }

  function isTabUser() {
    var hass = getHass();
    var name = hass && hass.user ? hass.user.name : "";
    if (!name) return false;
    var cfg = getSwipeCfg();
    var users = cfg && cfg.users ? cfg.users : CONFIG.users;
    for (var i = 0; i < users.length; i++) {
      if (name === users[i]) return true;
    }
    return false;
  }

  function getPanelEl() {
    return deepQuery(getHa(), "ha-panel-lovelace");
  }

  function getHuiRoot() {
    var panel = getPanelEl();
    if (panel && panel.shadowRoot) {
      var r = qs(panel.shadowRoot, "hui-root");
      if (r) return r;
    }
    return deepQuery(getHa(), "hui-root");
  }

  function getViewEl() {
    var root = getHuiRoot();
    if (!root) return null;
    var sr = root.shadowRoot;
    if (sr) {
      return (
        qs(sr, "hui-view") ||
        qs(sr, "hui-view-container") ||
        qs(sr, "#view") ||
        qs(sr, ".content") ||
        null
      );
    }
    return qs(root, "hui-view");
  }

  function getLovelaceConfig() {
    var panel = getPanelEl();
    if (panel && panel.lovelace && panel.lovelace.config) return panel.lovelace.config;
    var root = getHuiRoot();
    if (root && root.lovelace && root.lovelace.config) return root.lovelace.config;
    return null;
  }

  function getSwipeCfg() {
    var cfg = getLovelaceConfig();
    if (!cfg || !cfg.swipe_drag || cfg.swipe_drag.enable === false || !cfg.swipe_drag.enable) {
      return null;
    }
    var sd = cfg.swipe_drag;
    var panel = CONFIG.layoutPanel;
    if (typeof sd.layout_panel === "string" && sd.layout_panel) panel = sd.layout_panel;
    return {
      enable: true,
      wrap: sd.wrap !== false,
      users: sd.users == null ? CONFIG.users.slice() : userList(sd.users, CONFIG.users),
      layoutPanel: panel,
      layoutViews: layoutViewsFrom(sd)
    };
  }

  function shouldRun() {
    return isTabUser() && !!getSwipeCfg();
  }

  function viewVisible(view, userId) {
    if (!view) return false;
    if (view.visible === false) return false;
    if (view.visible == null || view.visible === true) return true;
    if (Object.prototype.toString.call(view.visible) === "[object Array]") {
      for (var i = 0; i < view.visible.length; i++) {
        var v = view.visible[i];
        if (v === true) return true;
        if (v && v.user && userId && String(v.user) === String(userId)) return true;
      }
      return false;
    }
    return true;
  }

  function getViews() {
    var cfg = getLovelaceConfig();
    var hass = getHass();
    var userId = hass && hass.user ? hass.user.id : null;
    var list = cfg && cfg.views ? cfg.views : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!viewVisible(v, userId)) continue;
      var path = v.path;
      if (path == null || path === "") path = String(i);
      out.push({
        index: i,
        path: String(path),
        title: v.title || String(path),
        icon: v.icon || null
      });
    }
    return out;
  }

  function getPanelName() {
    var parts = (window.location.pathname || "").split("/");
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) clean.push(parts[i]);
    }
    return clean.length ? clean[0] : "lovelace";
  }

  function getCurrentViewPath() {
    var parts = (window.location.pathname || "").split("/");
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) clean.push(parts[i]);
    }
    if (clean.length >= 2) return clean.slice(1).join("/");
    return "";
  }

  function currentIndex(views) {
    var path = getCurrentViewPath();
    var i;
    if (path) {
      for (i = 0; i < views.length; i++) {
        if (views[i].path === path) return i;
      }
    }
    return 0;
  }

  function neighbour(dir, views, wrap) {
    if (!views || !views.length) return null;
    var i = currentIndex(views);
    var n = i + dir;
    if (n < 0) return wrap ? views[views.length - 1] : null;
    if (n >= views.length) return wrap ? views[0] : null;
    return views[n];
  }

  function navigateTo(viewPath) {
    var url = "/" + getPanelName() + "/" + viewPath + (window.location.search || "") + (window.location.hash || "");
    var now = window.location.pathname + window.location.search + window.location.hash;
    if (now === url) return;
    log("navigate", url);
    window.history.pushState(null, "", url);
    window.dispatchEvent(new CustomEvent("location-changed"));
  }



  var layoutApplied = false;
  var VIEW_FOOTER = 24;
  var VIEW_GAP = 8;

  function findAllByTag(root, tag) {
    var out = [];
    var seen = [];
    function walk(n) {
      if (!n) return;
      if (n.tagName === tag && seen.indexOf(n) < 0) {
        seen.push(n);
        out.push(n);
      }
      if (n.shadowRoot) walk(n.shadowRoot);
      var ch = n.children;
      if (ch) {
        for (var i = 0; i < ch.length; i++) walk(ch[i]);
      }
    }
    walk(root);
    return out;
  }

  function injectShadowStyle(root, id, css) {
    if (!root) return;
    var el = null;
    try {
      el = root.querySelector("#" + id);
    } catch (e) {
      el = null;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      root.appendChild(el);
    }
    el.textContent = css;
  }

  function markLayout(el, height, maxHeight, overflow) {
    if (!el) return;
    el.setAttribute("data-hsd-layout", "1");
    if (height != null) el.style.height = height;
    if (maxHeight != null) el.style.maxHeight = maxHeight;
    if (overflow != null) el.style.overflow = overflow;
  }

  function usableHeight() {
    var h = (window.innerHeight || 0) - VIEW_FOOTER;
    return h > 200 ? h : 200;
  }

  function clearViewLayout() {
    function walk(n) {
      if (!n) return;
      if (n.getAttribute && n.getAttribute("data-hsd-layout")) {
        n.style.height = "";
        n.style.maxHeight = "";
        n.style.overflow = "";
        n.style.flex = "";
        n.style.minHeight = "";
        n.style.removeProperty("--chart-max-height");
        n.style.removeProperty("--ha-chart-max-height");
        n.removeAttribute("data-hsd-layout");
      }
      var root = n.shadowRoot;
      if (root) {
        var sts = root.querySelectorAll("style[id^='hsd-heating'], style[id^='hsd-fit']");
        for (var i = 0; i < sts.length; i++) {
          if (sts[i].parentNode) sts[i].parentNode.removeChild(sts[i]);
        }
        walk(root);
      }
      var ch = n.children;
      if (ch) {
        for (var j = 0; j < ch.length; j++) walk(ch[j]);
      }
    }
    walk(getHa());
    layoutApplied = false;
  }

  function constrainShell(ha) {
    var view = findAllByTag(ha, "HUI-VIEW")[0] || getViewEl();
    if (view) markLayout(view, "100vh", "100vh", "hidden");
    var panel = findAllByTag(ha, "HUI-PANEL-VIEW")[0];
    if (panel) markLayout(panel, "100%", "100%", "hidden");
  }

  function styleHStack(hstack, height) {
    if (!hstack) return;
    markLayout(hstack, height, height, "hidden");
    if (hstack.shadowRoot) {
      injectShadowStyle(
        hstack.shadowRoot,
        "hsd-fit-hstack",
        ":host{height:100%!important;display:flex!important;}" +
          ":host > div{height:100%!important;width:100%;box-sizing:border-box;}" +
          ":host > div > *{height:100%!important;min-height:0!important;}"
      );
    }
    var wrap = hstack.parentElement;
    if (wrap && wrap.tagName === "HUI-CARD") {
      markLayout(wrap, "100%", "100%", "hidden");
      wrap.style.flex = "1 1 auto";
      wrap.style.minHeight = "0";
    }
  }

  function resizeChartBase(el, chartH) {
    if (!el) return;
    try {
      el.height = chartH;
    } catch (e) {}
    el.style.height = "100%";
    el.style.maxHeight = "100%";
    el.style.setProperty("--chart-max-height", chartH + "px");
    el.setAttribute("data-hsd-layout", "1");
    if (el.shadowRoot) {
      injectShadowStyle(
        el.shadowRoot,
        "hsd-fit-chart",
        ":host{height:100%!important;max-height:100%!important;display:flex!important;flex-direction:column!important;}" +
          ".container,.container.has-height{height:100%!important;max-height:100%!important;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}" +
          ".chart-container{max-height:none!important;flex:1 1 auto;min-height:0;}"
      );
    }
    try {
      if (el._resizeChartIfNeeded) el._resizeChartIfNeeded();
      if (el.chart && el.chart.resize) el.chart.resize();
    } catch (e2) {}
  }

  function fitHistoryGraphCard(card, cardH) {
    if (!card) return;
    markLayout(card, cardH + "px", cardH + "px", "hidden");
    var sr = card.shadowRoot;
    if (!sr) return;
    injectShadowStyle(
      sr,
      "hsd-fit-graph",
      "ha-card{height:100%!important;max-height:100%!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;box-sizing:border-box!important;}" +
        "h1.card-header{flex:0 0 auto;}" +
        "div.content{flex:1 1 auto!important;min-height:0!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;}" +
        "state-history-charts{flex:1 1 auto!important;min-height:0!important;height:auto!important;max-height:100%!important;width:100%;}"
    );
    var content = qs(sr, "div.content");
    var avail = 0;
    if (content) {
      var cs = getComputedStyle(content);
      avail = content.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    }
    if (!(avail > 0)) {
      var header = qs(sr, "h1.card-header") || qs(sr, ".card-header");
      var headerH = header ? header.getBoundingClientRect().height : 48;
      avail = cardH - headerH - 8;
    }
    var chartH = Math.max(120, Math.round(avail));
    card.style.setProperty("--chart-max-height", chartH + "px");
    var k;
    var charts = findAllByTag(card, "STATE-HISTORY-CHARTS");
    for (k = 0; k < charts.length; k++) {
      try {
        charts[k].height = chartH;
      } catch (e) {}
      charts[k].style.height = "100%";
      charts[k].style.maxHeight = "100%";
      charts[k].style.setProperty("--chart-max-height", chartH + "px");
      charts[k].setAttribute("data-hsd-layout", "1");
    }
    var lines = findAllByTag(card, "STATE-HISTORY-CHART-LINE");
    for (k = 0; k < lines.length; k++) {
      try {
        lines[k].height = chartH;
      } catch (e2) {}
      lines[k].style.height = "100%";
      lines[k].style.display = "block";
      lines[k].style.minHeight = "0";
      lines[k].style.setProperty("--chart-max-height", chartH + "px");
      lines[k].setAttribute("data-hsd-layout", "1");
    }
    var bases = findAllByTag(card, "HA-CHART-BASE");
    for (k = 0; k < bases.length; k++) resizeChartBase(bases[k], chartH);
  }

  function applyHeatingLayout(ha) {
    var usable = usableHeight();
    var heatMax = Math.floor((usable - VIEW_GAP) / 2) + "px";
    var heatView = usable + "px";
    var cards = findAllByTag(ha, "HUI-THERMOSTAT-CARD");
    if (!cards.length) return;
    var i;
    for (i = 0; i < cards.length; i++) {
      var card = cards[i];
      markLayout(card, heatMax, heatMax, "hidden");
      var sr = card.shadowRoot;
      if (!sr) continue;
      injectShadowStyle(
        sr,
        "hsd-heating-thermo",
        "ha-card{height:100%!important;max-height:100%!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;}" +
          "p.title{flex:0 0 auto;padding:4px 30px!important;}" +
          "div.container{flex:1 1 auto!important;min-height:0!important;width:100%!important;height:auto!important;max-height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow:hidden!important;}" +
          "ha-state-control-climate-temperature{max-width:100%!important;max-height:100%!important;height:100%!important;width:auto!important;aspect-ratio:1/1!important;box-sizing:border-box!important;padding:4px!important;}"
      );
      var ctrl = qs(sr, "ha-state-control-climate-temperature");
      if (ctrl) {
        ctrl.style.maxWidth = "100%";
        if (ctrl.shadowRoot) {
          injectShadowStyle(
            ctrl.shadowRoot,
            "hsd-heating-ctrl",
            ":host{display:block;height:100%;max-height:100%;max-width:100%;box-sizing:border-box;}" +
              ".container,.container.lg,.container.md,.container.sm{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;aspect-ratio:1/1!important;}" +
              "ha-control-circular-slider{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;display:block!important;}"
          );
          var slider = qs(ctrl.shadowRoot, "ha-control-circular-slider");
          if (slider && slider.shadowRoot) {
            injectShadowStyle(
              slider.shadowRoot,
              "hsd-heating-slider",
              ":host{display:block;width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;}" +
                "svg{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;display:block!important;}"
            );
          }
        }
      }
    }
    constrainShell(ha);
    var hstack = findAllByTag(ha, "HUI-HORIZONTAL-STACK-CARD")[0];
    if (hstack) markLayout(hstack, "100%", "100%", "hidden");
    var vstack = findAllByTag(ha, "HUI-VERTICAL-STACK-CARD")[0];
    if (vstack) markLayout(vstack, "100%", heatView, "hidden");
    var ent = findAllByTag(ha, "HUI-ENTITIES-CARD")[0];
    if (ent) {
      markLayout(ent, "100%", heatView, "hidden");
      if (ent.shadowRoot) {
        injectShadowStyle(
          ent.shadowRoot,
          "hsd-heating-ent",
          "ha-card{height:100%!important;max-height:100%!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;}" +
            "h1.card-header{flex:0 0 auto;}" +
            ".card-content{flex:1 1 auto!important;overflow:hidden!important;}"
        );
      }
    }
  }

  function applySummaryLayout(ha) {
    var usable = usableHeight();
    constrainShell(ha);
    var vstack = findAllByTag(ha, "HUI-VERTICAL-STACK-CARD")[0];
    if (vstack) {
      markLayout(vstack, usable + "px", usable + "px", "hidden");
      if (vstack.shadowRoot) {
        injectShadowStyle(
          vstack.shadowRoot,
          "hsd-fit-vstack",
          ":host{height:100%!important;display:block!important;}" +
            ":host > div{height:100%!important;box-sizing:border-box!important;}" +
            ":host > div > *:last-child{flex:1 1 auto!important;min-height:0!important;height:auto!important;}"
        );
      }
    }
    var hstack = findAllByTag(ha, "HUI-HORIZONTAL-STACK-CARD")[0];
    styleHStack(hstack, "100%");
    var graphH = hstack ? Math.round(hstack.getBoundingClientRect().height) : 0;
    if (!(graphH > 0)) {
      var glance = findAllByTag(ha, "HUI-GLANCE-CARD")[0];
      var gh = glance ? glance.getBoundingClientRect().height : 188;
      graphH = Math.max(160, Math.round(usable - gh - VIEW_GAP));
    }
    var cards = findAllByTag(ha, "HUI-HISTORY-GRAPH-CARD");
    var i;
    for (i = 0; i < cards.length; i++) fitHistoryGraphCard(cards[i], graphH);
  }

  function applyBoilerLayout(ha) {
    var usable = usableHeight();
    constrainShell(ha);
    var hstack = findAllByTag(ha, "HUI-HORIZONTAL-STACK-CARD")[0];
    styleHStack(hstack, usable + "px");
    var cards = findAllByTag(ha, "HUI-HISTORY-GRAPH-CARD");
    var i;
    for (i = 0; i < cards.length; i++) fitHistoryGraphCard(cards[i], usable);
  }

  function applyViewLayout() {
    var cfg = getSwipeCfg();
    var panel = cfg ? cfg.layoutPanel : CONFIG.layoutPanel;
    var views = cfg ? cfg.layoutViews : CONFIG.layoutViews;
    if (!shouldRun() || getPanelName() !== panel) {
      if (layoutApplied) clearViewLayout();
      return;
    }
    var path = getCurrentViewPath();
    var mode = null;
    if (path === views.heating) mode = "heating";
    else if (path === views.summary) mode = "summary";
    else if (path === views.boiler) mode = "boiler";
    if (!mode) {
      if (layoutApplied) clearViewLayout();
      return;
    }
    var ha = getHa();
    if (!ha) return;
    if (mode === "heating") applyHeatingLayout(ha);
    else if (mode === "summary") applySummaryLayout(ha);
    else applyBoilerLayout(ha);
    layoutApplied = true;
  }

  function scheduleViewLayout() {
    applyViewLayout();
    setTimeout(applyViewLayout, 50);
    setTimeout(applyViewLayout, 200);
    setTimeout(applyViewLayout, 500);
  }

  function onResize() {
    scheduleViewLayout();
  }

  function ensureStyle() {
    if (styleEl && styleEl.parentNode) return;
    styleEl = document.createElement("style");
    styleEl.id = "ha-swipe-drag-style";
    styleEl.textContent =
      "#ha-swipe-drag-dots{position:fixed;left:0;right:0;bottom:10px;display:flex;justify-content:center;align-items:center;gap:7px;z-index:9998;pointer-events:none;}" +
      "#ha-swipe-drag-dots span{width:7px;height:7px;border-radius:50%;background:var(--primary-text-color, #fff);opacity:0.28;}" +
      "#ha-swipe-drag-dots span.cur{opacity:0.9;width:16px;border-radius:4px;background:var(--primary-color, #03a9f4);}" +
      "#ha-swipe-drag-peek{position:fixed;top:0;bottom:0;width:" + PEEK_W + "px;z-index:9997;pointer-events:none;" +
      "display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:16px;" +
      "box-sizing:border-box;color:var(--primary-text-color, #fff);" +
      "background:var(--card-background-color, rgba(20,20,20,0.92));font:500 16px/1.3 var(--paper-font-body1_-_font-family, sans-serif);}" +
      "#ha-swipe-drag-peek .hsd-icon{font-size:28px;margin-bottom:8px;opacity:0.9;}" +
      "#ha-swipe-drag-peek .hsd-title{font-size:18px;font-weight:600;padding:0 8px;}";
    document.documentElement.appendChild(styleEl);
  }

  function removeUi() {
    if (dotsEl && dotsEl.parentNode) dotsEl.parentNode.removeChild(dotsEl);
    if (peekEl && peekEl.parentNode) peekEl.parentNode.removeChild(peekEl);
    dotsEl = null;
    peekEl = null;
  }

  function updateDots() {
    var views = getViews();
    if (!dotsEl) {
      dotsEl = document.createElement("div");
      dotsEl.id = "ha-swipe-drag-dots";
      document.body.appendChild(dotsEl);
    }
    var cur = currentIndex(views);
    var html = "";
    for (var i = 0; i < views.length; i++) {
      html += i === cur ? '<span class="cur"></span>' : "<span></span>";
    }
    dotsEl.innerHTML = html;
  }

  function ensurePeek() {
    if (peekEl && peekEl.parentNode) return peekEl;
    peekEl = document.createElement("div");
    peekEl.id = "ha-swipe-drag-peek";
    peekEl.style.display = "none";
    document.body.appendChild(peekEl);
    return peekEl;
  }

  function updatePeek(dxNow, views, wrap) {
    var dir = dxNow < 0 ? 1 : dxNow > 0 ? -1 : 0;
    var nb = dir ? neighbour(dir, views, wrap) : null;
    var peek = ensurePeek();
    if (!nb || !dxNow) {
      peek.style.display = "none";
      return;
    }
    var w = window.innerWidth || 1;
    var adx = Math.abs(dxNow);
    var shown = Math.min(PEEK_W, adx);
    var fromRight = dir === 1;
    peek.style.display = "flex";
    peek.style.width = PEEK_W + "px";
    if (fromRight) {
      peek.style.left = "auto";
      peek.style.right = "0";
      peek.style.transform = "translateX(" + (PEEK_W - shown) + "px)";
      peek.style.boxShadow = "-12px 0 24px rgba(0,0,0,0.35)";
    } else {
      peek.style.right = "auto";
      peek.style.left = "0";
      peek.style.transform = "translateX(" + (shown - PEEK_W) + "px)";
      peek.style.boxShadow = "12px 0 24px rgba(0,0,0,0.35)";
    }
    var icon = nb.icon ? nb.icon.replace(/^mdi:/, "") : "";
    peek.innerHTML = '<div class="hsd-icon">' + (fromRight ? "›" : "‹") + "</div>" +
      '<div class="hsd-title"></div>';
    peek.querySelector(".hsd-title").textContent = nb.title;
    void icon;
    void w;
  }

  function hidePeek() {
    if (peekEl) peekEl.style.display = "none";
  }

  function setTx(el, x, transition) {
    if (!el) return;
    el.style.willChange = "transform";
    if (transition) {
      el.style.transition = "transform " + transition + "ms ease-out";
    } else {
      el.style.transition = "none";
    }
    el.style.transform = x ? "translateX(" + x + "px)" : "translateX(0)";
  }

  function clearTx(el) {
    if (!el) return;
    el.style.transition = "";
    el.style.transform = "";
    el.style.willChange = "";
  }

  function resisted(x, wrap, views) {
    if (wrap) return x;
    var i = currentIndex(views);
    if ((i === 0 && x > 0) || (i === views.length - 1 && x < 0)) {
      var w = window.innerWidth || 1;
      return x / (1 + Math.abs(x) / w);
    }
    return x;
  }

  function applyFrame() {
    rafId = 0;
    if (!viewEl || locked !== "h") return;
    setTx(viewEl, pendingX, 0);
  }

  function queueTx(x) {
    pendingX = x;
    if (!rafId) rafId = requestAnimationFrame(applyFrame);
  }

  function ignoredTarget(ev) {
    // Charts (history-graph, ha-chart-base, statistics) are allowed:
    // a tap still reaches the chart; we take over only after a horizontal lock.
    var path = ev.composedPath ? ev.composedPath() : ev.path || [];
    if (!path || !path.length) {
      path = ev.target ? [ev.target] : [];
    }
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || !n.tagName) continue;
      var tag = n.tagName.toLowerCase();
      if (
        tag === "ha-more-info-dialog" ||
        tag === "ha-dialog" ||
        tag === "ha-more-info" ||
        tag === "ha-slider" ||
        tag === "ha-control-slider" ||
        tag === "paper-slider" ||
        tag === "mwc-slider" ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select"
      ) {
        return true;
      }
    }
    if (deepQuery(getHa(), "ha-more-info-dialog[open], ha-dialog[open]")) return true;
    return false;
  }

  function point(ev) {
    if (ev.touches && ev.touches.length) {
      return { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: ev.timeStamp || Date.now() };
    }
    if (ev.changedTouches && ev.changedTouches.length) {
      return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY, t: ev.timeStamp || Date.now() };
    }
    return { x: ev.clientX, y: ev.clientY, t: ev.timeStamp || Date.now() };
  }

  function onStart(ev) {
    if (animating || !shouldRun()) return;
    if (ev.touches && ev.touches.length > 1) return;
    if (ignoredTarget(ev)) return;
    var p = point(ev);
    tracking = true;
    locked = null;
    startX = lastX = p.x;
    startY = p.y;
    startT = lastT = p.t;
    vel = 0;
    dx = 0;
    viewEl = getViewEl();
    if (viewEl) {
      viewEl.style.willChange = "transform";
      viewEl.style.transition = "none";
    }
  }

  function onMove(ev) {
    if (!tracking || animating) return;
    var p = point(ev);
    var rawX = p.x - startX;
    var rawY = p.y - startY;
    var dt = p.t - lastT;
    if (dt > 0) vel = (p.x - lastX) / dt;
    lastX = p.x;
    lastT = p.t;

    if (!locked) {
      if (Math.abs(rawX) < LOCK_PX && Math.abs(rawY) < LOCK_PX) return;
      locked = Math.abs(rawX) >= Math.abs(rawY) ? "h" : "v";
      if (locked === "v") return;
    }
    if (locked === "v") return;

    if (ev.cancelable) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    var cfg = getSwipeCfg() || { wrap: true };
    var views = getViews();
    dx = resisted(rawX, cfg.wrap, views);
    queueTx(dx);
    updatePeek(dx, views, cfg.wrap);
  }

  function finishIn(el, fromX, done) {
    if (!el) {
      if (done) done();
      return;
    }
    setTx(el, fromX, 0);
    void el.offsetWidth;
    setTx(el, 0, IN_MS);
    setTimeout(function () {
      clearTx(el);
      if (done) done();
    }, IN_MS + 20);
  }

  function waitView(prev, cb) {
    var n = 0;
    function tick() {
      var el = getViewEl();
      if (el && (el !== prev || n > 2)) {
        cb(el);
        return;
      }
      n += 1;
      if (n > 90) {
        cb(el || prev);
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function onEnd(ev) {
    if (!tracking) return;
    tracking = false;
    if (locked !== "h") {
      locked = null;
      hidePeek();
      return;
    }
    locked = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    var cfg = getSwipeCfg() || { wrap: true };
    var views = getViews();
    var w = window.innerWidth || 1;
    var p = ev ? point(ev) : null;
    if (p && ev && ev.changedTouches) {
      var dt = p.t - lastT;
      if (dt > 0) vel = (p.x - lastX) / dt;
    }
    var dir = 0;
    if (dx < 0) dir = 1;
    else if (dx > 0) dir = -1;
    var commit = dir && (Math.abs(dx) > w * COMMIT_RATIO || Math.abs(vel) > FLING_V);
    if (commit) {
      var nb = neighbour(dir, views, cfg.wrap);
      if (!nb) commit = false;
    }
    var el = viewEl || getViewEl();
    hidePeek();
    if (!commit) {
      animating = true;
      setTx(el, dx, 0);
      void (el && el.offsetWidth);
      setTx(el, 0, OUT_MS);
      setTimeout(function () {
        clearTx(el);
        animating = false;
        updateDots();
        scheduleViewLayout();
      }, OUT_MS + 20);
      return;
    }
    var nb2 = neighbour(dir, views, cfg.wrap);
    animating = true;
    var outX = dir === 1 ? -w : w;
    setTx(el, dx, 0);
    void (el && el.offsetWidth);
    setTx(el, outX, OUT_MS);
    setTimeout(function () {
      navigateTo(nb2.path);
      waitView(el, function (neu) {
        var from = dir === 1 ? w : -w;
        finishIn(neu, from, function () {
          animating = false;
          updateDots();
          scheduleViewLayout();
        });
      });
    }, OUT_MS);
  }

  function onCancel() {
    if (!tracking) return;
    tracking = false;
    locked = null;
    hidePeek();
    var el = viewEl || getViewEl();
    clearTx(el);
  }

  function onPointerDown(ev) {
    if (ev.isPrimary === false) return;
    onStart(ev);
  }
  function onPointerMove(ev) {
    if (ev.isPrimary === false) return;
    onMove(ev);
  }
  function onPointerUp(ev) {
    if (ev.isPrimary === false) return;
    onEnd(ev);
  }

  function bind() {
    if (listenersBound) return;
    listenersBound = true;
    var optsCap = { capture: true, passive: true };
    var optsMove = { capture: true, passive: false };
    document.addEventListener("touchstart", onStart, optsCap);
    document.addEventListener("touchmove", onMove, optsMove);
    document.addEventListener("touchend", onEnd, optsCap);
    document.addEventListener("touchcancel", onCancel, optsCap);
    window.addEventListener("location-changed", onLoc);
    window.addEventListener("popstate", onLoc);
    window.addEventListener("resize", onResize);
    log("listeners bound v" + VERSION);
  }

  function unbind() {
    if (!listenersBound) return;
    listenersBound = false;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onCancel, true);
    document.removeEventListener("touchstart", onStart, true);
    document.removeEventListener("touchmove", onMove, true);
    document.removeEventListener("touchend", onEnd, true);
    document.removeEventListener("touchcancel", onCancel, true);
    window.removeEventListener("location-changed", onLoc);
    window.removeEventListener("popstate", onLoc);
    window.removeEventListener("resize", onResize);
  }

  function onLoc() {
    setTimeout(function () {
      if (shouldRun()) {
        ensureStyle();
        updateDots();
        scheduleViewLayout();
      } else {
        teardown();
      }
    }, 50);
  }

  function setup() {
    if (attached) {
      updateDots();
      return;
    }
    if (!shouldRun()) return;
    ensureStyle();
    bind();
    updateDots();
    attached = true;
    scheduleViewLayout();
    hostEl = getHuiRoot();
    var who = getHass();
    who = who && who.user ? who.user.name : "";
    log("active user=" + who + " panel=" + getPanelName() + " views=" + getViews().length);
  }

  function teardown() {
    if (!attached && !listenersBound) return;
    unbind();
    removeUi();
    clearViewLayout();
    clearTx(getViewEl());
    attached = false;
    tracking = false;
    animating = false;
    locked = null;
  }

  function tick() {
    try {
      if (shouldRun()) {
        setup();
        applyViewLayout();
      } else if (attached) teardown();
    } catch (e) {
      warn("tick error", e && e.message ? e.message : e);
    }
  }

  window.__haSwipeDragVersion = VERSION;
  log("module loaded v" + VERSION);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick);
  } else {
    tick();
  }
  setInterval(tick, 1000);
})();

export {};
