/*
 * Spell Turn-ins - PoP quartermaster tracker for Project Quarm guilds.
 * Branding (the guild name) comes from config.json's guildName.
 *
 * Data model (window.SEED_DATA, a generated dataset; schema in CLAUDE.md, Data pipeline):
 *   classes: [{ name, npc, spells: [{ name, level, itemName, era, turnins }] }]
 *   pools:   { npcName: { itemName: { denom, spells: [{ itemName, name, level }] } } }
 *
 * Rules implemented:
 *   - Spectral Parchment -> random 63-64 spell from the class NPC's pool (odds 1/denom).
 *   - Glyphed Rune Word  -> random 65 spell from the class NPC's pool.
 *   - Phase 1: priority rounds; a tier is fully served (all wanted copies, walking the
 *     class order) before the next tier starts.
 *   - Phase 2: fair share by (M1 + m2Ratio x M2) x pool size; feed the most-behind class.
 *   - Duplicate results are flagged "to roll" (raid / Discord roll among mains).
 */

'use strict';

const DATA = window.SEED_DATA;
const ITEMS = ['Spectral Parchment', 'Glyphed Rune Word']; // tracked currencies (Ethereal exists in data, out of scope v1)
const ITEM_SHORT = { 'Spectral Parchment': 'Spectral', 'Glyphed Rune Word': 'Glyphed' };
const ITEM_CSS = { 'Spectral Parchment': 'spectral', 'Glyphed Rune Word': 'glyphed' };
const STORAGE_KEY = 'spelltracker.v1';
const LEGACY_STORAGE_KEY = 'nocturnal.spells.v1'; // pre-rename local states

// Class names, alphabetical for every UI listing (the phase 1 class priority
// order is user-defined and lives in state.classOrder).
const CLASSES = DATA.classes.map(c => c.name).sort((a, b) => a.localeCompare(b));
const classByName = Object.fromEntries(DATA.classes.map(c => [c.name, c]));

/* ------------------------------------------------------------------ state */

const defaultState = () => ({
  inventory: { 'Spectral Parchment': 0, 'Glyphed Rune Word': 0 },
  weights: Object.fromEntries(CLASSES.map(c => [c, 0])),   // number of mains (M1) per class
  weights2: Object.fromEntries(CLASSES.map(c => [c, 0])),  // number of second mains (M2) per class
  m2Ratio: 0.5,                                             // an M2 counts as this fraction of an M1
  priorities: Object.fromEntries(CLASSES.map(c => [c, []])), // ordered [{name, want}] per class (want = copies in phase 1)
  classOrder: [...CLASSES],                                 // phase 1 class priority order
  log: [],                                                  // {id, ts, item, cls, spell}
});

// Normalize a raw state object (from storage OR an imported file) to the
// current shape: backfill classes added to the seed data, migrate legacy
// priority lists (plain names + global phase1Target) to per-spell wanted-copy
// counts, and drop anything malformed instead of letting render() crash on it.
function normalizeState(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const st = { ...defaultState(), ...raw };
  if (!st.priorities || typeof st.priorities !== 'object') st.priorities = {};
  if (!st.weights || typeof st.weights !== 'object') st.weights = {};
  if (!st.weights2 || typeof st.weights2 !== 'object') st.weights2 = {};
  if (!st.inventory || typeof st.inventory !== 'object') st.inventory = {};
  const ratio = Number(st.m2Ratio);
  st.m2Ratio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5;
  for (const c of CLASSES) {
    st.weights[c] = Math.max(0, Number(st.weights[c]) || 0);
    st.weights2[c] = Math.max(0, Number(st.weights2[c]) || 0);
    st.priorities[c] = (Array.isArray(st.priorities[c]) ? st.priorities[c] : [])
      .filter(p => p && (typeof p === 'string' || typeof p.name === 'string'))
      .map((p, i) => typeof p === 'string'
        // Legacy entries had an implicit rank = list position.
        ? { name: p, want: Math.max(1, Math.round(Number(raw.phase1Target) || 2)), prio: i + 1 }
        : {
            name: p.name,
            want: Math.max(1, Math.round(Number(p.want) || 1)),
            prio: Math.max(1, Math.round(Number(p.prio) || (i + 1))),
          });
  }
  st.classOrder = [
    ...(Array.isArray(st.classOrder) ? st.classOrder : []).filter(c => CLASSES.includes(c)),
    ...CLASSES.filter(c => !(Array.isArray(st.classOrder) ? st.classOrder : []).includes(c)),
  ];
  st.log = (Array.isArray(st.log) ? st.log : [])
    .filter(e => e && typeof e.cls === 'string' && typeof e.spell === 'string' && ITEMS.includes(e.item));
  for (const item of ITEMS) st.inventory[item] = Math.max(0, Number(st.inventory[item]) || 0);
  delete st.phase1Target; // legacy global rounds setting
  delete st.bankCounts;   // legacy keys from before the bank decoupling
  delete st.bankFile;
  return st;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : defaultState();
  } catch {
    return defaultState();
  }
}

let state = defaultState();
let activeTab = 'dashboard';
// Transient UI state for the record flow (not persisted).
let record = { item: null, cls: null };

/*
 * Backend modes:
 *   'local':  no PHP API found (static/dev serve), state in localStorage.
 *   'login':  the API answered 401, show the Discord sign-in screen.
 *   'server': authenticated against the API, state shared server-side with
 *             optimistic locking (rev); officers write, raiders read.
 */
let MODE = 'local';
let CAN_WRITE = true;
let USER = null;
let serverRev = 0;
let saveTimer = null;
// Guild branding, read from config.json (guildName) at boot.
let GUILD_NAME = '';

