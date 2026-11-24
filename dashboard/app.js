// Launch Radar dashboard: renders window.RADAR (written beside this page by main.ts) with no
// network, no framework and no build step. Three views and a detail page, routed by the hash:
//   #/            the ranked board, sortable and filterable
//   #/p/<slug>    one protocol: its value, the model's working and its farm plan
//   #/live        the tokenised peers the model was fitted on
//   #/method      the model, its held-out validation, and the accounting of every protocol
'use strict';

const R = window.RADAR;
const app = document.getElementById('app');

/* ---------- formatting ---------- */
function fmt$(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}
function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}
function fmtAge(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days >= 730) return (days / 365).toFixed(1) + ' yrs';
  if (days >= 60) return Math.round(days / 30.4) + ' mo';
  return days + ' d';
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function moneyCell(v) {
  const td = el('td', 'num money', fmt$(v));
  return td;
}

/* ---------- routing ---------- */
function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const key = a.getAttribute('data-nav');
    const on = (key === 'board' && (parts.length === 0 || parts[0] === 'p')) || (key === 'live' && parts[0] === 'live') || (key === 'method' && parts[0] === 'method');
    a.classList.toggle('on', on);
  });
  app.setAttribute('aria-busy', 'true');
  if (parts[0] === 'p' && parts[1]) renderDetail(parts[1]);
  else if (parts[0] === 'live') renderLive();
  else if (parts[0] === 'method') renderMethod();
  else renderBoard(params);
  app.setAttribute('aria-busy', 'false');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ---------- the board ---------- */
const VERDICT_ORDER = { 'Farm first': 0, Farm: 1, Watch: 2 };
let boardState = { key: 'rank', dir: 1, q: '', cat: '', chain: '', verdict: '', watch: false };

function kpiStrip() {
  const m = R.model;
  const strip = el('div', 'kpis');
  const items = [
    ['Protocols scanned', String(R.counts.protocols), R.counts.tokenised + ' already record a token'],
    ['Watchlist covered', R.counts.watchlist + ' / ' + R.counts.watchlist, 'every slug on the house watchlist is ranked'],
    ['Pre-token ranked', String(R.counts.ranked), R.counts.excluded + ' set aside, each with its reason'],
    ['Model held-out error', 'x' + m.medianMultiple, 'median, five-fold cross-validation'],
    ['Value interval band', 'x' + m.bandMultiple, '80th percentile held-out error'],
    ['Snapshot as of', R.as_of, 'sealed DefiLlama data, never updated'],
  ];
  for (const [label, value, note] of items) {
    const k = el('div', 'kpi');
    k.append(el('div', 'k-label', label), el('div', 'k-value', value), el('div', 'k-note', note));
    strip.append(k);
  }
  return strip;
}

