// TrendTab — Reports > Portfolio trend: D3 line chart of the portfolio's and each account's value over the
// last year (or since the earliest ledger/balance date), as % change from the first value. Values are rebuilt
// from all Ledger records (active and inactive) valued at the stored daily closes, plus the cash balance
// history in the Balance table.
const TrendTab = (() => {
  let _ctr = 0;
  const _observers = {};   // tab id → ResizeObserver of its chart
  const _attempted = new Set();   // price gaps already fetched this session ("symbol|from|to"), not retried
  const STALE_DAYS = 4;           // a close older than this (calendar days) counts as missing (weekend + holiday)
  const PORTFOLIO_COLOR = '#2c3e50';

  function open() {
    const id = `trd-${++_ctr}`;
    App.Tabs.open(id, 'Portfolio Trend', panel => _build(panel, id),
      { refresh: () => _render(id), onClose: () => _dispose(id) });
  }

  function _build(panel, id) {
    panel.innerHTML = `
      <div class="trd-layout">
        <div class="rpt-header">
          <div class="rpt-title">Portfolio Trend</div>
          <div class="rpt-subtitle" id="${id}-subtitle"></div>
        </div>
        <div class="trd-legend" id="${id}-legend"></div>
        <div class="trd-chart aly-chart" id="${id}-chart"></div>
        <div class="trd-note" id="${id}-note"></div>
      </div>`;
    panel._trdUnchecked = new Set();   // account ids whose lines are hidden (kept across refreshes)
    _render(id);
  }

  // Lines to draw: the Portfolio line (always, computed over all accounts) and the accounts not unchecked.
  // Unchecking an account only hides its line — the portfolio values are never recalculated.
  function visibleSeries(t, uncheckedIds) {
    const hidden = new Set([...(uncheckedIds || [])].map(Number));
    return t.series.filter(s => s.key === 'portfolio' || !hidden.has(s.accountId));
  }

  function _dispose(id) {
    if (_observers[id]) { _observers[id].disconnect(); delete _observers[id]; }
  }

  // ── Data ───────────────────────────────────────────────────────────────

  // The same calendar day one year earlier (Feb 29 → Feb 28)
  function _yearBefore(day) {
    const [y, m, d] = day.split('-');
    return `${Number(y) - 1}-${m}-${m === '02' && d === '29' ? '28' : d}`;
  }

  // Daily values of each account and of the portfolio from the start date — one year before `today`, or the
  // earliest Ledger/Balance Date when later — through today. Days are the dates with stored closes (trading days).
  // Each value = the holdings below + the account's cash balance on the day: its most recent Balance record
  // (by Date, ties by Balance_ID; active or inactive), 0 before the first record.
  // On each day every account + symbol is valued with its most recent Ledger record (by Date, ties by
  // Holding_ID; active and inactive records) × the symbol's latest stored close on or before the day (the
  // earliest close when the history starts later). A record deactivated without a successor (Import holdings
  // dropping a symbol, Deactivate in the Ledger view) is counted until the account's next holdings snapshot,
  // or only on its own date when there is none. Options are not included (not valued).
  // Returns { start, end, days, series: [{ key, name, color, values, pct }], missing, gaps } — pct is the % change
  // from the series' first non-zero value (null before it); `missing` lists symbols without any stored price;
  // `gaps` lists, per symbol, the first and last day it is held without a stored close on or up to STALE_DAYS
  // before the day ({ symbol, from, to }) — the price history to fetch.
  function computeTrend(today) {
    const end = today || _todayStr();
    const empty = { start: null, end, days: [], series: [], missing: [], gaps: [] };
    const first = DB.query(`SELECT MIN(d) AS d FROM (SELECT MIN(Date) AS d FROM Ledger WHERE Date <= ?
                            UNION ALL SELECT MIN(Date) FROM Balance WHERE Date <= ?)`, [end, end])[0]?.d;
    if (!first) return empty;
    const yearAgo = _yearBefore(end);
    const start = first > yearAgo ? first : yearAgo;
    const days = DB.query('SELECT DISTINCT Date FROM Prices WHERE Valid = 1 AND Date >= ? AND Date <= ? ORDER BY Date',
      [start, end]).map(r => r.Date);
    if (!days.length) return { ...empty, start };

    // Ledger records per account + symbol, in Date order; `until` (exclusive) for deactivated leaves
    const recs = DB.query(`
      SELECT l.Holding_ID, l.Account_ID, a.Name, l.Symbol, l.Date, l.Quantity, l.Active,
        EXISTS (SELECT 1 FROM Ledger c WHERE c.Parent_ID = l.Holding_ID) AS HasChild,
        (SELECT MIN(t.Date) FROM Transactions t WHERE t.Account_ID = l.Account_ID AND t.Valid = 1
           AND t.Effect = 'Snapshot' AND t.Date >= l.Date AND t.Transaction_ID IS NOT l.Transaction_ID) AS NextSnapshot
      FROM Ledger l
      JOIN Accounts a ON a.Account_ID = l.Account_ID
      WHERE l.Date IS NOT NULL AND l.Date <= ?
      ORDER BY l.Account_ID, l.Symbol, l.Date, l.Holding_ID`, [end]);
    const pairs = new Map(), accounts = new Map();
    for (const r of recs) {
      const key = `${r.Account_ID}|${r.Symbol}`;
      if (!pairs.has(key)) pairs.set(key, { accountId: r.Account_ID, symbol: r.Symbol, recs: [], i: -1 });
      r.until = !r.Active && !r.HasChild ? (r.NextSnapshot || _nextDay(r.Date)) : null;
      pairs.get(key).recs.push(r);
      if (!accounts.has(r.Account_ID)) accounts.set(r.Account_ID, r.Name);
    }

    // Cash balance records per account, in Date order
    const cash = new Map();   // account id → { list, i }
    for (const b of DB.query(`SELECT b.Account_ID, a.Name, b.Date, b.Cash FROM Balance b
                              JOIN Accounts a ON a.Account_ID = b.Account_ID
                              WHERE b.Date IS NOT NULL AND b.Date <= ? ORDER BY b.Account_ID, b.Date, b.Balance_ID`, [end])) {
      if (!cash.has(b.Account_ID)) cash.set(b.Account_ID, { list: [], i: -1 });
      cash.get(b.Account_ID).list.push(b);
      if (!accounts.has(b.Account_ID)) accounts.set(b.Account_ID, b.Name);
    }
    const cashOn = (accId, day) => {
      const c = cash.get(accId);
      if (!c) return 0;
      while (c.i + 1 < c.list.length && c.list[c.i + 1].Date <= day) c.i++;
      return c.i >= 0 ? (c.list[c.i].Cash || 0) : 0;
    };

    // Stored closes per symbol, in Date order
    const symbols = [...new Set([...pairs.values()].map(p => p.symbol))];
    const prices = new Map(symbols.map(s => [s, { list: [], i: -1 }]));
    if (symbols.length) {
      for (const p of DB.query(`SELECT Symbol, Date, Price FROM Prices WHERE Valid = 1 AND Date <= ?
                                AND Symbol IN (${symbols.map(() => '?').join(',')}) ORDER BY Symbol, Date`, [end, ...symbols]))
        prices.get(p.Symbol).list.push(p);
    }
    // Latest close on or before the day (before the first close: the first close); `fresh` = a close within
    // STALE_DAYS before the day
    const priceOn = (sym, day) => {
      const p = prices.get(sym);
      while (p.i + 1 < p.list.length && p.list[p.i + 1].Date <= day) p.i++;
      if (p.i < 0) return { price: p.list[0]?.Price ?? null, fresh: false };
      return { price: p.list[p.i].Price, fresh: p.list[p.i].Date >= _addDays(day, -STALE_DAYS) };
    };
    const gaps = new Map();   // symbol → { symbol, from, to }

    const accIds = [...accounts.keys()];
    const values = new Map(accIds.map(id => [id, []]));
    const total = [];
    for (const day of days) {
      const byAcc = new Map(accIds.map(id => [id, cashOn(id, day)]));
      for (const p of pairs.values()) {
        while (p.i + 1 < p.recs.length && p.recs[p.i + 1].Date <= day) p.i++;
        if (p.i < 0) continue;
        const r = p.recs[p.i];
        if (!r.Quantity || (r.until && day >= r.until)) continue;
        const { price, fresh } = priceOn(p.symbol, day);
        if (!fresh) {
          const g = gaps.get(p.symbol);
          if (g) g.to = day; else gaps.set(p.symbol, { symbol: p.symbol, from: day, to: day });
        }
        if (price != null) byAcc.set(p.accountId, byAcc.get(p.accountId) + r.Quantity * price);
      }
      let sum = 0;
      for (const id of accIds) { const v = _round2(byAcc.get(id)); values.get(id).push(v); sum += v; }
      total.push(_round2(sum));
    }

    const pct = vals => {
      const base = vals.find(v => v !== 0);
      let seen = false;
      return vals.map(v => {
        if (!seen && v !== 0) seen = true;
        return seen && base ? (v / base - 1) * 100 : null;
      });
    };
    const palette = (typeof d3 !== 'undefined' && d3.schemeTableau10) ||
      ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
    const accSeries = accIds
      .filter(id => values.get(id).some(v => v !== 0))
      .sort((a, b) => accounts.get(a).localeCompare(accounts.get(b)))
      .map((id, n) => ({ key: `acc-${id}`, accountId: id, name: accounts.get(id), color: palette[n % palette.length],
                         values: values.get(id), pct: pct(values.get(id)) }));
    const series = total.some(v => v !== 0)
      ? [{ key: 'portfolio', name: 'Portfolio', color: PORTFOLIO_COLOR, values: total, pct: pct(total) }, ...accSeries]
      : [];
    const missing = symbols.filter(s => !prices.get(s).list.length).sort();
    return { start, end, days, series, missing, gaps: [...gaps.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)) };
  }

  function _addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const _nextDay = day => _addDays(day, 1);

  // Price history to fetch for the gaps not fetched yet this session (from STALE_DAYS + 3 days before the gap)
  function gapRequests(t) {
    return t.gaps.map(g => ({ symbol: g.symbol, from: _addDays(g.from, -(STALE_DAYS + 3)), to: g.to }))
      .filter(q => !_attempted.has(`${q.symbol}|${q.from}|${q.to}`));
  }

  const _round2 = v => Math.round((v + Number.EPSILON) * 100) / 100 || 0;

  // ── Rendering ──────────────────────────────────────────────────────────

  // Computes the trend; when held assets have price gaps not fetched yet this session, their price history is
  // fetched first (Yahoo Finance get_chart into Prices) and the trend recalculated.
  async function _render(id) {
    const panel = document.getElementById(`panel-${id}`);
    if (!panel || panel._trdBusy) return;
    const el = panel.querySelector(`#${id}-chart`);
    let t = computeTrend();
    const requests = gapRequests(t);
    if (requests.length && typeof fetchPriceHistory === 'function') {
      requests.forEach(q => _attempted.add(`${q.symbol}|${q.from}|${q.to}`));
      panel._trdBusy = true;
      try {
        panel._trdFetch = await fetchPriceHistory(requests, 'Portfolio Trend — Fetching Missing Prices');
        if (panel._trdFetch.updated) App.onDataChanged();   // refreshes the other tabs (this one is busy: skipped)
      } finally {
        panel._trdBusy = false;
      }
      if (!document.getElementById(`panel-${id}`)) return;   // tab closed meanwhile
      t = computeTrend();
    }
    const fmtDay = s => new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    panel.querySelector(`#${id}-subtitle`).textContent = t.days.length
      ? `Value change from ${fmtDay(t.days[0])} to ${fmtDay(t.days[t.days.length - 1])} (${t.days.length} trading days)` : '';
    // Legend: the Portfolio line, then one checkbox per account (unchecked = line hidden)
    const item = s => `<span class="trd-swatch${s.key === 'portfolio' ? ' trd-swatch-main' : ''}" style="background:${s.color}"></span>${_esc(s.name)}
        <span class="trd-legend-val ${_cls(_last(s.pct))}">${_fmtPct(_last(s.pct))}</span>`;
    const port = t.series.find(s => s.key === 'portfolio');
    const accs = t.series.filter(s => s.key !== 'portfolio');
    const legend = panel.querySelector(`#${id}-legend`);
    legend.innerHTML = (port ? `<span class="trd-legend-item" title="All accounts — not affected by the checkboxes">${item(port)}</span>` : '') +
      (accs.length ? `<span class="rpt-filters-label">Accounts:</span>` : '') +
      accs.map(s => `<label class="trd-legend-item rpt-filter"><input type="checkbox" value="${s.accountId}"${panel._trdUnchecked.has(s.accountId) ? '' : ' checked'}>${item(s)}</label>`).join('');
    legend.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      const accId = Number(cb.value);
      if (cb.checked) panel._trdUnchecked.delete(accId); else panel._trdUnchecked.add(accId);
      if (panel._trdDraw) panel._trdDraw();   // redraw only; no recalculation
    }));
    panel.querySelector(`#${id}-note`).innerHTML = [
      'Holdings from the Ledger valued at the stored daily closes plus the cash balance; options are not included. Deposits and withdrawals move the lines.',
      t.missing.length ? `<span class="rpt-neg">No prices available for ${_esc(t.missing.join(', '))} (valued at 0).</span>` : '',
      (f => f && f.failures.length ? `<span class="rpt-neg" title="${_esc(f.failures.map(x => `${x.symbol}: ${x.reason}`).join('\n'))}">` +
        `Missing prices could not be fetched for ${_esc([...new Set(f.failures.map(x => x.symbol))].join(', '))}.</span>` : '')(panel._trdFetch),
    ].filter(Boolean).join(' ');

    _dispose(id);
    panel._trdDraw = null;
    if (!t.series.length) {
      el.innerHTML = `<div class="rpt-empty">${t.start ? 'No stored prices in the period — run Tools &gt; Update prices.' : 'No ledger entries.'}</div>`;
      return;
    }
    if (typeof d3 === 'undefined') { el.innerHTML = '<div class="rpt-empty">Chart library (lib/d3.min.js) not loaded.</div>'; return; }
    const draw = () => _drawChart(el, { ...t, series: visibleSeries(t, panel._trdUnchecked) });
    panel._trdDraw = draw;
    draw();
    let lastW = el.clientWidth, lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastW && el.clientHeight === lastH) return;
      lastW = el.clientWidth; lastH = el.clientHeight;
      draw();
    });
    ro.observe(el);
    _observers[id] = ro;
  }

  function _drawChart(el, t) {
    el.innerHTML = '';
    const width  = Math.max(el.clientWidth, 420);
    const height = Math.max(el.clientHeight, 300);
    const m = { top: 16, right: 24, bottom: 30, left: 64 };
    const w = width - m.left - m.right, h = height - m.top - m.bottom;
    if (w <= 0 || h <= 0) return;

    const dates = t.days.map(d => new Date(d + 'T12:00:00'));
    const all = t.series.flatMap(s => s.pct).filter(v => v != null && isFinite(v));
    const [lo, hi] = d3.extent([0, ...all]);
    const pad = (hi - lo) * 0.05 || 1;
    const x = d3.scaleTime().domain(d3.extent(dates)).range([0, w]);
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice().range([h, 0]);
    const fmtAxis = v => `${v > 0 ? '+' : ''}${d3.format(',.0f')(v)}%`;
    const fmtMonth = d => d.getMonth() === 0 ? d3.timeFormat('%b %Y')(d) : d3.timeFormat('%b')(d);

    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height).attr('class', 'aly-chart-svg');
    const plot = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    plot.append('g').attr('class', 'aly-chart-grid').call(d3.axisLeft(y).ticks(8).tickSize(-w).tickFormat(''));
    plot.append('line').attr('class', 'trd-zero').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0));
    plot.append('g').attr('class', 'aly-chart-axis').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(d3.timeMonth.every(1)).tickFormat(fmtMonth));
    plot.append('g').attr('class', 'aly-chart-axis').call(d3.axisLeft(y).ticks(8).tickFormat(fmtAxis));

    // accounts first, the portfolio line on top
    for (const s of [...t.series].reverse()) {
      const line = d3.line().defined(v => v != null && isFinite(v)).x((v, i) => x(dates[i])).y(v => y(v));
      plot.append('path').datum(s.pct).attr('fill', 'none').attr('stroke', s.color)
        .attr('stroke-width', s.key === 'portfolio' ? 2.5 : 1.5).attr('stroke-linejoin', 'round').attr('d', line);
    }

    // Hover: vertical line at the nearest day with each line's value in a tooltip
    const cross = plot.append('line').attr('class', 'trd-cross').attr('y1', 0).attr('y2', h).style('display', 'none');
    const tip = d3.select(el).append('div').attr('class', 'trd-tip').style('display', 'none');
    const bisect = d3.bisector(d => d).center;
    plot.append('rect').attr('width', w).attr('height', h).attr('fill', 'transparent')
      .on('mousemove', ev => {
        const [mx] = d3.pointer(ev);
        const i = bisect(dates, x.invert(mx));
        const cx = x(dates[i]);
        cross.attr('x1', cx).attr('x2', cx).style('display', null);
        tip.html(`<div class="trd-tip-date">${d3.timeFormat('%b %d, %Y')(dates[i])}</div>` + t.series.map(s =>
          `<div><span class="trd-swatch" style="background:${s.color}"></span>${_esc(s.name)}: <b>${_fmtPct(s.pct[i])}</b>
             <span class="trd-tip-val">${_fmtMoney(s.values[i])}</span></div>`).join(''))
          .style('display', null);
        const tw = tip.node().offsetWidth;
        tip.style('left', `${m.left + cx + 12 + tw > width ? m.left + cx - tw - 12 : m.left + cx + 12}px`).style('top', `${m.top + 8}px`);
      })
      .on('mouseleave', () => { cross.style('display', 'none'); tip.style('display', 'none'); });
  }

  const _last = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const _cls = v => v == null ? '' : v < 0 ? 'rpt-neg' : 'trd-pos';
  const _fmtPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  const _fmtMoney = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);
  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, computeTrend, visibleSeries, gapRequests };
})();