async function loadBranding() {
  try {
    const cfg = await (await fetch('config.json')).json();
    if (cfg && typeof cfg.guildName === 'string' && cfg.guildName.trim()) {
      GUILD_NAME = cfg.guildName.trim();
    }
  } catch { /* keep the neutral branding */ }
  if (GUILD_NAME) {
    document.getElementById('guild-name').textContent = GUILD_NAME;
    document.title = `${GUILD_NAME} Spell Turn-ins`;
  }
}

function save() {
  if (MODE === 'server') { scheduleServerSave(); return; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage may be unavailable */ }
}

function commit() { save(); render(); }

function scheduleServerSave() {
  if (!CAN_WRITE) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushState, 600);
}

async function pushState() {
  try {
    // POST rather than PUT: some shared hosts block PUT for PHP scripts.
    const res = await fetch('api/state.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spelltracker': '1' },
      body: JSON.stringify({ rev: serverRev, state }),
    });
    if (res.status === 409) {
      // Someone else saved first: adopt their version, the user redoes the edit.
      const doc = await res.json();
      serverRev = doc.rev;
      state = normalizeState(doc.state || {});
      toast(`Someone else saved first (${doc.updatedBy || 'unknown'}), reloaded their version.`);
      render();
      return;
    }
    if (res.status === 401) { MODE = 'login'; renderHeader(); renderLogin(); return; }
    if (!res.ok) {
      // Surface the status and the server's own message: essential to
      // diagnose hosting quirks (blocked verbs, permissions, mod_security).
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch { /* non-JSON error page */ }
      toast(`Server save failed (${res.status}${msg ? ': ' + msg : ''}).`);
      return;
    }
    serverRev = (await res.json()).rev;
  } catch {
    toast('Server unreachable, last change not saved.');
  }
}

async function boot() {
  await loadBranding();
  try {
    const res = await fetch('api/me.php');
    if (res.ok) {
      const me = await res.json();
      if (me && me.perm) {
        USER = me.user;
        CAN_WRITE = me.perm === 'write';
        MODE = 'server';
        const doc = await (await fetch('api/state.php')).json();
        serverRev = doc.rev || 0;
        state = normalizeState(doc.state || {});
        renderHeader();
        render();
        return;
      }
    } else if (res.status === 401) {
      MODE = 'login';
      CAN_WRITE = false;
      renderHeader();
      renderLogin();
      return;
    }
  } catch { /* no API: plain static hosting or the dev server */ }
  MODE = 'local';
  state = loadState();
  render();
}

function renderLogin() {
  view.replaceChildren(h('div', { class: 'card', style: 'max-width:420px;margin:60px auto;text-align:center' },
    h('h2', {}, 'Members only'),
    h('div', { class: 'note', style: 'margin-bottom:14px' },
      'Sign in with your Discord account. Officers can edit; raiders get read-only access.'),
    h('a', { class: 'btn', href: 'api/login.php' }, 'Sign in with Discord'),
  ));
}

function renderHeader() {
  const chip = document.getElementById('user-chip');
  const importLabel = document.getElementById('import-label');
  chip.replaceChildren();
  if (MODE === 'server' && USER) {
    chip.append(
      h('span', {}, USER.name), ' ',
      badge(CAN_WRITE ? 'officer' : 'read-only', CAN_WRITE ? 'ok' : 'dim'), ' ',
      h('button', {
        class: 'btn ghost small',
        onclick: async () => {
          try { await fetch('api/logout.php', { method: 'POST', headers: { 'X-Spelltracker': '1' } }); } catch { /* ignore */ }
          location.reload();
        },
      }, 'Logout'),
    );
  }
  importLabel.hidden = !CAN_WRITE;
}

/* ------------------------------------------------------------- data views */

function npcOf(cls) { return classByName[cls]?.npc; }

// Pool entries for a class + item. Pools are per class NPC: a multiclass
// scroll counts as THIS class's spell, at this class's level (guild rule).
function poolFor(cls, item) {
  return DATA.pools[npcOf(cls)]?.[item] ?? null;
}

function turninCount(cls, spell) {
  return state.log.filter(e => e.cls === cls && e.spell === spell).length;
}

// A spell counts as obtained for a class once a turn-in result was logged for it.
function isObtained(cls, spell) {
  return turninCount(cls, spell) > 0;
}

