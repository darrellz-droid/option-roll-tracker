(() => {
  "use strict";

  const STORAGE_KEY = "optionRollTracker.positions.v1";
  const PRICE_CACHE_KEY = "optionRollTracker.priceCache.v1";
  const STALE_MS = 15 * 60 * 1000; // 15 minutes

  /** @type {Array<Position>} */
  let positions = loadPositions();
  /** @type {Record<string,{price:number, time:number, source:string}>} */
  let priceCache = loadPriceCache();
  let sortKey = "itm";
  let sortDir = "desc";

  // ---------- Persistence ----------
  function loadPositions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function savePositions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  }
  function loadPriceCache() {
    try {
      const raw = localStorage.getItem(PRICE_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function savePriceCache() {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(priceCache));
  }

  // ---------- ITM / tier logic ----------
  // For a short PUT: ITM when price < strike -> itmPct = (strike - price) / strike * 100
  // For a short CALL: ITM when price > strike -> itmPct = (price - strike) / strike * 100
  function computeItmPct(type, strike, price) {
    if (!strike || price == null || isNaN(price)) return null;
    if (type === "put") return ((strike - price) / strike) * 100;
    return ((price - strike) / strike) * 100;
  }

  // Returns tier descriptor based on itmPct
  function getTier(itmPct) {
    if (itmPct == null) {
      return { key: "unknown", label: "No Price", weeks: 0, badgeClass: "badge-otm", rowClass: "tier-otm" };
    }
    if (itmPct <= 0) {
      return { key: "otm", label: "OTM — Safe", weeks: 0, badgeClass: "badge-otm", rowClass: "tier-otm" };
    }
    if (itmPct <= 5) {
      return { key: "green", label: "No Action", weeks: 0, badgeClass: "badge-green", rowClass: "tier-green" };
    }
    if (itmPct <= 10) {
      return { key: "amber1", label: "Roll 1 Week", weeks: 1, badgeClass: "badge-amber1", rowClass: "tier-amber1" };
    }
    if (itmPct <= 15) {
      return { key: "amber2", label: "Roll 2 Weeks", weeks: 2, badgeClass: "badge-amber2", rowClass: "tier-amber2" };
    }
    if (itmPct <= 20) {
      return { key: "red1", label: "Roll 3 Weeks", weeks: 3, badgeClass: "badge-red1", rowClass: "tier-red1" };
    }
    return { key: "red2", label: "Roll 4 Weeks", weeks: 4, badgeClass: "badge-red2", rowClass: "tier-red2" };
  }

  function addWeeks(dateStr, weeks) {
    if (!weeks) return null;
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + weeks * 7);
    return d.toISOString().slice(0, 10);
  }

  function daysToExpiration(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(dateStr + "T00:00:00");
    return Math.round((exp - today) / 86400000);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return "—";
    return "$" + Number(n).toFixed(2);
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    return h + "h ago";
  }

  // ---------- Yahoo Finance fetch (client-side, with proxy fallbacks) ----------
  async function fetchYahooQuote(symbol) {
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const attempts = [
      target,
      `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    ];

    let lastErr = null;
    for (const url of attempts) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) throw new Error(json?.chart?.error?.description || "No data returned");
        const price = result.meta?.regularMarketPrice;
        if (price == null) throw new Error("No price in response");
        return { price, time: Date.now() };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Unknown fetch error");
  }

  async function refreshPrices() {
    const tickers = [...new Set(positions.map((p) => p.ticker))];
    if (tickers.length === 0) {
      render();
      return;
    }
    const refreshBtn = document.getElementById("refreshBtn");
    refreshBtn.classList.add("spinning");
    refreshBtn.disabled = true;

    const errors = [];
    await Promise.all(
      tickers.map(async (t) => {
        try {
          const { price, time } = await fetchYahooQuote(t);
          priceCache[t] = { price, time, source: "live" };
        } catch (err) {
          errors.push(t);
        }
      })
    );
    savePriceCache();

    refreshBtn.classList.remove("spinning");
    refreshBtn.disabled = false;

    const banner = document.getElementById("errorBanner");
    if (errors.length) {
      banner.textContent =
        `Could not fetch live price for: ${errors.join(", ")}. ` +
        `Enter a manual price for these tickers in the table (network/CORS may be blocking the request).`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }

    document.getElementById("lastRefreshLabel").textContent =
      "Last refreshed " + new Date().toLocaleTimeString();

    render();
  }

  // ---------- Rendering ----------
  function getEffectivePrice(pos) {
    if (pos.manualPrice != null && pos.manualPrice !== "") {
      return { price: Number(pos.manualPrice), source: "manual", time: null };
    }
    const cached = priceCache[pos.ticker];
    if (cached) return { price: cached.price, source: "live", time: cached.time };
    return { price: null, source: "none", time: null };
  }

  function renderSummary(rows) {
    const counts = { otm: 0, green: 0, amber1: 0, amber2: 0, red1: 0, red2: 0 };
    rows.forEach((r) => {
      if (counts[r.tier.key] != null) counts[r.tier.key]++;
    });
    const tiles = [
      { key: "otm", label: "OTM / Safe", cls: "tile-otm" },
      { key: "green", label: "0–5% — No Action", cls: "tile-green" },
      { key: "amber1", label: "Roll 1 Week", cls: "tile-amber1" },
      { key: "amber2", label: "Roll 2 Weeks", cls: "tile-amber2" },
      { key: "red1", label: "Roll 3 Weeks", cls: "tile-red1" },
      { key: "red2", label: "Roll 4 Weeks", cls: "tile-red2" },
    ];
    const bar = document.getElementById("summaryBar");
    bar.innerHTML = tiles
      .map(
        (t) => `
      <div class="summary-tile ${t.cls}">
        <div class="tile-count">${counts[t.key]}</div>
        <div class="tile-label">${t.label}</div>
      </div>`
      )
      .join("");
  }

  function buildRows() {
    return positions.map((pos) => {
      const eff = getEffectivePrice(pos);
      const itmPct = computeItmPct(pos.type, Number(pos.strike), eff.price);
      const tier = getTier(itmPct);
      const rollTo = tier.weeks > 0 ? addWeeks(pos.expiration, tier.weeks) : null;
      const dte = daysToExpiration(pos.expiration);
      return { pos, eff, itmPct, tier, rollTo, dte };
    });
  }

  function sortRows(rows) {
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFns = {
      ticker: (r) => r.pos.ticker,
      type: (r) => r.pos.type,
      strike: (r) => Number(r.pos.strike),
      price: (r) => (r.eff.price == null ? -Infinity : r.eff.price),
      itm: (r) => (r.itmPct == null ? -Infinity : r.itmPct),
      expiration: (r) => r.pos.expiration,
      dte: (r) => r.dte,
    };
    const fn = keyFns[sortKey] || keyFns.itm;
    return [...rows].sort((a, b) => {
      const av = fn(a), bv = fn(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function render() {
    const rows = buildRows();
    renderSummary(rows);
    const sorted = sortRows(rows);

    const tbody = document.getElementById("positionsBody");
    const emptyState = document.getElementById("emptyState");
    const table = document.getElementById("positionsTable");

    if (sorted.length === 0) {
      table.classList.add("hidden");
      emptyState.classList.remove("hidden");
      tbody.innerHTML = "";
      return;
    }
    table.classList.remove("hidden");
    emptyState.classList.add("hidden");

    tbody.innerHTML = sorted
      .map((r) => {
        const { pos, eff, itmPct, tier, rollTo, dte } = r;
        const priceTag =
          eff.source === "live"
            ? `<span class="price-live-tag">LIVE ${timeAgo(eff.time)}</span>`
            : eff.source === "manual"
            ? `<span class="price-manual-tag">MANUAL</span>`
            : `<span class="price-stale-tag">NO DATA</span>`;

        const itmDisplay = itmPct == null ? "—" : (itmPct > 0 ? "+" : "") + itmPct.toFixed(2) + "%";

        const convertBtn =
          pos.type === "put"
            ? `<button class="btn btn-sm convert-btn" data-action="convert" data-id="${pos.id}" title="Convert to a covered call after assignment">Assigned → Call</button>`
            : "";

        return `
        <tr class="${tier.rowClass}">
          <td class="ticker-cell">${pos.ticker}</td>
          <td><span class="type-pill ${pos.type}">${pos.type}</span></td>
          <td>${fmtMoney(pos.strike)}</td>
          <td class="price-cell">
            <input type="number" step="0.01" class="price-input" data-action="manual-price" data-id="${pos.id}"
              value="${pos.manualPrice != null ? pos.manualPrice : (priceCache[pos.ticker]?.price ?? "")}"
              placeholder="price">
            ${priceTag}
          </td>
          <td class="itm-cell" style="color:var(--${tier.key === "otm" ? "text-dim" : tier.key})">
            ${itmDisplay}
          </td>
          <td>${fmtDate(pos.expiration)}</td>
          <td class="dte-cell ${dte <= 7 ? "dte-soon" : ""}">${dte}d</td>
          <td><span class="status-badge ${tier.badgeClass}"><span class="dot"></span>${tier.label}</span></td>
          <td class="roll-to-cell ${rollTo ? "has-roll" : ""}">${rollTo ? fmtDate(rollTo) : "—"}</td>
          <td>${pos.contracts}</td>
          <td>
            <div class="row-actions">
              ${convertBtn}
              <button class="btn btn-sm" data-action="edit" data-id="${pos.id}">Edit</button>
              <button class="btn btn-sm btn-danger-ghost" data-action="delete" data-id="${pos.id}">Delete</button>
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  // ---------- Modal / form ----------
  const modalOverlay = document.getElementById("modalOverlay");
  const positionForm = document.getElementById("positionForm");
  const typeSegmented = document.getElementById("typeSegmented");
  const fType = document.getElementById("fType");

  function openModal(existing) {
    document.getElementById("modalTitle").textContent = existing ? "Edit Position" : "Add Position";
    document.getElementById("positionId").value = existing ? existing.id : "";
    document.getElementById("fTicker").value = existing ? existing.ticker : "";
    document.getElementById("fStrike").value = existing ? existing.strike : "";
    document.getElementById("fContracts").value = existing ? existing.contracts : 1;
    document.getElementById("fExpiration").value = existing ? existing.expiration : "";
    document.getElementById("fPremium").value = existing && existing.premium != null ? existing.premium : "";
    document.getElementById("fManualPrice").value = existing && existing.manualPrice != null ? existing.manualPrice : "";
    document.getElementById("fNotes").value = existing && existing.notes ? existing.notes : "";
    setTypeSegmented(existing ? existing.type : "put");
    modalOverlay.classList.remove("hidden");
    document.getElementById("fTicker").focus();
  }

  function closeModal() {
    modalOverlay.classList.add("hidden");
    positionForm.reset();
  }

  function setTypeSegmented(value) {
    fType.value = value;
    [...typeSegmented.querySelectorAll(".seg-btn")].forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === value);
    });
  }

  typeSegmented.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setTypeSegmented(btn.dataset.value);
  });

  document.getElementById("addBtn").addEventListener("click", () => openModal(null));
  document.getElementById("emptyAddBtn").addEventListener("click", () => openModal(null));
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  positionForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("positionId").value || String(Date.now()) + Math.random().toString(36).slice(2, 7);
    const ticker = document.getElementById("fTicker").value.trim().toUpperCase();
    const strike = Number(document.getElementById("fStrike").value);
    const contracts = Number(document.getElementById("fContracts").value);
    const expiration = document.getElementById("fExpiration").value;
    const premiumRaw = document.getElementById("fPremium").value;
    const manualRaw = document.getElementById("fManualPrice").value;
    const notes = document.getElementById("fNotes").value.trim();

    if (!ticker || !strike || !expiration || !contracts) return;

    const existingIdx = positions.findIndex((p) => p.id === id);
    const posObj = {
      id,
      ticker,
      type: fType.value,
      strike,
      contracts,
      expiration,
      premium: premiumRaw !== "" ? Number(premiumRaw) : null,
      manualPrice: manualRaw !== "" ? Number(manualRaw) : null,
      notes,
    };

    if (existingIdx >= 0) positions[existingIdx] = posObj;
    else positions.push(posObj);

    savePositions();
    closeModal();
    render();

    if (!priceCache[ticker]) refreshPrices();
  });

  // ---------- Table interactions ----------
  document.getElementById("positionsBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;

    if (btn.dataset.action === "edit") {
      openModal(pos);
    } else if (btn.dataset.action === "delete") {
      if (confirm(`Delete ${pos.ticker} ${pos.type} $${pos.strike} exp ${pos.expiration}?`)) {
        positions = positions.filter((p) => p.id !== id);
        savePositions();
        render();
      }
    } else if (btn.dataset.action === "convert") {
      pos.type = "call";
      pos.notes = (pos.notes ? pos.notes + " | " : "") + `Assigned on put, converted to covered call ${new Date().toLocaleDateString()}`;
      savePositions();
      openModal(pos);
    }
  });

  document.getElementById("positionsBody").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-action='manual-price']");
    if (!input) return;
    const id = input.dataset.id;
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;
    pos.manualPrice = input.value !== "" ? Number(input.value) : null;
    savePositions();
    render();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else {
        sortKey = key;
        sortDir = key === "itm" ? "desc" : "asc";
      }
      render();
    });
  });

  document.getElementById("refreshBtn").addEventListener("click", refreshPrices);

  // ---------- Init ----------
  render();
  if (positions.length) refreshPrices();
  setInterval(() => {
    if (positions.length) refreshPrices();
  }, STALE_MS);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