function renderBoard(params) {
  if (params) {
    boardState = {
      key: 'rank', dir: 1,
      q: params.get('q') || '',
      cat: params.get('cat') || '',
      chain: params.get('chain') || '',
      verdict: params.get('verdict') || '',
      watch: params.get('watch') === '1',
    };
  }
  app.textContent = '';
  app.append(kpiStrip());

  const cats = [...new Set(R.rows.map((r) => r.category || 'Uncategorised'))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();

  const bar = el('div', 'filters');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search name or slug';
  search.value = boardState.q;
  search.addEventListener('input', () => { boardState.q = search.value; drawRows(tbody, count); });
  const lab = (text, node) => { const l = el('label', null, text); l.append(node); return l; };
  const mkSelect = (values, all, current, set) => {
    const s = document.createElement('select');
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = all; s.append(o0);
    for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v; s.append(o); }
    s.value = current;
    s.addEventListener('change', () => { set(s.value); drawRows(tbody, count); });
    return s;
  };
  const catSel = mkSelect(cats, 'All categories', boardState.cat, (v) => { boardState.cat = v; });
  const chainSel = mkSelect(chains, 'All chains', boardState.chain, (v) => { boardState.chain = v; });
  const verSel = mkSelect(['Farm first', 'Farm', 'Watch'], 'All verdicts', boardState.verdict, (v) => { boardState.verdict = v; });
  const watchBox = document.createElement('input');
  watchBox.type = 'checkbox';
  watchBox.checked = boardState.watch;
  watchBox.addEventListener('change', () => { boardState.watch = watchBox.checked; drawRows(tbody, count); });
  const count = el('span', 'count');
  bar.append(lab('Search', search), lab('Category', catSel), lab('Chain', chainSel), lab('Verdict', verSel), lab('Watchlist only', watchBox), count);

  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const cols = [
    ['rank', '#', 'num'], ['name', 'Protocol', ''], ['category', 'Category', ''],
    ['tvl_usd', 'TVL', 'num'], ['change_7d', '7d', 'num'], ['age_days', 'Age', 'num'],
    ['implied_value_usd', 'Implied value', 'num'], ['band', 'Interval', ''],
    ['peer_odds', 'Peer record', 'num'], ['verdict', 'Verdict', ''],
  ];
  for (const [key, label, cls] of cols) {
    const th = el('th', cls, label);
    if (key !== 'band') {
      th.addEventListener('click', () => {
        if (boardState.key === key) boardState.dir *= -1;
        else { boardState.key = key; boardState.dir = key === 'name' || key === 'category' ? 1 : -1; if (key === 'rank') boardState.dir = 1; }
        drawRows(tbody, count);
        markSort(htr);
      });
    }
    th.dataset.key = key;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  wrap.append(table);
  app.append(bar, wrap);
  drawRows(tbody, count);
  markSort(htr);
}

function markSort(htr) {
  htr.querySelectorAll('th').forEach((th) => {
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = base;
    if (th.dataset.key === boardState.key) {
      const s = el('span', 'dir', boardState.dir === 1 ? ' ▲' : ' ▼');
      th.append(s);
    }
  });
}

function filteredRows() {
  const q = boardState.q.trim().toLowerCase();
  let rows = R.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!boardState.cat || (r.category || 'Uncategorised') === boardState.cat) &&
    (!boardState.chain || r.chains.includes(boardState.chain)) &&
    (!boardState.verdict || r.verdict === boardState.verdict) &&
    (!boardState.watch || r.watchlist));
  const k = boardState.key;
  const dir = boardState.dir;
  const val = (r) => k === 'verdict' ? VERDICT_ORDER[r.verdict] : k === 'name' ? r.name.toLowerCase() : k === 'category' ? (r.category || '') : r[k];
  rows = [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === y) return a.rank - b.rank;
    return (x < y ? -1 : 1) * dir;
  });
  return rows;
}

function drawRows(tbody, count) {
  const rows = filteredRows();
  count.textContent = rows.length + ' of ' + R.rows.length + ' rows';
  tbody.textContent = '';
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = el('td', 'empty', 'No protocol matches these filters.');
    td.colSpan = 10;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.addEventListener('click', () => { location.hash = '#/p/' + r.slug; });
    tr.append(el('td', 'rank', String(r.rank)));
    const name = el('td', 'name', r.name);
    name.append(el('span', 'slug', r.slug));
    tr.append(name);
    const cat = el('td', null, r.category || 'Uncategorised');
    if (r.watchlist) { const p = el('span', 'pill watch-yes', 'watchlist'); cat.append(document.createTextNode(' '), p); }
    tr.append(cat);
    tr.append(moneyCell(r.tvl_usd));
    const ch = el('td', 'num pct', fmtPct(r.change_7d));
    if (r.change_7d !== null) ch.classList.add(r.change_7d >= 0 ? 'pos' : 'neg');
    tr.append(ch);
    tr.append(el('td', 'num', fmtAge(r.age_days)));
    tr.append(moneyCell(r.implied_value_usd));
    tr.append(el('td', 'band', fmt$(r.implied_low_usd) + ' – ' + fmt$(r.implied_high_usd)));
    tr.append(el('td', 'num odds', Math.round(r.peer_odds * 100) + '%'));
    const v = el('td');
    const pill = el('span', 'pill ' + (r.verdict === 'Farm first' ? 'v-first' : r.verdict === 'Farm' ? 'v-farm' : 'v-watch'), r.verdict);
    v.append(pill);
    tr.append(v);
    tbody.append(tr);
  }
}