// Union of both turn-in pools for a class (used by the priority picker).
function turninSpells(cls) {
  const out = [];
  for (const item of ITEMS) {
    const pool = poolFor(cls, item);
    if (!pool) continue;
    for (const s of pool.spells) out.push({ ...s, item });
  }
  return out.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------- engine */

/*
 * Phase 1 secures, for EVERY spell of every class's priority list, the
 * number of copies set on that spell (its "want"). Each spell carries an
 * explicit priority TIER (its "prio"); several spells of one class may
 * share a tier and are then secured together in the same round. Round
 * order: TIER is the OUTER axis (a tier is fully served, ALL its copies,
 * before the next tier starts), copy the middle one, class order the
 * inner one:
 *   round 1: 1st copy of every P1 spell of each class (in class order)
 *   round 2: 2nd copy of the P1 spells that want one, and so on
 *   then the P2 spells get their copies the same way, then P3, etc.
 *   (classes with nothing at a tier are skipped, tier gaps allowed)
 * Phase 1 ends ONLY when every listed spell has all its wanted copies; then
 * phase 2 (weighted by mains) takes over.
 */

// Classes that take part in phase 1 (in priority order).
function eligibleClasses() {
  return state.classOrder.filter(c => state.priorities[c].length > 0);
}

// Copies of a spell secured for a class = logged turn-ins that produced it.
function copiesOf(cls, spell) {
  return turninCount(cls, spell);
}

// Current (copy, tier) round, focus class, and classes still pending in it.
// Rounds are numbered over the non-empty (copy, tier) cells only.
function phase1Round() {
  const classes = eligibleClasses();
  if (!classes.length) return { setup: true, done: false };
  const maxTier = Math.max(...classes.flatMap(c => state.priorities[c].map(p => p.prio)));
  const maxWant = Math.max(1, ...classes.flatMap(c => state.priorities[c].map(p => p.want)));
  let current = null;
  let total = 0;
  for (let tier = 1; tier <= maxTier; tier++) {
    for (let copy = 1; copy <= maxWant; copy++) {
      // Classes with at least one spell at this tier wanting this copy.
      const participants = classes.filter(c =>
        state.priorities[c].some(p => p.prio === tier && p.want >= copy));
      if (!participants.length) continue;
      total++;
      if (!current) {
        const pending = participants.filter(c =>
          state.priorities[c].some(p => p.prio === tier && p.want >= copy && copiesOf(c, p.name) < copy));
        if (pending.length) current = { copy, tier, round: total, focus: pending[0], pending };
      }
    }
  }
  if (!current) return { setup: false, done: true };
  return { setup: false, done: false, totalRounds: total, ...current };
}

function phase1Complete() {
  const ri = phase1Round();
  return !ri.setup && ri.done;
}

// Turn-in target for a class at a given tier and copy: the first of its
// tier spells still short of that copy, with the item whose pool produces
// it, plus how many tier spells remain pending this round.
function targetFor(cls, tier, copy) {
  const tierSpells = state.priorities[cls].filter(p => p.prio === tier && p.want >= copy);
  if (!tierSpells.length) return null;
  const pendingSpells = tierSpells.filter(p => copiesOf(cls, p.name) < copy);
  const p = pendingSpells[0] || tierSpells[0];
  const copies = copiesOf(cls, p.name);
  const base = { spell: p.name, prio: p.prio, copies, want: p.want, remaining: pendingSpells.length };
  for (const item of ITEMS) {
    const pool = poolFor(cls, item);
    if (pool && pool.spells.some(s => s.name === p.name)) {
      return { ...base, item, denom: pool.denom };
    }
  }
  // Configured spell that no pool can produce - surfaced as a config error.
  return { ...base, item: null, denom: null };
}

// Wanted copies of a spell: its own want when listed, 1 otherwise.
function wantedCopies(cls, spell) {
  const p = state.priorities[cls].find(x => x.name === spell);
  return p ? Math.max(1, p.want) : 1;
}

/*
 * Cross-class provenance: turn-in POOLS are strictly per class, but the
 * physical scroll of a multiclass spell can be handed to any class that
 * scribes it. These helpers find copies of the same scroll logged at OTHER
 * classes' NPCs, for display only - the engine never counts them (one scroll
 * serves one player; allocation is the quartermaster's call).
 */

// Scroll item behind a (class, spell) pool entry.
function scrollNameOf(cls, spell) {
  for (const item of ITEMS) {
    const entry = poolFor(cls, item)?.spells.find(s => s.name === spell);
    if (entry) return entry.itemName || entry.name;
  }
  return null;
}

// {total, detail} of the same scroll's copies logged at other classes' NPCs.
function crossInfo(cls, spell) {
  const scroll = scrollNameOf(cls, spell);
  if (!scroll) return null;
  const sources = [];
  for (const other of CLASSES) {
    if (other === cls) continue;
    for (const item of ITEMS) {
      const entry = poolFor(other, item)?.spells.find(s => (s.itemName || s.name) === scroll);
      if (entry) {
        const count = turninCount(other, entry.name);
        if (count > 0) sources.push({ cls: other, count });
        break;
      }
    }
  }
  if (!sources.length) return null;
  return {
    total: sources.reduce((s, x) => s + x.count, 0),
    detail: sources.map(x => `${x.count} via ${x.cls} pool`).join(', '),
  };
}

// Number of turn-in spells (Spectral 63-64 + Glyphed 65 pools) for a class.
// Casters have far bigger pools than hybrids, so phase 2 scales the mains
// weight by this: a class with more spells to collect needs more turn-ins.
function poolSize(cls) {
  return ITEMS.reduce((s, item) => s + (poolFor(cls, item)?.denom || 0), 0);
}

// Mains weight of a class: M1 count plus M2 count scaled by the M2 ratio.
function effectiveMains(cls) {
  return (state.weights[cls] || 0) + state.m2Ratio * (state.weights2[cls] || 0);
}

// Phase 2: fair-share distribution of turn-ins, weighted by mains x pool size.
function phase2Recs() {
  const weightOf = c => effectiveMains(c) * poolSize(c);
  const totalWeight = CLASSES.reduce((s, c) => s + weightOf(c), 0);
  if (!totalWeight) return { recs: [], totalWeight: 0 };
  const totalDone = state.log.length;
  const recs = CLASSES
    .filter(c => weightOf(c) > 0)
    .map(cls => {
      const share = weightOf(cls) / totalWeight;
      const done = state.log.filter(e => e.cls === cls).length;
      // Deficit: how far behind its fair share this class is if we do one more turn-in.
      const deficit = share * (totalDone + 1) - done;
      const missing = {};
      for (const item of ITEMS) {
        const pool = poolFor(cls, item);
        missing[item] = pool ? pool.spells.filter(s => !isObtained(cls, s.name)).length : 0;
      }
      return {
        cls, npc: npcOf(cls), mains: state.weights[cls], mains2: state.weights2[cls],
        pool: poolSize(cls), share, done, deficit, missing,
      };
    })
    .sort((a, b) => b.deficit - a.deficit);
  return { recs, totalWeight, totalDone };
}

/* ------------------------------------------------------------- dom utils */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    el.append(child.nodeType ? child : document.createTextNode(child));
  }
  return el;
}

function badge(text, kind, title) { return h('span', { class: `badge ${kind}`, title: title || null }, text); }

/* --------------------------------------------------- NPC map tooltips */

// Floating minimap shown when hovering a turn-in NPC's name. Map data
// (window.POK_MAP) is pre-transformed to map space at generation time.
const mapTipEl = h('div', { class: 'map-tip', hidden: '' });
document.body.append(mapTipEl);
const npcSvgCache = new Map();

