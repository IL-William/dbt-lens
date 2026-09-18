/* Lineage canvas: layered layout + hand-rolled SVG renderer.
   No graph library: a Sugiyama-style column layout with a barycenter sweep to
   keep edge crossings down is enough for the sub-graphs we display. */
const Lineage = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const HGAP = 80, VGAP = 14;
  // Re-assigned per mode in render(): column boxes are smaller than model boxes.
  let W = 200, H = 48;
  /* Colour carries the materialization, which is what you actually reason about
     when reading a DAG: what exists in the warehouse, and what gets rebuilt. */
  const MAT = {
    view: '#4da3ff',
    table: '#4ec78d',
    incremental: '#e0a34b',
    ephemeral: '#6f7d90',
    materialized_view: '#3fc7c7',
    dynamic_table: '#3fc7c7',
  };
  const KIND = {
    source: '#b98cf0', seed: '#56b98b', snapshot: '#ef7a9b',
    test: '#7a879a', exposure: '#ef7a9b', other: '#7a879a',
  };
  /* Anything else is a custom materialization, and deserves to be noticed. */
  const CUSTOM = '#ff6ec7';

  /* Column mode colours the edge rather than the box. Where a column is stored
     is not what you are reading that graph for: what happened to it between two
     models is.

     Its own palette, sharing no colour with the materializations: in column mode
     the boxes still carry the owning model's materialization, so both channels
     are on screen at once and a shared colour would read as a relationship that
     is not there. The ramp runs quiet to loud, because that is the order you
     care about: a passthrough is not news, a transform is. `inferred` is the
     dullest of all, being the one the producer did not read out of the SQL. */
  const ROLE = {
    passthrough: '#c3ccd6',
    rename: '#9fb0c4',
    cast: '#c9b08a',
    aggregate: '#cf7a3f',
    window: '#8b46c9',
    transform: '#d94f4f',
    inferred: '#5f6a78',
    /* Not an edge kind: the badge a column with no incoming edge in view gets.
       That column is where the graph starts, which is raw rather than unknown. */
    raw: '#7fb069',
  };
  /* The plain edge colour, also used for a role this build does not know: a
     cache from another producer may use words that did not exist when this
     shipped, and a wrong hue would claim more than a neutral one. */
  const EDGE_PLAIN = '#33445c';

  function roleColor(kind) {
    return ROLE[String(kind || '').toLowerCase()] || EDGE_PLAIN;
  }

  /* What produced each column, read off its incoming edges, so the badge sits on
     the thing it describes instead of making you trace a line back.

     A column fed by several edges of different roles is `mixed`, which has no
     colour of its own on purpose: it falls back to the neutral, because naming
     one of the roles would be picking a winner at random. A column with nothing
     feeding it inside the current view is where the graph starts, and that is
     `raw` rather than unknown. */
  function nodeRoles(d) {
    const found = d.nodes.map(() => '');
    (d.edges || []).forEach(([, to], i) => {
      const kind = (d.edge_kinds && d.edge_kinds[i]) || '';
      if (!kind) return;
      found[to] = !found[to] ? kind : (found[to] === kind ? kind : 'mixed');
    });
    return found.map((role, i) => role || (d.nodes[i].hidden_up ? '' : 'raw'));
  }

  function nodeColor(n) {
    if (n.kind && n.kind !== 'model') return KIND[n.kind] || KIND.other;
    const m = (n.materialized || '').toLowerCase();
    if (!m) return KIND.other;
    return MAT[m] || CUSTOM;
  }

  function matLabel(n) {
    if (n.kind && n.kind !== 'model') return n.kind;
    return (n.materialized || 'unknown').toLowerCase();
  }

  let svg, root, handlers = {}, data = null, place = [], bbox = null;
  let view = { k: 1, x: 0, y: 0 }, selected = null;
  // Module scope, not init's: render() reads it to keep a hover card from
  // opening under a pointer that is in the middle of a pan.
  let drag = null;

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const clip = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  /* Second line of a node box. Column mode ships a ready-made `sub`; model mode
     builds one from the materialization, schema and test count.
     `tests` is a count in a lineage node and a list in an /api/node payload, and
     the hover card feeds it the second: counting here rather than at each call
     site keeps "[object Object]" out of the line. */
  function subtitle(n) {
    if (n.sub) return n.sub;
    const bits = [n.disabled ? 'disabled' : n.kind === 'source' ? 'source' : (n.materialized || n.kind)];
    if (n.schema) bits.push(n.schema);
    const tests = Array.isArray(n.tests) ? n.tests.length : n.tests;
    if (tests) bits.push(`${tests} test${tests > 1 ? 's' : ''}`);
    return bits.join('  ·  ');
  }

  function init(svgEl, h) {
    svg = svgEl; handlers = h || {};
    root = el('g');
    svg.appendChild(root);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(3, Math.max(0.08, view.k * f));
      view.x = mx - (mx - view.x) * (k / view.k);
      view.y = my - (my - view.y) * (k / view.k);
      view.k = k;
      apply();
    }, { passive: false });

    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      svg.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      apply();
    });
    window.addEventListener('mouseup', () => { drag = null; svg.classList.remove('panning'); });
    svg.addEventListener('dblclick', (e) => { if (e.target === svg) fit(); });
  }

  /* The one place a pan, a wheel zoom and fit() all pass through, so closing the
     hover card here covers every way the boxes can move out from under it.
     onHoverClose, not onHoverOut: a pan fires this on every mousemove, and the
     grace period onHoverOut grants would just keep being restarted. */
  const apply = () => {
    root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    handlers.onHoverClose && handlers.onHoverClose();
  };

  /* Column layout with a few barycenter sweeps. */
  function layout(d) {
    const cols = new Map();
    d.nodes.forEach((n, i) => {
      if (!cols.has(n.depth)) cols.set(n.depth, []);
      cols.get(n.depth).push(i);
    });
    const depths = [...cols.keys()].sort((a, b) => a - b);
    const par = d.nodes.map(() => []), chi = d.nodes.map(() => []);
    d.edges.forEach(([a, b]) => { chi[a].push(b); par[b].push(a); });

    const row = new Array(d.nodes.length).fill(0);
    for (const dep of depths) {
      const arr = cols.get(dep);
      arr.sort((a, b) => d.nodes[a].name.localeCompare(d.nodes[b].name));
      arr.forEach((n, i) => { row[n] = i; });
    }
    for (let pass = 0; pass < 8; pass++) {
      const order = pass % 2 === 0 ? depths : [...depths].reverse();
      const side = pass % 2 === 0 ? par : chi;
      for (const dep of order) {
        const arr = cols.get(dep);
        const key = new Map(arr.map((n) => {
          const nb = side[n];
          const k = nb.length ? nb.reduce((s, x) => s + row[x], 0) / nb.length : row[n];
          return [n, k];
        }));
        arr.sort((a, b) => key.get(a) - key.get(b) || d.nodes[a].name.localeCompare(d.nodes[b].name));
        arr.forEach((n, i) => { row[n] = i; });
      }
    }

    const p = new Array(d.nodes.length);
    depths.forEach((dep, ci) => {
      const arr = cols.get(dep);
      const total = arr.length * (H + VGAP) - VGAP;
      arr.forEach((n, i) => { p[n] = { x: ci * (W + HGAP), y: -total / 2 + i * (H + VGAP) }; });
    });
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    bbox = {
      x0: Math.min(...xs), x1: Math.max(...xs) + W,
      y0: Math.min(...ys), y1: Math.max(...ys) + H,
    };
    return p;
  }

  function render(d) {
    data = d;
    const columnMode = d.mode === 'column';
    W = columnMode ? 180 : 200;
    H = columnMode ? 40 : 48;
    selected = d.nodes[d.focus] ? d.nodes[d.focus].id : null;
    // Column mode only: in model mode the box colour already carries the answer.
    const roles = columnMode ? nodeRoles(d) : [];
    place = layout(d);
    root.textContent = '';

    const edgeLayer = el('g'), nodeLayer = el('g');
    root.appendChild(edgeLayer); root.appendChild(nodeLayer);

    d.edges.forEach(([a, b], i) => {
      const p1 = place[a], p2 = place[b];
      const x1 = p1.x + W, y1 = p1.y + H / 2, x2 = p2.x, y2 = p2.y + H / 2;
      const dx = Math.max(34, (x2 - x1) * 0.45);
      const path = el('path', {
        class: 'edge', 'data-a': d.nodes[a].id, 'data-b': d.nodes[b].id,
        d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
      });
      // A custom property, not `stroke`: setting the property leaves `.edge.hi`
      // free to override the stroke outright, so selecting an edge still turns
      // it accent-coloured instead of keeping its role hue.
      const kind = d.edge_kinds && d.edge_kinds[i];
      if (kind) {
        path.dataset.kind = kind;
        path.style.setProperty('--edge-col', roleColor(kind));
      }
      edgeLayer.appendChild(path);
    });

    d.nodes.forEach((n, i) => {
      const g = el('g', { class: 'nd' + (i === d.focus ? ' focus' : '') + (n.disabled ? ' off' : ''), transform: `translate(${place[i].x},${place[i].y})` });
      g.dataset.id = n.id;
      g.appendChild(el('rect', { class: 'box', width: W, height: H }));
      // Inline style, not a fill attribute: a CSS rule such as `.nd rect` would
      // outrank the attribute and repaint this bar in the box colour.
      g.appendChild(el('rect', { class: 'kindbar', width: 6, height: H, style: `fill:${nodeColor(n)}` }));
      // Ephemeral models are inlined into their children, nothing exists in the
      // warehouse, so they are drawn like the disabled ones: dashed.
      if (matLabel(n) === 'ephemeral') g.classList.add('off');

      const t1 = el('text', { class: 't1', x: 12, y: 20 });
      t1.textContent = clip(n.name, columnMode ? 24 : 27);
      g.appendChild(t1);

      const t2 = el('text', { class: 't2', x: 12, y: 35 });
      t2.textContent = clip(subtitle(n), columnMode ? 30 : 34);
      g.appendChild(t2);

      if (roles[i]) g.appendChild(roleBadge(roles[i]));

      if (n.hidden_up) g.appendChild(badge(-16, H / 2, `+${n.hidden_up}`, 'up'));
      if (n.hidden_down) g.appendChild(badge(W + 16, H / 2, `+${n.hidden_down}`, 'down'));

      // An aria-label rather than a <title>: the native tooltip a <title> draws
      // would arrive a second after the hover card and sit on top of it. The
      // group still needs an accessible name, and role="img" is what gets one
      // exposed on a bare <g>.
      g.setAttribute('role', 'img');
      g.setAttribute('aria-label', `${n.id} ${n.file}`);

      g.addEventListener('click', (e) => { e.stopPropagation(); select(n.id); handlers.onSelect && handlers.onSelect(n); });
      g.addEventListener('dblclick', (e) => { e.stopPropagation(); handlers.onOpen && handlers.onOpen(n); });
      // enter/leave, not over/out: the group has four children, and crossing
      // between them would fire over/out as if the box had been left.
      g.addEventListener('mouseenter', () => { if (!drag) handlers.onHover && handlers.onHover(n, g); });
      g.addEventListener('mouseleave', () => handlers.onHoverOut && handlers.onHoverOut());
      nodeLayer.appendChild(g);
    });

    fit();
    select(selected);
  }

  /* The role, as a tag above the box rather than inside it: both lines of a
     column box are already full, and a badge that overlaps a column name is
     worse than no badge. VGAP leaves room, and fit() pads beyond it.

     Dark fill with a coloured outline, not a coloured fill: the role ramp runs
     from a light slate to a dark grey, so one text colour could never stay
     legible across all of them. */
  function roleBadge(role) {
    const label = role.toUpperCase();
    const w = label.length * 5.8 + 12;
    const colour = roleColor(role);
    const g = el('g', { class: 'rolebadge' });
    g.appendChild(el('rect', {
      x: W - w - 4, y: -14, width: w, height: 14, rx: 3,
      style: `fill:#131922;stroke:${colour}`,
    }));
    const t = el('text', {
      class: 'rolelabel', x: W - w / 2 - 4, y: -4, 'text-anchor': 'middle',
      style: `fill:${colour}`,
    });
    t.textContent = label;
    g.appendChild(t);
    return g;
  }

  function badge(x, y, label, dir) {
    const g = el('g', { class: 'more-badge', style: 'cursor:pointer' });
    g.appendChild(el('circle', { cx: x, cy: y, r: 11, fill: '#1d2430', stroke: '#2a3340' }));
    const t = el('text', { class: 'more', x, y: y + 3, 'text-anchor': 'middle' });
    t.textContent = label;
    g.appendChild(t);
    g.addEventListener('click', (e) => { e.stopPropagation(); handlers.onExpand && handlers.onExpand(dir); });
    return g;
  }

  function select(id) {
    selected = id;
    root.querySelectorAll('.nd').forEach((g) => g.classList.toggle('sel', g.dataset.id === id));
    root.querySelectorAll('.edge').forEach((p) => {
      p.classList.toggle('hi', p.dataset.a === id || p.dataset.b === id);
    });
  }

  function fit() {
    if (!bbox || !data || !data.nodes.length) return;
    const r = svg.getBoundingClientRect();
    const pad = 30;
    const k = Math.min(1.1, Math.max(0.08,
      Math.min((r.width - pad * 2) / (bbox.x1 - bbox.x0 || 1), (r.height - pad * 2) / (bbox.y1 - bbox.y0 || 1))));
    view.k = k;
    view.x = r.width / 2 - ((bbox.x0 + bbox.x1) / 2) * k;
    view.y = r.height / 2 - ((bbox.y0 + bbox.y1) / 2) * k;
    apply();
  }

  // clear() does not go through apply(), so it closes the card itself.
  const clear = () => {
    root && (root.textContent = '');
    data = null; bbox = null;
    handlers.onHoverClose && handlers.onHoverClose();
  };

  return { init, render, fit, select, clear, subtitle, nodeColor, matLabel, roleColor, nodeRoles };
})();