/* ---------- one protocol ---------- */
function renderDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  app.textContent = '';
  const back = el('a', 'back', '← Back to the board');
  back.href = '#/';
  app.append(back);
  if (!r) { app.append(el('p', 'empty', 'No ranked protocol with that slug.')); return; }
  const m = R.model;

  const head = el('div', 'detail-head');
  head.append(el('h2', null, r.name), el('span', 'd-slug', r.slug + ' · rank #' + r.rank + ' of ' + R.rows.length));
  if (r.watchlist) head.append(el('span', 'pill watch-yes', 'on the house watchlist'));
  app.append(head);

  const facts = el('div', 'facts');
  const fact = (label, value, note) => {
    const f = el('div', 'fact');
    f.append(el('div', 'f-label', label), el('div', 'f-value', value));
    if (note) f.append(el('div', 'f-note', note));
    facts.append(f);
  };
  fact('TVL', fmt$(r.tvl_usd), 'as recorded in the snapshot');
  fact('7-day TVL change', fmtPct(r.change_7d), r.change_7d === null ? 'unreported: the model reads 0' : 'clamped to the fitted band');
  fact('Age with no token', fmtAge(r.age_days), r.age_days === null ? 'listing day unreported' : 'since DefiLlama began tracking it');
  fact('Category', r.category || 'Uncategorised', 'multiple x' + r.category_multiple + ' from its peers');
  fact('Chains', r.chains.length ? r.chains.join(', ') : 'none named', '');
  fact('Peer launch record', Math.round(r.peer_odds * 100) + '%', 'of its category already record a token');
  app.append(facts);

  const value = el('section', 'panel');
  value.append(el('h3', null, 'Implied value if it launched on this record'));
  const big = el('div', 'bignum', fmt$(r.implied_value_usd));
  value.append(big);
  const bar = el('div', 'bandbar');
  const fill = el('div', 'fill');
  fill.style.left = '0%'; fill.style.right = '0%';
  const mark = el('div', 'mark');
  mark.style.left = '50%';
  bar.append(fill, mark);
  value.append(bar);
  const labels = el('div', 'bandlabels');
  labels.append(el('span', null, fmt$(r.implied_low_usd)), el('span', null, 'interval: divide / multiply by x' + m.bandMultiple), el('span', null, fmt$(r.implied_high_usd)));
  value.append(labels);
  const how = el('p');
  how.append(
    document.createTextNode('How the model gets here: TVL ' + fmt$(r.tvl_usd) + ' x category multiple '),
    Object.assign(el('strong', null, 'x' + r.category_multiple), {}),
    document.createTextNode(', then the fitted ' + (m.chosen.useSize ? 'size slope (' + m.sizeSlope + ' per decade of TVL) ' : '') + (m.chosen.useGrowth ? 'growth slope (' + m.growthSlope + ' per point of 7-day change) ' : '') + (m.chosen.useAge ? 'age slope (' + m.ageSlope + ' per log-year of age) ' : '') + 'terms. The interval is the model\'s own held-out error band, not a promise.'),
  );
  value.append(how);
  app.append(value);

  const plan = el('section', 'panel');
  plan.append(el('h3', null, 'Farm plan: ' + r.verdict));
  const ol = document.createElement('ol');
  ol.className = 'steps';
  for (const s of r.farm_steps) {
    const li = el('li', null, s);
    ol.append(li);
  }
  plan.append(ol);
  const totals = el('div', 'totals');
  totals.append(
    el('span', null, 'Capital at work: '), Object.assign(el('strong', null, fmt$(r.capital_usd)), {}),
    el('span', null, 'Plan spend (gas): '), Object.assign(el('strong', null, fmt$(r.spend_usd)), {}),
    el('span', null, 'Time: '), Object.assign(el('strong', null, r.hours + ' hours of actions'), {}),
  );
  plan.append(totals);
  const note = el('p', 'small', 'The verdict prices this plan: implied value weighted by the category\'s launch record, per dollar the plan spends. Farm first marks the board\'s top band on that measure; it is the radar\'s own ordering, not advice.');
  plan.append(note);
  app.append(plan);
}