function npcMapSvg(npc) {
  if (npcSvgCache.has(npc)) return npcSvgCache.get(npc).cloneNode(true);
  const m = window.POK_MAP;
  const spot = m?.npcs?.[npc];
  if (!m || !spot) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const pad = 40;
  const [minX, minY, maxX, maxY] = m.bounds;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
  svg.setAttribute('width', '250');
  svg.setAttribute('height', '250');
  for (const p of m.paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', p.c);
    path.setAttribute('stroke-width', String(m.stroke || 6));
    svg.append(path);
  }
  for (const l of m.labels || []) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(l.x));
    t.setAttribute('y', String(l.y));
    t.setAttribute('class', 'map-label');
    t.setAttribute('font-size', String((m.stroke || 6) * 6));
    t.setAttribute('text-anchor', 'middle');
    t.textContent = l.t;
    svg.append(t);
  }
  const halo = document.createElementNS(NS, 'circle');
  halo.setAttribute('cx', String(spot.x));
  halo.setAttribute('cy', String(spot.y));
  halo.setAttribute('r', String((m.stroke || 6) * 9));
  halo.setAttribute('class', 'map-marker-halo');
  svg.append(halo);
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', String(spot.x));
  dot.setAttribute('cy', String(spot.y));
  dot.setAttribute('r', String((m.stroke || 6) * 3.5));
  dot.setAttribute('class', 'map-marker');
  svg.append(dot);
  npcSvgCache.set(npc, svg);
  return svg.cloneNode(true);
}

function showNpcMap(npc, anchor) {
  const svg = npcMapSvg(npc);
  const hint = window.POK_MAP?.npcs?.[npc]?.hint;
  mapTipEl.replaceChildren(
    svg || h('div', { class: 'note' }, 'Plane of Knowledge'),
    h('div', { class: 'map-tip-caption' }, hint ? `${npc}: ${hint}` : `${npc} (Plane of Knowledge)`),
  );
  mapTipEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const tip = mapTipEl.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - tip.width - 12);
  let y = r.bottom + 8;
  if (y + tip.height > window.innerHeight - 8) y = Math.max(8, r.top - tip.height - 8);
  mapTipEl.style.left = `${Math.max(8, x)}px`;
  mapTipEl.style.top = `${y}px`;
}

function hideNpcMap() { mapTipEl.hidden = true; }

