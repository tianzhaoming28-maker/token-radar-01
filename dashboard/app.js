// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board with its filters, a per-protocol detail view with the model's own
// arithmetic and the protocol's farm plan, a live-token view of the protocols that already
// trade, and a sandbox that re-runs the model with moved weights so a reader can test how
// much of a rank is the protocol and how much is the model. No network: every byte it shows
// is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;
  var app = document.getElementById('board');
  var state = {
    q: '', category: 'all', chain: 'all', tab: 'pre', wl: false,
    sort: 'implied', dir: -1, selected: null,
    gw: M.growth_weight, ms: M.maturity_span, xm: 1
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model, restated: the same arithmetic lib/model.ts runs, so the page can check any row
  // of board.json and re-run it with the sandbox's weights. peer_multiple is the category's
  // shrunk median market-cap / TVL among its launched peers, learned from the snapshot.
  function growthMult(row, gw) {
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    g = Math.min(M.growth_cap, Math.max(M.growth_floor, g));
    return 1 + (g / 100) * gw;
  }
  function maturityMult(row, ms) {
    var age = row.age_days === null || row.age_days === undefined ? M.unknown_age_days : row.age_days;
    return M.maturity_base + (Math.min(Math.max(age, 0), M.maturity_days) / M.maturity_days) * ms;
  }
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.peer_multiple * state.xm * growthMult(row, state.gw) * maturityMult(row, state.ms)));
  }
  function sandboxMoved() {
    return state.gw !== M.growth_weight || state.ms !== M.maturity_span || state.xm !== 1;
  }
  // Rows as the board currently stands: canonical ranks, or sandbox ranks when the weights moved.
  function currentRows() {
    var rows = DATA.rows.map(function (r) {
      var copy = Object.assign({}, r);
      copy.shown_implied = sandboxMoved() ? impliedOf(r) : r.implied_value_usd;
      return copy;
    });
    if (sandboxMoved()) {
      rows.sort(function (a, b) { return b.shown_implied - a.shown_implied || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); });
      rows.forEach(function (r, i) { r.shown_rank = i + 1; });
    } else {
      rows.forEach(function (r) { r.shown_rank = r.rank; });
    }
    return rows;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('wl') === '1') state.wl = true;
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre') params.set('tab', state.tab);
    if (state.wl) params.set('wl', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filtered(list) {
    var q = state.q.trim().toLowerCase();
    return list.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.wl && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'mult') { av = a.peer_multiple; bv = b.peer_multiple; }
      else { av = a.shown_implied; bv = b.shown_implied; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Source ', el('b', { text: 'DefiLlama protocol index' })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version }))
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, 'Every pre-token protocol worth farming, ', el('span', { class: 'hl', text: 'ranked by what its token would be worth' })),
        el('p', { text: 'The board prices each protocol that records no token the way the market already prices its launched peers: TVL times the category\u2019s market-cap-to-TVL multiple, adjusted for seven-day growth and for how long it has run with no token. The watchlist is the floor, not the ceiling: the radar also ranks the early protocols below it. Implied value is the model\u2019s claim, not a promise, and nothing here says a token will ever be issued.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Market-wide peer multiple' }), el('b', { text: DATA.global_median_ratio.toFixed(3) + 'x' }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () {
      state.q = search.value; writeHash(); render();
      var again = document.getElementById('q');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    function select(id, label, values, allLabel, current, onChange) {
      var sel = el('select', { id: id, 'aria-label': label },
        el('option', { value: 'all', text: allLabel }),
        values.map(function (v) { return el('option', { value: v, text: v, selected: v === current ? 'selected' : null }); })
      );
      sel.addEventListener('change', function () { onChange(sel.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), sel);
    }
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trading', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    var wlBox = el('input', { type: 'checkbox', id: 'wl', checked: state.wl ? 'checked' : null });
    wlBox.addEventListener('change', function () { state.wl = wlBox.checked; writeHash(); render(); });
    var shown = state.tab === 'pre' ? filtered(currentRows()).length : DATA.live.length;
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      select('category', 'Category', categories, 'All categories', state.category, function (v) { state.category = v; }),
      select('chain', 'Chain', chains, 'All chains', state.chain, function (v) { state.chain = v; }),
      el('div', { class: 'field' }, el('span', { class: 'flab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('label', { class: 'field check', for: 'wl' }, wlBox, 'Watchlist only'),
      el('span', { class: 'count', text: shown + (state.tab === 'pre' ? ' rows shown' : ' live protocols') })
    );
  }

  function lab() {
    function slider(label, min, max, step, value, fmt, onInput) {
      var out = el('output', { text: fmt(value) });
      var input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      input.addEventListener('input', function () { out.textContent = fmt(parseFloat(input.value)); });
      input.addEventListener('change', function () { onInput(parseFloat(input.value)); render(); });
      return el('label', { class: 'slider' }, label, input, out);
    }
    var note = sandboxMoved()
      ? 'Sandbox weights moved: the board below is re-ranked live. board.json keeps the submitted model.'
      : '';
    return el('section', { class: 'lab', 'aria-label': 'Model sandbox' },
      el('div', { class: 'lab-head' },
        el('h2', { text: 'Model sandbox' }),
        el('span', { class: 'note', text: note }),
        el('button', { class: 'reset', type: 'button', text: 'Reset weights', onclick: function () { state.gw = M.growth_weight; state.ms = M.maturity_span; state.xm = 1; render(); } })
      ),
      el('div', { class: 'sliders' },
        slider('Growth weight', 0, 1.2, 0.05, state.gw, function (v) { return v.toFixed(2); }, function (v) { state.gw = v; }),
        slider('Maturity span', 0, 0.9, 0.05, state.ms, function (v) { return v.toFixed(2); }, function (v) { state.ms = v; }),
        slider('Peer multiple scale', 0.5, 1.5, 0.05, state.xm, function (v) { return v.toFixed(2) + 'x'; }, function (v) { state.xm = v; })
      )
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function boardTable() {
    var list = sorted(filtered(currentRows()));
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.wl = false; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.shown_implied; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rank', text: String(r.shown_rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unrecorded') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.peer_multiple.toFixed(3) + 'x' }),
        el('td', null, el('div', null,
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.shown_implied / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.shown_implied) })
        )),
        el('td', null, r.watchlist
          ? el('span', { class: 'flag', text: 'Watchlist' })
          : el('span', { class: 'flag early', text: 'Early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value. Select a row for its model breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('mult', 'Peer \u00d7'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Radar' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.symbol || 'no symbol recorded') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio === null ? 'n/a' : r.ratio.toFixed(3) + 'x' }),
        el('td', null, el('span', { class: 'status-live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Already trading: these protocols have a token, so their market cap is a fact, not a model. They are the peers the pre-token board is priced from, and they are never ranked as launches.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Cap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var formula = [
      'peer multiple  = shrunk median of (market cap / TVL) over the category\u2019s launched protocols',
      'growth mult    = 1 + clamp(change_7d, ' + M.growth_floor + ', ' + M.growth_cap + ') / 100 \u00d7 ' + M.growth_weight,
      'maturity mult  = ' + M.maturity_base + ' + min(age_days, ' + M.maturity_days + ') / ' + M.maturity_days + ' \u00d7 ' + M.maturity_span,
      'implied value  = round(TVL \u00d7 peer multiple \u00d7 growth mult \u00d7 maturity mult)'
    ].join('\n');
    return el('section', { class: 'panel pad' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function of the snapshot\u2019s own figures scores every row. The peer multiple is learned from the protocols that already launched: across this snapshot their tokens trade at a median of ' + DATA.global_median_ratio.toFixed(3) + 'x TVL, and each category\u2019s multiple is its own median pulled toward that figure by ' + M.peer_shrinkage + ' phantom peers, so a category with two launches is not priced off two points. A peer\u2019s own ratio is first held inside [' + M.ratio_floor + ', ' + M.ratio_cap + ']: this index carries tokens whose market cap has little to do with the TVL recorded beside them, and one such record must not price a whole category. Age is the time since DefiLlama first tracked the protocol: the best record of how long it has run with no token. An unrecorded age counts as ' + M.unknown_age_days + ' days. No protocol\u2019s name is special-cased.' }),
      el('div', { class: 'formula', text: formula })
    );
  }

  function peersPanel() {
    var shown = DATA.peers.filter(function (p) { return p.peers >= 3; }).slice(0, 14);
    var tbody = el('tbody');
    shown.forEach(function (p) {
      tbody.appendChild(el('tr', null,
        el('td', { text: p.category }),
        el('td', { class: 'num', text: String(p.peers) }),
        el('td', { class: 'num', text: p.median_ratio.toFixed(3) + 'x' }),
        el('td', { class: 'num', text: p.multiple.toFixed(3) + 'x' })
      ));
    });
    return el('section', { class: 'panel pad' },
      el('h2', { text: 'What launched tokens actually trade at' }),
      el('p', { class: 'sub', text: 'The peer table the model is priced from: every category with at least three launched protocols in this snapshot.' }),
      el('table', { class: 'mini peers-table' },
        el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { text: 'Launched peers' }), el('th', { text: 'Median cap / TVL' }), el('th', { text: 'Multiple used' }))),
        tbody
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var check = impliedOf(row);
    var stat = DATA.peers.filter(function (p) { return p.category === (row.category || 'Uncategorised'); })[0];
    var inner = el('div', { class: 'detail-in' });
    inner.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' \u00b7 on the watchlist' : ' \u00b7 early, below the watchlist floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain unrecorded') + ' \u00b7 records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    inner.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value, step by step' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Peer multiple (' + (row.category || 'market') + ')' }), el('b', { class: 'num', text: row.peer_multiple.toFixed(3) + 'x' })),
        el('div', null, el('span', { text: 'Launched peers behind it' }), el('b', { class: 'num', text: String(row.peer_count) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: growthMult(row, M.growth_weight).toFixed(3) + 'x' })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: maturityMult(row, M.maturity_span).toFixed(3) + 'x' })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'The page recomputes this row from the snapshot figures as ' + fmtUsd(check) + (check === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from board.json: the data would be stale.') + ' An implied value is what a token would be worth if the protocol\u2019s record stayed as it is; it is not a prediction that a token will be issued.' })
    ));
    if (stat && stat.top.length > 0) {
      var pbody = el('tbody');
      stat.top.forEach(function (t) {
        pbody.appendChild(el('tr', null,
          el('td', { text: t.name }),
          el('td', { class: 'num', text: fmtUsd(t.tvl_usd) }),
          el('td', { class: 'num', text: fmtUsd(t.mcap_usd) }),
          el('td', { class: 'num', text: t.ratio.toFixed(3) + 'x' })
        ));
      });
      inner.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: 'The peers this price leans on' }),
        el('table', { class: 'mini' },
          el('thead', null, el('tr', null, el('th', { text: 'Launched peer' }), el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }), el('th', { text: 'Cap / TVL' }))),
          pbody
        )
      ));
    }
    inner.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), tail ? el('span', { class: 'cost', text: tail }) : null);
      }))
    ));
    dialog.textContent = '';
    dialog.appendChild(inner);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.tab === 'pre') {
      shell.appendChild(lab());
      shell.appendChild(boardTable());
      shell.appendChild(el('div', { class: 'grid2' }, modelPanel(), peersPanel()));
    } else {
      shell.appendChild(liveTable());
    }
    shell.appendChild(el('p', { class: 'foot', text: 'Data: the sealed DefiLlama snapshot of ' + DATA.as_of + ', fetched once and never updated; this page renders offline from the data main.ts wrote beside it. A protocol here records no token in that snapshot, which is not proof it has none. Implied values are the model\u2019s own claims, stated so they can be argued with.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.tab = 'pre'; state.wl = false; state.selected = null;
    readHash();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