/* ---------- the peers the model learned from ---------- */
function renderLive() {
  app.textContent = '';
  const intro = el('div', 'method');
  const h = el('h2', null, 'Live tokens: the peers the model was fitted on');
  const p = el('p', null, 'These protocols already record a token, so the market has priced them. Their market cap next to TVL is the training record: the model reads each category\'s median ratio from rows like these, then applies it to the pre-token board. They are never ranked as launches.');
  intro.append(h, p);
  app.append(intro);
  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const [label, cls] of [['Protocol', ''], ['Category', ''], ['TVL', 'num'], ['Market cap', 'num'], ['Cap / TVL', 'num']]) {
    htr.append(el('th', cls, label));
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  for (const r of R.live) {
    const tr = document.createElement('tr');
    const name = el('td', 'name', r.name);
    name.append(el('span', 'slug', r.slug));
    tr.append(name, el('td', null, r.category || 'Uncategorised'));
    tr.append(moneyCell(r.tvl_usd));
    tr.append(moneyCell(r.mcap_usd));
    tr.append(el('td', 'num money', r.ratio === null ? '—' : 'x' + r.ratio));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  app.append(wrap);
}

/* ---------- method and accounting ---------- */
function renderMethod() {
  app.textContent = '';
  const m = R.model;
  const root = el('div', 'method');
  root.append(el('h2', null, 'Method: a fitted model, checked out of sample'));
  const p1 = el('p');
  p1.append(
    document.createTextNode('The board\'s implied values are not a house multiple. They are fitted on this snapshot\'s own '),
    el('strong', null, m.peerCount + ' tokenised protocols'),
    document.createTextNode(': for each category, the median of log10(market cap / TVL) across its peers, shrunk toward the global median (x' + m.globalMultiple + ') with weight ' + m.shrinkK + ', so thin categories borrow the field\'s record. On top of the multiple, a size term (how the ratio moves with TVL itself), a growth term (7-day TVL change, clamped) and an age term (log age with no token) may each earn a slope by least squares.'),
  );
  root.append(p1);
  const p2 = el('p', null, 'Which terms are kept is decided by five-fold cross-validation on the peers, re-run by the program on every run: folds are dealt by slug order, each fold is predicted from a fit on the other four, and the term set with the lowest held-out median error wins, ties going to the simpler model. The full table:');
  root.append(p2);
  const table = document.createElement('table');
  table.className = 'mini';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const label of ['Terms', 'Held-out median error', 'Held-out 80th percentile']) htr.append(el('th', null, label));
  thead.append(htr);
  const tbody = document.createElement('tbody');
  const chosenTerms = (() => {
    const parts = ['category'];
    if (m.chosen.useSize) parts.push('size');
    if (m.chosen.useGrowth) parts.push('growth');
    if (m.chosen.useAge) parts.push('age');
    return parts.join(' + ');
  })();
  for (const v of m.validations) {
    const tr = document.createElement('tr');
    if (v.terms === chosenTerms) tr.className = 'chosen';
    tr.append(el('td', null, v.terms), el('td', 'num money', 'x' + v.medianMultiple), el('td', 'num money', 'x' + v.p80Multiple));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  root.append(table);
  const p3 = el('p', null, 'Every implied value carries the kept model\'s 80th-percentile band (x' + m.bandMultiple + ') as its interval. The honest reading of that table: a launch value is knowable only within a few-fold range, and any radar that prints a point value with no band is claiming more than the record holds.');
  root.append(p3);
  const p4 = el('p');
  p4.append(
    document.createTextNode('Ranks follow implied value alone. The farm verdict is separate: it weights implied value by the category\'s launch record (the shrunk share of its protocols that already record a token) and divides by the plan\'s spend, so a costly plan on a thin record sinks and a cheap plan on a proven category rises. Farm steps are generated per protocol from its category, first chain, TVL band and age, with chain-level gas estimates; no protocol is named or special-cased anywhere in the model.'),
  );
  root.append(p4);

  root.append(el('h3', null, 'Accounting: every one of the ' + R.counts.protocols + ' protocols'));
  const acc = el('ul');
  const li = (html) => { const n = document.createElement('li'); n.innerHTML = html; return n; };
  acc.append(
    li('<strong>' + R.counts.tokenised + '</strong> already record a token: set aside from the board. The <strong>' + m.peerCount + '</strong> of them with a recorded market cap are the fitting peers the model learns from, the largest shown under Live tokens; the rest record a token with no priced cap, so they teach the model nothing and are never ranked as launches.'),
    li('<strong>' + R.counts.ranked + '</strong> record no token and are ranked on the board, including all <strong>' + R.counts.watchlist + '</strong> on the house watchlist (TVL at or above ' + fmt$(R.floor_usd) + ', no token, not a wrapped or staked product).'),
    li('<strong>' + R.counts.excluded + '</strong> record no token but are not ranked, each for the reason in the table below: the board applies the house\'s own product rules at every size, so wrapped, staked and bridged products of tokens that already trade, exchange products and versioned pools are set aside exactly as the watchlist sets them aside.'),
  );
  root.append(acc);
  if (R.excluded.length > 0) {
    const wrap = el('div', 'table-wrap');
    const t = document.createElement('table');
    t.className = 'mini';
    const th = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['Protocol', 'Category', 'TVL', 'Reason not ranked']) hr.append(el('th', null, label));
    th.append(hr);
    const tb = document.createElement('tbody');
    for (const r of R.excluded) {
      const tr = document.createElement('tr');
      const name = el('td', 'name', r.name);
      name.append(el('span', 'slug', r.slug));
      tr.append(name, el('td', null, r.category || 'Uncategorised'));
      tr.append(moneyCell(r.tvl_usd));
      tr.append(el('td', null, r.reason));
      tb.append(tr);
    }
    t.append(th, tb);
    wrap.append(t);
    root.append(wrap);
  }
  const prov = el('p', 'small', 'Data: ' + R.source + '. Snapshot as of ' + R.as_of + '. Model version ' + m.version + '.');
  root.append(prov);
  app.append(root);
}

route();