// NPC name element with the minimap tooltip attached.
function npcEl(npc) {
  if (!npc) return null;
  return h('span', {
    class: 'npc-name',
    onmouseenter: e => showNpcMap(npc, e.currentTarget),
    onmouseleave: hideNpcMap,
  }, npc);
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = h('div', { class: 'toast' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

function fmtPct(x) { return `${Math.round(x * 100)}%`; }

function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* -------------------------------------------------------------- rendering */

const view = document.getElementById('view');

function render() {
  view.replaceChildren();
  const renderers = {
    dashboard: renderDashboard,
    priorities: renderPriorities,
    weights: renderWeights,
    pools: renderPools,
    log: renderLog,
  };
  renderers[activeTab]();
  // Read-only accounts see everything but can touch nothing.
  if (!CAN_WRITE) {
    view.querySelectorAll('input, select, button').forEach(el => { el.disabled = true; });
  }
}

/* ---- dashboard ---- */

function renderDashboard() {
  // With no priorities configured at all, phase 1 is vacuously "complete";
  // treat that as setup instead of jumping straight to phase 2.
  const anyPrio = CLASSES.some(c => state.priorities[c].length > 0);
  const p1done = phase1Complete() && anyPrio;

  // Inventory + phase overview row.
  const invCards = ITEMS.map(item => {
    const input = h('input', {
      type: 'number', min: '0', value: state.inventory[item],
      onchange: e => { state.inventory[item] = Math.max(0, Number(e.target.value) || 0); commit(); },
    });
    return h('div', { class: `card inv-card ${ITEM_CSS[item]}` },
      h('div', { class: 'inv-name' }, item),
      h('div', { class: 'inv-controls' },
        h('button', { onclick: () => { state.inventory[item] = Math.max(0, state.inventory[item] - 1); commit(); } }, '−'),
        input,
        h('button', { onclick: () => { state.inventory[item]++; commit(); } }, '+'),
      ),
    );
  });

  const ri = phase1Round();
  // Progress: secured copies over all planned copies (sum of per-spell wants).
  const cells = eligibleClasses().reduce((a, c) => {
    for (const p of state.priorities[c]) {
      a.done += Math.min(copiesOf(c, p.name), p.want);
      a.total += p.want;
    }
    return a;
  }, { done: 0, total: 0 });
  const phaseCard = h('div', { class: 'card phase-card' },
    h('div', { class: 'phase-name' },
      !anyPrio ? 'Setup: define priorities'
        : p1done ? 'Phase 2: weighted by mains'
        : `Phase 1: round ${ri.round}/${ri.totalRounds}`),
    h('div', { class: 'phase-desc' },
      !anyPrio
        ? 'No priorities yet. Set them in the Priorities tab (see ? for the rules).'
        : p1done
          ? 'Every priority spell has all its wanted copies. Distributing by mains x pool size.'
          : `Copy ${ri.copy} of the P${ri.tier} spells of each class. Focus: ${ri.focus}. ${cells.done}/${cells.total} copies secured.`,
    ),
    anyPrio ? h('div', { class: 'progress-track' },
      h('div', { class: 'progress-fill', style: `width:${cells.total ? (cells.done / cells.total) * 100 : 0}%` })) : null,
  );

  const statsCard = h('div', { class: 'card' },
    h('h2', {}, 'At a glance'),
    h('table', {},
      h('tbody', {},
        h('tr', {}, h('td', {}, 'Turn-ins recorded'), h('td', { class: 'num' }, String(state.log.length))),
        h('tr', {}, h('td', {}, 'Priority copies secured'), h('td', { class: 'num' }, `${cells.done} / ${cells.total}`)),
        h('tr', {}, h('td', {}, 'Surplus copies to roll'), h('td', { class: 'num' }, String(state.log.filter(isDupe).length))),
      ),
    ),
  );

  view.append(h('div', { class: 'grid cols-4' }, ...invCards, phaseCard, statsCard));

  // Recommendations.
  const recCard = h('div', { class: 'card', style: 'margin-top:14px' });
  if (!p1done) {
    recCard.append(h('h2', {}, ri.setup ? 'Phase 1 queue ' : `Round ${ri.round}: P${ri.tier} spells, copy ${ri.copy} `,
      h('span', { class: 'hint' }, 'click a row to pre-fill the record form')));
    if (ri.setup) {
      recCard.append(h('div', { class: 'empty' },
        'Define priority spells per class in the Priorities tab to get the turn-in queue.'));
    } else {
      recCard.append(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, 'Class'), h('th', {}, 'NPC'), h('th', {}, 'Wanted spell'),
          h('th', {}, 'Item to hand in'), h('th', { class: 'num' }, 'Odds / turn-in'), h('th', {}, 'Stock'), h('th', {}, ''))),
        h('tbody', {}, ri.pending.map((cls, i) => {
          const t = targetFor(cls, ri.tier, ri.copy);
          if (!t) return null;
          const ci = crossInfo(cls, t.spell);
          return h('tr', { class: 'clickable', onclick: () => { record = { item: t.item, cls }; commitTransient(); } },
            h('td', {}, String(i + 1)),
            h('td', {}, cls),
            h('td', {}, npcEl(npcOf(cls))),
            h('td', {}, badge(`P${t.prio}`, 'prio'), ' ', t.spell, ' ',
              badge(`copy ${ri.copy}/${t.want}`, 'dim'),
              t.remaining > 1 ? [' ', badge(`+${t.remaining - 1} more P${t.prio}`, 'dim')] : null,
              ci ? [' ', badge(`${ci.total} dropped elsewhere`, 'warn', `${ci.detail}. The scroll can be handed to this class; if allocated, lower this spell's wanted copies`)] : null),
            h('td', {}, t.item ? badge(ITEM_SHORT[t.item], ITEM_CSS[t.item]) : badge('not in pools!', 'bad')),
            h('td', { class: 'num' }, t.denom ? h('span', { class: 'pct' }, `1/${t.denom}`) : '-'),
            h('td', {}, t.item ? (state.inventory[t.item] > 0 ? badge('in stock', 'ok') : badge('out of stock', 'bad')) : ''),
            h('td', {}, i === 0 ? badge('FOCUS', 'warn') : null),
          );
        })),
      ));
    }
  } else {
    recCard.append(h('h2', {}, 'Next turn-ins: weighted by mains x pool size ',
      h('span', { class: 'hint' }, 'click a row to pre-fill the record form')));
    const { recs, totalWeight } = phase2Recs();
    if (!totalWeight) {
      recCard.append(h('div', { class: 'empty' }, 'Phase 1 complete. Set mains (M1) counts in the Class Weights tab to drive phase 2.'));
    } else {
      recCard.append(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, 'Class'), h('th', { class: 'num' }, 'Mains M1+M2'), h('th', { class: 'num' }, 'Pool 63-65'),
          h('th', { class: 'num' }, 'Fair share'), h('th', { class: 'num' }, 'Done'), h('th', { class: 'num' }, 'Deficit'),
          h('th', {}, 'Missing spells (Spec / Glyph)'))),
        h('tbody', {}, recs.map((r, i) =>
          h('tr', { class: 'clickable', onclick: () => { record = { item: null, cls: r.cls }; commitTransient(); } },
            h('td', {}, String(i + 1)),
            h('td', {}, r.cls),
            h('td', { class: 'num', title: `M1: ${r.mains}, M2: ${r.mains2} (ratio ${Math.round(state.m2Ratio * 100)}%)` },
              r.mains2 ? `${r.mains}+${r.mains2}` : String(r.mains)),
            h('td', { class: 'num' }, String(r.pool)),
            h('td', { class: 'num' }, fmtPct(r.share)),
            h('td', { class: 'num' }, String(r.done)),
            h('td', { class: 'num' }, r.deficit.toFixed(2)),
            h('td', {},
              badge(`${r.missing['Spectral Parchment']}`, 'spectral'), ' ',
              badge(`${r.missing['Glyphed Rune Word']}`, 'glyphed')),
          ))),
      ));
    }
  }
  view.append(recCard);

  // Record turn-in flow.
  view.append(renderRecordCard());

  // Recent activity.
  const recent = [...state.log].sort((a, b) => b.ts - a.ts).slice(0, 6);
  const logCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('h2', {}, 'Recent turn-ins'),
    recent.length
      ? h('table', {}, h('tbody', {}, recent.map(e =>
          h('tr', {},
            h('td', {}, fmtDate(e.ts)),
            h('td', {}, badge(ITEM_SHORT[e.item], ITEM_CSS[e.item])),
            h('td', {}, e.cls),
            h('td', {}, e.spell),
            h('td', {}, isDupe(e) ? badge('duplicate, roll it', 'warn') : badge('new', 'ok')),
          ))))
      : h('div', { class: 'empty' }, 'No turn-ins recorded yet.'),
  );
  view.append(logCard);
}

// Re-render while keeping the transient record selection.
function commitTransient() { render(); document.getElementById('record-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

function renderRecordCard() {
  // An empty stock cannot be turned in - drop a stale selection.
  if (record.item && state.inventory[record.item] <= 0) record = { ...record, item: null };

  const card = h('div', { class: 'card record-flow', id: 'record-card', style: 'margin-top:14px' });
  card.append(h('h2', {}, 'Record a turn-in ', h('span', { class: 'hint' }, 'item → class → spell received')));

  // Step 1: item (disabled while out of stock).
  card.append(h('div', { class: 'choice-row' }, ITEMS.map(item =>
    h('button', {
      class: `chip ${ITEM_CSS[item]} ${record.item === item ? 'selected' : ''}`,
      ...(state.inventory[item] <= 0 ? { disabled: '' } : {}),
      onclick: () => { record.item = record.item === item ? null : item; render(); },
    }, `${item} (${state.inventory[item]} in stock)`),
  )));

  // Step 2: class.
  if (record.item) {
    card.append(h('div', { class: 'choice-row' }, CLASSES.map(cls =>
      h('button', {
        class: `chip ${record.cls === cls ? 'selected' : ''}`,
        onclick: () => { record.cls = record.cls === cls ? null : cls; render(); },
      }, cls),
    )));
  }

  // Step 3: resulting spell.
  if (record.item && record.cls) {
    const pool = poolFor(record.cls, record.item);
    if (!pool) {
      card.append(h('div', { class: 'empty' }, `No ${record.item} pool for ${record.cls}.`));
    } else {
      card.append(h('div', { class: 'note' },
        npcEl(npcOf(record.cls)),
        `: pool of ${pool.denom}, each spell 1/${pool.denom}. Click the spell you received:`));
      card.append(h('div', { class: 'spell-buttons' }, pool.spells.map(s => {
        const rank = state.priorities[record.cls].findIndex(p => p.name === s.name) + 1;
        const copies = copiesOf(record.cls, s.name);
        const wanted = wantedCopies(record.cls, s.name);
        const ci = crossInfo(record.cls, s.name);
        return h('button', {
          class: 'spell-btn',
          title: ci ? `Same scroll already dropped: ${ci.detail}` : null,
          onclick: () => recordTurnin(record.item, record.cls, s.name),
        },
          h('span', {}, s.name, ' ', h('span', { class: 'lvl' }, s.level ? `L${s.level}` : '')),
          h('span', {},
            rank ? badge(`P${rank} · ${Math.min(copies, wanted)}/${wanted}`, copies >= wanted ? 'ok' : 'prio') : null,
            !rank && copies ? badge('dupe', 'warn') : null,
            ci ? badge(`+${ci.total}`, 'warn', ci.detail) : null),
        );
      })));
    }
  }
  return card;
}

function recordTurnin(item, cls, spell) {
  if (!CAN_WRITE) { toast('Read-only access.'); return; }
  // A turn-in consumes an item: recording with an empty stock is refused.
  if (state.inventory[item] <= 0) { toast(`No ${item} in stock.`); return; }
  state.log.push({ id: crypto.randomUUID(), ts: Date.now(), item, cls, spell, consumed: true });
  const copies = copiesOf(cls, spell);
  const wanted = wantedCopies(cls, spell);
  state.inventory[item]--;
  record = { item, cls: null }; // keep the item selected for batch turn-in sessions
  commit();
  toast(copies > wanted
    ? `${spell} recorded: surplus copy (${copies}/${wanted}), roll it in raid/Discord.`
    : state.priorities[cls].some(p => p.name === spell)
      ? `${spell} recorded: copy ${copies}/${wanted} secured for ${cls}.`
      : `${spell} recorded for ${cls}.`);
}

// A log entry is surplus ("to roll") once the spell exceeds its wanted copies:
// the spell's own want for listed priority spells, 1 for anything else.
function isDupe(entry) {
  const before = state.log.filter(e => e.cls === entry.cls && e.spell === entry.spell && e.ts < entry.ts).length;
  return before + 1 > wantedCopies(entry.cls, entry.spell);
}

/* ---- priorities ---- */

function renderPriorities() {
  view.append(h('div', { class: 'note', style: 'margin-bottom:12px' },
    'Phase 1 class order: drag a card or type its rank. Per spell: the P number is its priority tier ',
    '(same tier = secured together in the same round; force it with the arrows), the count is the copies wanted.'));

  const cards = state.classOrder.map((cls, orderIdx) => {
    const prio = state.priorities[cls];
    const available = turninSpells(cls).filter(s => !prio.some(p => p.name === s.name));
    const secured = prio.reduce((s, p) => s + Math.min(copiesOf(cls, p.name), p.want), 0);
    const planned = prio.reduce((s, p) => s + p.want, 0);

    // Display grouped by tier (stable sort keeps the in-tier order).
    const rows = prio.map((p, idx) => ({ p, idx })).sort((a, b) => a.p.prio - b.p.prio);
    const list = h('ol', { class: 'prio-list' }, rows.map(({ p, idx }) => {
      const spellInfo = turninSpells(cls).find(s => s.name === p.name);
      const copies = copiesOf(cls, p.name);
      const ci = copies < p.want ? crossInfo(cls, p.name) : null;
      // Rows are dragged by their handle only, so the want input stays usable.
      const li = h('li', {
        ondragstart: e => {
          dragCtx = { type: 'spell', cls, index: idx };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.name);
          li.classList.add('dragging');
        },
        ondragend: () => { li.classList.remove('dragging'); li.draggable = false; dragCtx = null; },
        ondragover: e => {
          if (dragCtx?.type !== 'spell' || dragCtx.cls !== cls) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          li.classList.add('drag-over');
        },
        ondragleave: () => li.classList.remove('drag-over'),
        ondrop: e => {
          e.preventDefault();
          if (dragCtx?.type !== 'spell' || dragCtx.cls !== cls) return;
          dropPrioEntry(cls, dragCtx.index, idx);
          dragCtx = null;
        },
      },
        h('span', { class: 'drag-handle', title: 'Drag onto a row to join its priority tier', onmousedown: () => { if (CAN_WRITE) li.draggable = true; } }, '⋮⋮'),
        h('span', { class: 'prio-ctl' },
          h('button', { class: 'prio-arrow', title: 'Higher priority', onclick: () => bumpPrio(cls, idx, -1) }, '▲'),
          h('span', { class: 'prio-num' }, `P${p.prio}`),
          h('button', { class: 'prio-arrow', title: 'Lower priority', onclick: () => bumpPrio(cls, idx, +1) }, '▼'),
        ),
        h('span', { class: `name ${copies >= p.want ? 'obtained' : ''}` },
          p.name, ' ',
          spellInfo ? badge(ITEM_SHORT[spellInfo.item], ITEM_CSS[spellInfo.item]) : badge('not in pools', 'bad'),
          ' ', badge(`${Math.min(copies, p.want)}/${p.want}`, copies >= p.want ? 'ok' : 'dim'),
          ci ? [' ', badge(`+${ci.total} elsewhere`, 'warn', ci.detail)] : null),
        h('input', {
          class: 'want-input', type: 'number', min: '1', value: p.want,
          title: 'Copies wanted during phase 1',
          onchange: e => { p.want = Math.max(1, Math.round(Number(e.target.value) || 1)); commit(); },
        }),
        h('button', { class: 'mini', title: 'Remove', onclick: () => { prio.splice(idx, 1); commit(); } }, '✕'),
      );
      return li;
    }));

    const select = h('select', {},
      h('option', { value: '' }, 'add a spell...'),
      available.map(s => h('option', { value: s.name }, `${s.name} (L${s.level}, ${ITEM_SHORT[s.item]})`)));
    select.addEventListener('change', () => {
      if (select.value) {
        // New spells land on a fresh tier below the existing ones.
        prio.push({ name: select.value, want: 1, prio: Math.max(0, ...prio.map(p => p.prio)) + 1 });
        commit();
      }
    });

    // The whole card is a drag tile: dragging is armed by a mousedown on the
    // header, so inner inputs, selects and spell-row drags stay usable.
    const card = h('div', {
      class: 'card class-card',
      ondragstart: e => {
        if (dragCtx) return; // a spell-row drag is already in flight
        dragCtx = { type: 'classCard', index: orderIdx };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cls);
        card.classList.add('dragging');
      },
      ondragend: () => { card.classList.remove('dragging'); card.draggable = false; dragCtx = null; },
      ondragover: e => {
        if (dragCtx?.type !== 'classCard') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
      },
      ondragleave: () => card.classList.remove('drag-over'),
      ondrop: e => {
        if (dragCtx?.type !== 'classCard') return;
        e.preventDefault();
        moveItem(state.classOrder, dragCtx.index, orderIdx);
        dragCtx = null;
      },
    },
      h('div', { class: 'class-head' },
        h('span', { class: 'card-grip', title: 'Drag to reorder classes' }, '⠿'),
        h('input', {
          class: 'order-input', type: 'number', min: '1', max: String(state.classOrder.length),
          value: orderIdx + 1, title: 'Class priority rank: type a number or drag the card',
          onmousedown: e => e.stopPropagation(),
          onchange: e => {
            const pos = Math.min(state.classOrder.length, Math.max(1, Math.round(Number(e.target.value) || (orderIdx + 1))));
            moveItem(state.classOrder, orderIdx, pos - 1);
            render(); // moveItem skips render when the position is unchanged
          },
        }),
        h('h3', {}, cls, ' ',
          !prio.length ? badge('no priorities', 'dim')
            : secured >= planned ? badge('phase 1 done', 'ok')
            : badge(`${secured}/${planned} copies`, 'warn')),
      ),
      h('div', { class: 'npc' }, 'NPC: ', npcEl(npcOf(cls))),
      prio.length ? list : h('div', { class: 'empty', style: 'margin-bottom:10px' }, 'No priorities set.'),
      h('div', { class: 'add-row' }, select),
    );
    // Arm dragging from anywhere on the card EXCEPT its interactive parts
    // (inputs, selects, buttons, and spell rows, which drag on their own).
    card.addEventListener('mousedown', e => {
      if (!CAN_WRITE) return;
      if (e.target.closest('input, select, button, .prio-list li')) return;
      card.draggable = true;
    });
    card.addEventListener('mouseup', () => { card.draggable = false; });
    return card;
  });

  view.append(h('div', { class: 'grid cols-3' }, cards));
}

// In-flight drag payload for the priority tiles ({type, index, cls?}).
let dragCtx = null;

// Force a spell's priority tier with the arrow buttons (lower = sooner).
function bumpPrio(cls, idx, delta) {
  if (!CAN_WRITE) return;
  const p = state.priorities[cls][idx];
  if (!p) return;
  p.prio = Math.max(1, p.prio + delta);
  commit();
}

// Drag & drop between priority rows: the dragged spell joins the target
// row's tier and is placed just before it.
function dropPrioEntry(cls, fromIdx, toIdx) {
  if (!CAN_WRITE) return;
  const arr = state.priorities[cls];
  const moved = arr[fromIdx];
  const target = arr[toIdx];
  if (!moved || !target || moved === target) return;
  moved.prio = target.prio;
  arr.splice(fromIdx, 1);
  arr.splice(arr.indexOf(target), 0, moved);
  commit();
}

// Move an array element from one position to another (drag & drop reorder).
function moveItem(arr, from, to) {
  if (!CAN_WRITE) return;
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  commit();
}

/* ---- weights ---- */

function renderWeights() {
  const weightOf = c => effectiveMains(c) * poolSize(c);
  const totalWeight = CLASSES.reduce((s, c) => s + weightOf(c), 0);
  const totalDone = state.log.length;

  const rows = CLASSES.map(cls => {
    const share = totalWeight ? weightOf(cls) / totalWeight : 0;
    const done = state.log.filter(e => e.cls === cls).length;
    const actual = totalDone ? done / totalDone : 0;
    const mainsInput = key => h('input', {
      class: 'weight-input', type: 'number', min: '0', value: state[key][cls] || 0,
      onchange: e => { state[key][cls] = Math.max(0, Number(e.target.value) || 0); commit(); },
    });
    return h('tr', {},
      h('td', {}, cls),
      h('td', {}, mainsInput('weights')),
      h('td', {}, mainsInput('weights2')),
      h('td', { class: 'num' }, String(poolSize(cls))),
      h('td', { class: 'num' }, totalWeight ? fmtPct(share) : '-'),
      h('td', { class: 'num' }, String(done)),
      h('td', { class: 'num' }, totalDone ? fmtPct(actual) : '-'),
      h('td', {}, totalWeight
        ? (share === 0 ? badge('excluded', 'dim')
          : actual <= share ? badge('behind, feed next', 'warn') : badge('ahead', 'ok'))
        : badge('set weights', 'dim')),
    );
  });

  view.append(h('div', { class: 'card' },
    h('h2', {}, 'Mains per class ',
      h('span', { class: 'hint' }, 'phase 2 fair share = (M1 + ratio × M2) × pool size')),
    h('div', { class: 'rules-row', style: 'margin-bottom:10px' },
      'M2 weight ratio: ',
      h('input', {
        type: 'number', min: '0', max: '100', step: '5', value: Math.round(state.m2Ratio * 100),
        onchange: e => {
          state.m2Ratio = Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100;
          commit();
        },
      }),
      '%: an M2 main counts as this fraction of an M1.'),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Class'), h('th', {}, 'Mains (M1)'), h('th', {}, 'Mains (M2)'), h('th', { class: 'num' }, 'Pool 63-65'),
        h('th', { class: 'num' }, 'Fair share'), h('th', { class: 'num' }, 'Turn-ins done'),
        h('th', { class: 'num' }, 'Actual share'), h('th', {}, 'Status'))),
      h('tbody', {}, rows)),
  ));
}

/* ---- pools ---- */

function renderPools() {
  const cards = CLASSES.map(cls => {
    const sections = ITEMS.map(item => {
      const pool = poolFor(cls, item);
      if (!pool) return null;
      return h('div', { style: 'margin-bottom:10px' },
        h('div', { style: 'margin:8px 0 6px' },
          badge(ITEM_SHORT[item], ITEM_CSS[item]), ' ',
          h('span', { class: 'note' }, `pool of ${pool.denom}, 1/${pool.denom} each`)),
        h('table', {}, h('tbody', {}, pool.spells.map(s => {
          const rank = state.priorities[cls].findIndex(p => p.name === s.name) + 1;
          const turns = turninCount(cls, s.name);
          const ci = crossInfo(cls, s.name);
          return h('tr', {},
            h('td', {}, s.name),
            h('td', { class: 'num' }, s.level ? `L${s.level}` : ''),
            h('td', {}, rank ? badge(`P${rank}`, 'prio') : null),
            h('td', {},
              turns ? badge(turns > 1 ? `obtained ×${turns}` : 'obtained', 'ok', ci ? `Also ${ci.detail}` : null)
                : ci ? badge('obtained*', 'warn', ci.detail)
                : badge('missing', 'dim')),
          );
        }))),
      );
    });
    return h('div', { class: 'card class-card' },
      h('h3', {}, cls),
      h('div', { class: 'npc' }, 'NPC: ', npcEl(npcOf(cls)), ' (Plane of Knowledge)'),
      sections);
  });
  view.append(h('div', { class: 'grid cols-2' }, cards));
}

/* ---- log ---- */

function renderLog() {
  const entries = [...state.log].sort((a, b) => b.ts - a.ts);
  view.append(h('div', { class: 'card' },
    h('h2', {}, `Turn-in log (${entries.length})`),
    entries.length
      ? h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Date'), h('th', {}, 'Item'), h('th', {}, 'Class'), h('th', {}, 'Spell'),
            h('th', {}, 'Result'), h('th', {}, ''))),
          h('tbody', {}, entries.map(e =>
            h('tr', {},
              h('td', {}, fmtDate(e.ts)),
              h('td', {}, badge(ITEM_SHORT[e.item], ITEM_CSS[e.item])),
              h('td', {}, e.cls),
              h('td', {}, e.spell),
              h('td', {}, isDupe(e) ? badge('duplicate, roll it', 'warn') : badge('new', 'ok')),
              h('td', {}, h('button', {
                class: 'btn ghost small',
                onclick: () => {
                  state.log = state.log.filter(x => x.id !== e.id);
                  // Refund the item only if the record consumed one (legacy
                  // entries without the flag are treated as consuming).
                  if (e.consumed !== false) state.inventory[e.item]++;
                  commit();
                },
              }, 'Undo')),
            ))))
      : h('div', { class: 'empty' }, 'No turn-ins recorded yet.'),
  ));
}

/* -------------------------------------------------------- import / export */

function exportState() {
  const slug = (GUILD_NAME || 'guild').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guild';
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug}-spells-state.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}

function importStateFile(file) {
  if (!CAN_WRITE) { toast('Read-only access.'); return; }
  file.text().then(text => {
    // Same normalization as loadState, so legacy or seed-lagging files
    // cannot install a state that crashes render().
    state = normalizeState(JSON.parse(text));
    commit();
    toast('State imported.');
  }).catch(() => toast('Could not read that state file.'));
}

/* ----------------------------------------------------------------- wiring */

document.getElementById('tabs').addEventListener('click', e => {
  if (MODE === 'login') return;
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

document.getElementById('export-state').addEventListener('click', exportState);
const helpDialog = document.getElementById('help-dialog');
document.getElementById('help-btn').addEventListener('click', () => helpDialog.showModal());
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());
document.getElementById('state-input').addEventListener('change', e => {
  if (e.target.files[0]) importStateFile(e.target.files[0]);
  e.target.value = '';
});

boot();
