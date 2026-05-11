// App: render seat map SVG, handle interactions, filtering, pan/zoom, checkout.
function __initSeatmapApp(){
  if (window.__SEATMAP_APP_STARTED) return;
  window.__SEATMAP_APP_STARTED = true;
  const M = window.SEATMAP;
  const FLOW_BRIDGE = window.__SUBS_FLOW_BRIDGE || null;
  const ASSET_PREFIX = FLOW_BRIDGE ? 'assets' : '../assets';
  const tierMap = Object.fromEntries(M.tiers.map(t => [t.id, t]));
  const ggtTierPrices = window.GGT_TIER_PRICES || {};
  /** Subscription price for a tier: Orpheum vs Golden Gate (GGT has its own price table). */
  function subscriptionPriceForTier(tierId, isGoldenGate){
    if (isGoldenGate && ggtTierPrices[tierId] != null) return Number(ggtTierPrices[tierId]);
    const t = tierMap[tierId];
    return t && t.price != null ? Number(t.price) : 0;
  }
  let venueIdx = 0;       // 0 = Orpheum, 1 = Golden Gate
  let venue1Seats = [];
  let venue1Tier = null;
  const ns = 'http://www.w3.org/2000/svg';

  // ---------- Filter chips ----------
  const tiersEl = document.getElementById('tiers');
  const allChip = document.createElement('button');
  allChip.className = 'chip active';
  allChip.dataset.tier = 'ALL';
  allChip.innerHTML = `<span class="all">ALL</span>`;
  tiersEl.appendChild(allChip);

  M.tiers.forEach(t => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.dataset.tier = t.id;
    const priceLabel = `<span class="chip-price">$${t.price.toLocaleString('en-US')}</span>`;
    if (t.id === 't2'){
      c.innerHTML = `<span class="ic" style="background:${t.color};color:#fff;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;flex-shrink:0"><img src="${ASSET_PREFIX}/iconsAccessibility.svg" width="12" height="12" alt="" style="filter:invert(1)" /></span>${priceLabel}`;
    } else {
      c.innerHTML = `<span class="swatch" style="background:${t.color}"></span>${priceLabel}`;
    }
    tiersEl.appendChild(c);
  });

  let activeTier = 'ALL';
  let activeSeatType = null;
  tiersEl.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    // Locked while seats are selected — must use Change price flow
    if (document.getElementById('filterbar').classList.contains('locked')) return;
    [...tiersEl.children].forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    activeTier = b.dataset.tier;
    applyFilter();
    renderSummary();
  });
  document.querySelectorAll('.chip[data-seattype]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.seattype;
      if (activeSeatType === t){ activeSeatType = null; b.classList.remove('active'); }
      else { activeSeatType = t;
        document.querySelectorAll('.chip[data-seattype]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }
      applyFilter();
    });
  });

  // ---------- Build geometry ----------
  // ---------- Build geometry from raw SVG seats ----------
  // Each seat already has x, y, tier id, sec name. Add row labels by clustering seats per section.

  const allSeats = [];
  const sectionMeta = [];

  // Group raw seats by section
  const bySec = { BALCONY: [], MEZZANINE: [], ORCHESTRA: [] };
  M.seatsRaw.forEach(s => { (bySec[s.sec] || (bySec[s.sec]=[])).push(s); });

  // Generate row letters by clustering y-coordinate within each section.
  // Theatre rows are roughly arcs of constant radius. Seats on a row have similar y-values
  // within a small tolerance (since arc curvature is shallow).
  function clusterRows(seats){
    if (!seats.length) return [];
    // Sort by y, then group seats with successive y values within 4 units
    const sorted = [...seats].sort((a,b) => a.y - b.y);
    const rows = [[sorted[0]]];
    for (let i=1; i<sorted.length; i++){
      const prev = sorted[i-1];
      const cur = sorted[i];
      if (cur.y - prev.y < 3.5) rows[rows.length-1].push(cur);
      else rows.push([cur]);
    }
    // Sort each row left-to-right
    rows.forEach(r => r.sort((a,b)=>a.x - b.x));
    return rows;
  }

  // Section ordering top→bottom (by min y)
  const SEC_ORDER = ['BALCONY','MEZZANINE','ORCHESTRA'];

  SEC_ORDER.forEach(secName => {
    const rawSeats = bySec[secName] || [];
    if (!rawSeats.length) return;
    const rows = clusterRows(rawSeats);

    // Row letters: in theatre convention, front row = A, going back the alphabet.
    // Front of section is at the side closest to the stage (highest y in this layout — stage is at bottom).
    // So sort rows back-to-front (smallest y first = back), letter assignment back-to-front uses Z..A.
    // For clarity: assign labels A (front, highest y) up through alphabet going back.
    const rowsBackToFront = [...rows]; // already sorted by y ascending = back to front
    const N = rowsBackToFront.length;
    // Generate labels: front row A, then B, C, ..., Z, then AA, BB, CC for rows beyond Z
    const letterFor = (idxFromFront) => {
      const A = 'A'.charCodeAt(0);
      if (idxFromFront < 26) return String.fromCharCode(A + idxFromFront);
      const dub = idxFromFront - 26;
      const ch = String.fromCharCode(A + dub);
      return ch + ch;
    };

    let secMinX = Infinity, secMaxX = -Infinity, secMinY = Infinity, secMaxY = -Infinity;
    const labels = [];

    rowsBackToFront.forEach((rowSeats, rowIdxBack) => {
      const idxFromFront = N - 1 - rowIdxBack;
      const letter = letterFor(idxFromFront);
      rowSeats.forEach((s, i) => {
        const seat = {
          x: s.x, y: s.y,
          tier: s.tier,
          sec: secName, secName: secName,
          row: letter,
          num: i + 1,
          sold: Math.random() < 0.06,
          wc: false, wcc: false,
        };
        allSeats.push(seat);
        if (s.x < secMinX) secMinX = s.x;
        if (s.x > secMaxX) secMaxX = s.x;
        if (s.y < secMinY) secMinY = s.y;
        if (s.y > secMaxY) secMaxY = s.y;
      });
      // Label at left and right ends of row
      const left = rowSeats[0], right = rowSeats[rowSeats.length-1];
      const padOut = 4;
      labels.push({ char: letter, xL: left.x - padOut, yL: left.y, xR: right.x + padOut, yR: right.y });
    });

    sectionMeta.push({
      name: secName, cx: (secMinX + secMaxX)/2,
      minY: secMinY, maxY: secMaxY,
      minX: secMinX, maxX: secMaxX,
      labels,
    });
  });

  // ---------- Bounding box ----------
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
  allSeats.forEach(s => {
    if (s.x<minX) minX=s.x; if (s.x>maxX) maxX=s.x;
    if (s.y<minY) minY=s.y; if (s.y>maxY) maxY=s.y;
  });

  // ---------- SVG ----------
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('xmlns', ns);
  const padX = 20, padTop = 35, padBot = 40;
  let vbX = minX - padX;
  let vbY = minY - padTop;
  let vbW = (maxX-minX) + padX*2;
  let vbH = (maxY-minY) + padTop + padBot;
  svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';

  // Defs: the purple check mark in a circle, anchored at (0,0), size 1 unit radius (will be scaled per use)
  const defs = document.createElementNS(ns, 'defs');
  const sym = document.createElementNS(ns, 'symbol');
  sym.setAttribute('id', 'sel-mark');
  sym.setAttribute('viewBox', '-12 -12 24 24');
  sym.setAttribute('overflow', 'visible');
  const symC = document.createElementNS(ns, 'circle');
  symC.setAttribute('cx', '0'); symC.setAttribute('cy', '0'); symC.setAttribute('r', '11');
  symC.setAttribute('fill', '#fff'); symC.setAttribute('stroke', '#5e17eb'); symC.setAttribute('stroke-width', '2');
  sym.appendChild(symC);
  const symP = document.createElementNS(ns, 'path');
  symP.setAttribute('d', 'M -5 0 L -1.5 3.5 L 5.5 -3.5');
  symP.setAttribute('stroke', '#5e17eb');
  symP.setAttribute('stroke-width', '2.4');
  symP.setAttribute('stroke-linecap', 'round');
  symP.setAttribute('stroke-linejoin', 'round');
  symP.setAttribute('fill', 'none');
  sym.appendChild(symP);
  defs.appendChild(sym);
  svg.appendChild(defs);

  // Section labels — placed in the gap above each section's topmost row
  sectionMeta.forEach(m => {
    const t = document.createElementNS(ns,'text');
    t.setAttribute('x', m.cx);
    t.setAttribute('y', m.minY - 14);
    t.setAttribute('class','sec-label');
    t.textContent = m.name;
    svg.appendChild(t);
  });

  // Row labels
  sectionMeta.forEach(m => {
    (m.labels||[]).forEach(L => {
      const tl = document.createElementNS(ns,'text');
      tl.setAttribute('x', L.xL); tl.setAttribute('y', L.yL);
      tl.setAttribute('class','row-label'); tl.textContent = L.char;
      svg.appendChild(tl);
      const tr = document.createElementNS(ns,'text');
      tr.setAttribute('x', L.xR); tr.setAttribute('y', L.yR);
      tr.setAttribute('class','row-label'); tr.textContent = L.char;
      svg.appendChild(tr);
    });
  });

  // Seats
  const seatRadius = 2.4;
  const seatNodes = [];
  allSeats.forEach((s, i) => {
    const c = document.createElementNS(ns,'circle');
    c.setAttribute('cx', s.x);
    c.setAttribute('cy', s.y);
    c.setAttribute('r', seatRadius);
    const tier = tierMap[s.tier];
    c.setAttribute('fill', tier.color);
    c.setAttribute('class','seat' + (s.sold ? ' sold' : ''));
    c.dataset.idx = i;
    svg.appendChild(c);
    seatNodes.push(c);
  });

  // STAGE label below
  const stageT = document.createElementNS(ns,'text');
  stageT.setAttribute('x', (minX+maxX)/2);
  stageT.setAttribute('y', maxY + 25);
  stageT.setAttribute('class','sec-label');
  stageT.textContent = 'STAGE';
  svg.appendChild(stageT);

  // Marker layer (above seats) — holds check icons for selected seats
  const markerLayer = document.createElementNS(ns, 'g');
  markerLayer.setAttribute('class', 'marker-layer');
  svg.appendChild(markerLayer);
  const seatMarkers = {}; // idx -> <use> node

  function addMarker(idx){
    const s = allSeats[idx];
    const u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#sel-mark');
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#sel-mark');
    const size = seatRadius * 2;
    u.setAttribute('width', size);
    u.setAttribute('height', size);
    u.setAttribute('x', s.x - size/2);
    u.setAttribute('y', s.y - size/2);
    u.setAttribute('class', 'sel-mark');
    u.style.pointerEvents = 'none';
    markerLayer.appendChild(u);
    seatMarkers[idx] = u;
  }
  function removeMarker(idx){
    const u = seatMarkers[idx];
    if (u){ u.remove(); delete seatMarkers[idx]; }
  }

  document.getElementById('mapInner').appendChild(svg);

  // Snapshot Orpheum geometry so we can restore it if the user changes price on venue 2.
  // (We used to reload to restore the original SVG, but Subscription Flow now always starts at state 1.)
  const ORPHEUM_SNAPSHOT = {
    vbX,
    vbY,
    vbW,
    vbH,
    nodes: Array.from(svg.querySelectorAll('.seat, .sec-label, .row-label')).map(n => n.cloneNode(true)),
    allSeats: allSeats.map(s => ({ ...s })),
  };

  function restoreOrpheumFromSnapshot(){
    // Clear selection + markers
    [...selected].forEach(i => { seatNodes[i] && seatNodes[i].classList.remove('selected'); removeMarker(i); });
    selected.clear();

    // Clear existing seat/label elements
    svg.querySelectorAll('.seat, .sec-label, .row-label').forEach(el => el.remove());

    // Restore bounds
    vbX = ORPHEUM_SNAPSHOT.vbX;
    vbY = ORPHEUM_SNAPSHOT.vbY;
    vbW = ORPHEUM_SNAPSHOT.vbW;
    vbH = ORPHEUM_SNAPSHOT.vbH;
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);

    // Restore DOM nodes (preserve markerLayer on top)
    ORPHEUM_SNAPSHOT.nodes.forEach(n => svg.insertBefore(n.cloneNode(true), markerLayer));

    // Restore seat data structures
    allSeats.length = 0;
    ORPHEUM_SNAPSHOT.allSeats.forEach(s => allSeats.push({ ...s }));

    seatNodes.length = 0;
    svg.querySelectorAll('.seat').forEach(node => {
      const idx = Number(node.dataset.idx);
      if (Number.isFinite(idx) && idx >= 0) seatNodes[idx] = node;
    });

    Object.keys(seatMarkers).forEach(k => delete seatMarkers[k]);
    markerLayer.querySelectorAll('*').forEach(el => el.remove());

    Object.keys(rowIndex).forEach(k => delete rowIndex[k]);
    allSeats.forEach((s, i) => {
      const k = s.sec + '|' + s.row;
      (rowIndex[k] || (rowIndex[k] = [])).push(i);
    });
    Object.values(rowIndex).forEach(arr => arr.sort((a, b) => allSeats[a].num - allSeats[b].num));

    // Resize inner container and refit viewport
    inner.style.width = vbW + 'px';
    inner.style.height = vbH + 'px';
    fit();
  }

  // ---------- Pan & zoom ----------
  const stage = document.getElementById('stage');
  const inner = document.getElementById('mapInner');
  let scale = 1, tx = 0, ty = 0;
  let baseScale = 1;

  function fit(){
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    inner.style.width = vbW + 'px';
    inner.style.height = vbH + 'px';
    const sx = stageW / vbW;
    const sy = stageH / vbH;
    baseScale = Math.min(sx, sy) * 0.98;
    scale = baseScale;
    tx = (stageW - vbW*scale)/2;
    ty = (stageH - vbH*scale)/2;
    apply();
  }
  function apply(){ inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; }
  function clampPan(){
    const stageW = stage.clientWidth, stageH = stage.clientHeight;
    const w = vbW*scale, h = vbH*scale;
    const margin = 80;
    if (w < stageW){
      const centerX = (stageW - w) / 2;
      tx = Math.min(centerX + margin, Math.max(centerX - margin, tx));
    } else {
      tx = Math.min(margin, Math.max(stageW - w - margin, tx));
    }
    if (h < stageH){
      const centerY = (stageH - h) / 2;
      ty = Math.min(centerY + margin, Math.max(centerY - margin, ty));
    } else {
      ty = Math.min(margin, Math.max(stageH - h - margin, ty));
    }
  }

  window.addEventListener('resize', fit);
  fit();

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1/1.12);
  }, {passive:false});

  function zoomAt(px, py, factor){
    const newScale = Math.max(baseScale*0.85, Math.min(baseScale*5, scale*factor));
    const k = newScale/scale;
    tx = px - (px - tx)*k;
    ty = py - (py - ty)*k;
    scale = newScale;
    clampPan();
    apply();
  }

  document.getElementById('zin').onclick = () => zoomAt(stage.clientWidth/2, stage.clientHeight/2, 1.2);
  document.getElementById('zout').onclick = () => zoomAt(stage.clientWidth/2, stage.clientHeight/2, 1/1.2);
  document.getElementById('zhome').onclick = () => fit();

  let dragging=false, sxp=0, syp=0, stx=0, sty=0, moved=false;
  stage.addEventListener('pointerdown', e => {
    // Clicking a seat should select on first click (do not start a drag gesture).
    if (e.target && e.target.classList && e.target.classList.contains('seat')) return;
    dragging=true; moved=false;
    sxp=e.clientX; syp=e.clientY; stx=tx; sty=ty;
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    const seat = e.target.classList && e.target.classList.contains('seat') ? e.target : null;
    if (!dragging){
      if (seat && !seat.classList.contains('sold') && !seat.classList.contains('dim')){
        const idx = +seat.dataset.idx;
        const s = allSeats[idx];
        const t = tierMap[s.tier];
        showTooltip(e.clientX, e.clientY, s, t);
      } else hideTooltip();
    }
    if (!dragging) return;
    const dx = e.clientX - sxp, dy = e.clientY - syp;
    if (Math.abs(dx)+Math.abs(dy) > 3) moved = true;
    tx = stx + dx; ty = sty + dy;
    clampPan();
    apply();
  });
  stage.addEventListener('pointerup', () => { dragging=false; stage.classList.remove('dragging'); });
  stage.addEventListener('pointerleave', hideTooltip);

  const ttp = document.getElementById('ttp');
  function showTooltip(clientX, clientY, s, t){
    const rect = stage.getBoundingClientRect();
    ttp.style.left = (clientX - rect.left) + 'px';
    ttp.style.top  = (clientY - rect.top) + 'px';
    const p = subscriptionPriceForTier(s.tier, venueIdx >= 1);
    ttp.innerHTML = `<div class="ttp-row"><span class="ttp-dot" style="background:${t.color}"></span> ${s.secName} · Row ${s.row} · Seat ${s.num} · $${p.toLocaleString()}</div>`;
    ttp.classList.add('show');
  }
  function hideTooltip(){ ttp.classList.remove('show'); }

  function applyFilter(){
    seatNodes.forEach((node, i) => {
      const s = allSeats[i];
      const tierOk = activeTier==='ALL' || s.tier===activeTier;
      let typeOk = true;
      if (activeSeatType === 'wc') typeOk = !!s.wc;
      if (activeSeatType === 'wcc') typeOk = !!s.wcc;
      node.classList.toggle('dim', !(tierOk && typeOk));
    });
  }

  const selected = new Set();
  function fmt(n){ return n.toLocaleString('en-US', {style:'currency', currency:'USD', minimumFractionDigits:2}); }

  // Toast for selection rule violations
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function toast(msg){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  const MAX_SEATS = 2;
  const camTitleEl = document.getElementById('camTitle');
  let pendingTier = null;
  let pendingTierPrice = null;

  function openChangePriceModalGeneric(){
    pendingTier = null;
    pendingTierPrice = null;
    if (camTitleEl) camTitleEl.textContent = 'Do you want to change the subscription price?';
    if (clearAllModal) clearAllModal.classList.add('show');
  }

  function openChangePriceModalForTier(tierId){
    pendingTier = tierId || null;
    const p = pendingTier ? subscriptionPriceForTier(pendingTier, venueIdx >= 1) : null;
    pendingTierPrice = p != null && Number.isFinite(p) && p > 0 ? p : null;
    if (camTitleEl) {
      if (pendingTierPrice != null) camTitleEl.textContent = `Do you want to change the subscription price to $${pendingTierPrice.toLocaleString()}?`;
      else camTitleEl.textContent = 'Do you want to change the subscription price?';
    }
    if (clearAllModal) clearAllModal.classList.add('show');
  }

  function resetToOrpheumAndUnlock(){
    // Clear selection + markers
    [...selected].forEach(i => { seatNodes[i].classList.remove('selected'); removeMarker(i); });
    selected.clear();
    venueIdx = 0;
    venue1Seats = [];
    venue1Tier = null;

    // Reset stepper
    const steps = document.querySelectorAll('.step');
    if (steps[0]) {
      steps[0].classList.add('active');
      steps[0].classList.remove('done');
      const pin = steps[0].querySelector('.pin');
      if (pin) pin.textContent = '1';
    }
    if (steps[1]) steps[1].classList.remove('active');

    // Header matches Orpheum screen
    const occasionEl = document.querySelector('.occasion');
    if (occasionEl) occasionEl.textContent = 'Tuesday · Evening';

    // Restore Orpheum geometry + unlock price bands.
    restoreOrpheumFromSnapshot();
    activeTier = 'ALL';
    [...tiersEl.children].forEach(x => x.classList.toggle('active', x.dataset.tier === 'ALL'));
    applyFilter();
    renderSummary();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch(e){}
  }

  // Index seats by sec+row for adjacency lookup
  const rowIndex = {};  // key = sec + '|' + row → array of seat indices sorted by num
  allSeats.forEach((s, i) => {
    const k = s.sec + '|' + s.row;
    (rowIndex[k] || (rowIndex[k] = [])).push(i);
  });
  Object.values(rowIndex).forEach(arr => arr.sort((a,b) => allSeats[a].num - allSeats[b].num));

  function areAdjacent(idxA, idxB){
    const a = allSeats[idxA], b = allSeats[idxB];
    return a.sec === b.sec && a.row === b.row && Math.abs(a.num - b.num) === 1;
  }

  // Geometry-based adjacency for venue 1 (Orpheum) to avoid row-label clustering edge cases.
  // Two seats are considered "same row" if they share section + have very similar y,
  // and "adjacent" if they're immediate neighbors in x-order within that row band.
  function isSameRowAndNeighborByGeometry(idx, firstIdx){
    const a = allSeats[firstIdx];
    const b = allSeats[idx];
    if (!a || !b) return false;
    if (a.sec !== b.sec) return false;
    const Y_EPS = 4.5;
    if (Math.abs(a.y - b.y) > Y_EPS) return false;

    // Build a "row band" around the first seat and sort by x.
    const band = [];
    for (let i = 0; i < allSeats.length; i++){
      const s = allSeats[i];
      if (s.sec !== a.sec) continue;
      if (Math.abs(s.y - a.y) <= Y_EPS) band.push(i);
    }
    band.sort((i, j) => allSeats[i].x - allSeats[j].x);

    const ai = band.indexOf(firstIdx);
    const bi = band.indexOf(idx);
    if (ai === -1 || bi === -1) return false;
    return Math.abs(ai - bi) === 1;
  }

  svg.addEventListener('click', e => {
    if (moved) { moved=false; return; }
    const seat = e.target.closest && e.target.closest('.seat');
    if (!seat) return;
    const idx = +seat.dataset.idx;
    const s = allSeats[idx];
    // Dismiss any active toast when the user clicks a new seat
    if (toastEl) { toastEl.classList.remove('show'); clearTimeout(toastTimer); }
    if (seat.classList.contains('sold')) return;
    if (seat.classList.contains('dim')) {
      // Only prompt a price change when the flow is "locked" and Clear all is available.
      const changePriceBtn = document.getElementById('changePrice');
      const clearAllVisible = !!(changePriceBtn && !changePriceBtn.classList.contains('hidden'));
      if (clearAllVisible && s) openChangePriceModalForTier(s.tier);
      return;
    }
    if (selected.has(idx)){
      selected.delete(idx); seat.classList.remove('selected'); removeMarker(idx);
    } else {
      // Rule 1: max seats
      if (selected.size >= MAX_SEATS){
        toast('Only 2 seats are needed for this test');
        return;
      }
      if (selected.size > 0){
        const firstIdx = selected.values().next().value;
        const firstSeat = allSeats[firstIdx];
        // Rule 2: second seat must be in same row (Orpheum can be flaky if we trust computed row labels)
        if (venueIdx === 0) {
        if (!isSameRowAndNeighborByGeometry(idx, firstIdx)) {
            toast('Select 2 seats next to each other');
            return;
          }
        } else {
          if (s.sec !== firstSeat.sec || s.row !== firstSeat.row){
            toast('Select 2 seats next to each other');
            return;
          }
        }
        // Rule 2: same price band
        if (s.tier !== firstSeat.tier){
          const firstTierLabel = tierMap[firstSeat.tier].label || `$${tierMap[firstSeat.tier].price}`;
          toast(`All seats must be in the same price band (${firstTierLabel}).`);
          return;
        }
        // Rule 3: the second seat must be immediately left/right of the first seat
        if (venueIdx === 0) {
          // Already enforced by geometry-based neighbor check above.
        } else if (!areAdjacent(idx, firstIdx)){
          toast('Seats need to be next to each other');
          return;
        }
      }
      selected.add(idx); seat.classList.add('selected'); addMarker(idx);
    }
    renderSummary();
  });

  const summaryEl = document.getElementById('selected');
  const totalEl = document.getElementById('total');
  const cta = document.getElementById('cta');
  const filterLabel = document.getElementById('filterLabel');

  function renderSummary(){
    if (!summaryEl || !totalEl) return;
    summaryEl.innerHTML = '';
    let tot = 0;

    // Filter bar state
    const filterbar = document.getElementById('filterbar');
    const seatChipsEl = document.getElementById('seatChips');
    const changePriceBtn = document.getElementById('changePrice');
    if (filterbar && seatChipsEl){
      seatChipsEl.innerHTML = '';

      if (venueIdx >= 1) {
        // ── State 8 (GGT): locked to venue-1 tier, show seat chips when selected ──
        filterbar.classList.add('locked');
        if (filterLabel) filterLabel.textContent = 'Current seat selection:';
        if (changePriceBtn) changePriceBtn.classList.remove('hidden');
        // Seat chips for GGT selection
        if (selected.size > 0) {
          const seatsArrSorted = [...selected].map(i => ({i, s: allSeats[i]})).sort((a,b) => a.s.num - b.s.num);
          seatsArrSorted.forEach(({i, s}) => {
            const tierColor = (tierMap[s.tier] || {}).color || '#888';
            const chip = document.createElement('span');
            chip.className = 'seat-chip';
            chip.innerHTML = `<span class="swatch" style="background:${tierColor};width:12px;height:12px;border-radius:50%;display:inline-block;flex-shrink:0"></span><span>${s.row}${s.num}</span><button type="button" data-rm-chip="${i}" aria-label="Remove seat ${s.row}${s.num}">×</button>`;
            seatChipsEl.appendChild(chip);
          });
        }
      } else if (selected.size > 0) {
        // ── State 7 with ≥1 seat: lock to chosen tier ──
        const lockedTier = allSeats[selected.values().next().value].tier;
        if (activeTier !== lockedTier){
          activeTier = lockedTier;
          [...tiersEl.children].forEach(x => x.classList.toggle('active', x.dataset.tier === lockedTier));
          applyFilter();
        }
        filterbar.classList.add('locked');
        if (filterLabel) filterLabel.textContent = 'Current seat selection:';
        // Show "Clear all" only after the 2nd seat is chosen
        if (changePriceBtn) changePriceBtn.classList.toggle('hidden', selected.size < 2);
        // Seat chips
        const seatsArrSorted = [...selected].map(i => ({i, s: allSeats[i]})).sort((a,b) => a.s.num - b.s.num);
        seatsArrSorted.forEach(({i, s}) => {
          const chip = document.createElement('span');
          chip.className = 'seat-chip';
          chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 10.5C2.35833 10.5 2.23958 10.4521 2.14375 10.3562C2.04792 10.2604 2 10.1417 2 10V8.5C2 8.225 2.09792 7.98958 2.29375 7.79375C2.48958 7.59792 2.725 7.5 3 7.5H9C9.275 7.5 9.51042 7.59792 9.70625 7.79375C9.90208 7.98958 10 8.225 10 8.5V10C10 10.1417 9.95208 10.2604 9.85625 10.3562C9.76042 10.4521 9.64167 10.5 9.5 10.5C9.35833 10.5 9.23958 10.4521 9.14375 10.3562C9.04792 10.2604 9 10.1417 9 10V8.5H3V10C3 10.1417 2.95208 10.2604 2.85625 10.3562C2.76042 10.4521 2.64167 10.5 2.5 10.5ZM2.25 7C2.04167 7 1.86458 6.92708 1.71875 6.78125C1.57292 6.63542 1.5 6.45833 1.5 6.25C1.5 6.04167 1.57292 5.86458 1.71875 5.71875C1.86458 5.57292 2.04167 5.5 2.25 5.5C2.45833 5.5 2.63542 5.57292 2.78125 5.71875C2.92708 5.86458 3 6.04167 3 6.25C3 6.45833 2.92708 6.63542 2.78125 6.78125C2.63542 6.92708 2.45833 7 2.25 7ZM3.5 7V2.5C3.5 2.225 3.59792 1.98958 3.79375 1.79375C3.98958 1.59792 4.225 1.5 4.5 1.5H7.5C7.775 1.5 8.01042 1.59792 8.20625 1.79375C8.40208 1.98958 8.5 2.225 8.5 2.5V7H3.5ZM9.75 7C9.54167 7 9.36458 6.92708 9.21875 6.78125C9.07292 6.63542 9 6.45833 9 6.25C9 6.04167 9.07292 5.86458 9.21875 5.71875C9.36458 5.57292 9.54167 5.5 9.75 5.5C9.95833 5.5 10.1354 5.57292 10.2812 5.71875C10.4271 5.86458 10.5 6.04167 10.5 6.25C10.5 6.45833 10.4271 6.63542 10.2812 6.78125C10.1354 6.92708 9.95833 7 9.75 7ZM4.5 6H7.5V2.5H4.5V6Z"/></svg><span>${s.row}${s.num}</span><button type="button" data-rm-chip="${i}" aria-label="Remove seat ${s.row}${s.num}">×</button>`;
          seatChipsEl.appendChild(chip);
        });
      } else {
        // ── State 7 with no seats: show price chips ──
        filterbar.classList.remove('locked');
        filterbar.classList.remove('price-selected');
        if (filterLabel) filterLabel.textContent = 'Price per subscription:';
        if (changePriceBtn) changePriceBtn.classList.add('hidden');
      }
    }

    // Show saved venue-1 seat badges under step 1 once we've moved to venue 2
    const badgesEl = document.getElementById('seatBadges');
    if (badgesEl){
      badgesEl.innerHTML = '';
      if (venueIdx >= 1 && venue1Seats.length > 0){
        venue1Seats.forEach(s => {
          const b = document.createElement('span');
          b.className = 'seat-badge';
          b.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 10.5C2.35833 10.5 2.23958 10.4521 2.14375 10.3562C2.04792 10.2604 2 10.1417 2 10V8.5C2 8.225 2.09792 7.98958 2.29375 7.79375C2.48958 7.59792 2.725 7.5 3 7.5H9C9.275 7.5 9.51042 7.59792 9.70625 7.79375C9.90208 7.98958 10 8.225 10 8.5V10C10 10.1417 9.95208 10.2604 9.85625 10.3562C9.76042 10.4521 9.64167 10.5 9.5 10.5C9.35833 10.5 9.23958 10.4521 9.14375 10.3562C9.04792 10.2604 9 10.1417 9 10V8.5H3V10C3 10.1417 2.95208 10.2604 2.85625 10.3562C2.76042 10.4521 2.64167 10.5 2.5 10.5ZM2.25 7C2.04167 7 1.86458 6.92708 1.71875 6.78125C1.57292 6.63542 1.5 6.45833 1.5 6.25C1.5 6.04167 1.57292 5.86458 1.71875 5.71875C1.86458 5.57292 2.04167 5.5 2.25 5.5C2.45833 5.5 2.63542 5.57292 2.78125 5.71875C2.92708 5.86458 3 6.04167 3 6.25C3 6.45833 2.92708 6.63542 2.78125 6.78125C2.63542 6.92708 2.45833 7 2.25 7ZM3.5 7V2.5C3.5 2.225 3.59792 1.98958 3.79375 1.79375C3.98958 1.59792 4.225 1.5 4.5 1.5H7.5C7.775 1.5 8.01042 1.59792 8.20625 1.79375C8.40208 1.98958 8.5 2.225 8.5 2.5V7H3.5ZM9.75 7C9.54167 7 9.36458 6.92708 9.21875 6.78125C9.07292 6.63542 9 6.45833 9 6.25C9 6.04167 9.07292 5.86458 9.21875 5.71875C9.36458 5.57292 9.54167 5.5 9.75 5.5C9.95833 5.5 10.1354 5.57292 10.2812 5.71875C10.4271 5.86458 10.5 6.04167 10.5 6.25C10.5 6.45833 10.4271 6.63542 10.2812 6.78125C10.1354 6.92708 9.95833 7 9.75 7ZM4.5 6H7.5V2.5H4.5V6Z"/></svg><span>${s.row}${s.num}</span>`;
          badgesEl.appendChild(b);
        });
      }
    }
    // Basket: Orpheum uses tier from selection (or price-chip preview). Golden Gate keeps the same
    // figures as end of Orpheum — 2 × venue-1 tier only (no second-venue add-on on this screen).
    // Combined venue totals are shown on the review cart after continue.
    function tierPrice(id){
      const t = id && tierMap[id];
      if (!t || t.price == null) return 0;
      const n = Number(t.price);
      return Number.isFinite(n) ? n : 0;
    }
    let subPerPerson = 0;
    if (venueIdx >= 1) {
      subPerPerson = tierPrice(venue1Tier);
    } else {
      const tid = selected.size
        ? allSeats[selected.values().next().value].tier
        : (activeTier !== 'ALL' ? activeTier : null);
      subPerPerson = tierPrice(tid);
    }
    // Orpheum: count matches seats once selected; price chip alone previews 1× unit (no line item until a seat). Golden Gate: always 2.
    const nSubs =
      venueIdx >= 1 ? 2 :
      (selected.size > 0 ? selected.size : (activeTier !== 'ALL' ? 1 : 0));
    if (nSubs > 0 && subPerPerson > 0) {
      tot = subPerPerson * nSubs;
      // Price chip alone updates order total; subscription row appears only after a seat is added.
      if (selected.size > 0) {
        const item = document.createElement('div');
        item.className = 'selected-item selected-item--subscription';
        item.innerHTML = `
        <span class="subscription-line-label"><strong>${nSubs} x subscriptions</strong></span>
        <span class="price">${fmt(subPerPerson)}</span>`;
        summaryEl.appendChild(item);
      }
    }
    totalEl.textContent = fmt(tot);
    const ctaLabel = venueIdx === 0 ? 'Continue to Golden Gate Theatre' : 'Reserve and continue';
    if (selected.size === 2){ cta.classList.add('enabled'); cta.disabled=false; cta.textContent=ctaLabel; }
    else { cta.classList.remove('enabled'); cta.disabled=true; cta.textContent=ctaLabel; }
  }
  summaryEl.addEventListener('click', e => {
    if (e.target.closest('button[data-rm-all]')){
      [...selected].forEach(i => { seatNodes[i].classList.remove('selected'); removeMarker(i); });
      selected.clear();
      renderSummary();
      return;
    }
    const b = e.target.closest('button[data-rm]'); if (!b) return;
    const idx = +b.dataset.rm;
    selected.delete(idx);
    seatNodes[idx].classList.remove('selected');
    removeMarker(idx);
    renderSummary();
  });

  // Seat chip × removal (in the locked filter row)
  document.getElementById('seatChips').addEventListener('click', e => {
    const b = e.target.closest('button[data-rm-chip]'); if (!b) return;
    const idx = +b.dataset.rmChip;
    if (selected.has(idx)){
      selected.delete(idx);
      seatNodes[idx].classList.remove('selected');
      removeMarker(idx);
      renderSummary();
    }
  });

  // "Clear all" — venue 1: directly reset; venue 2: show confirmation modal
  const clearAllModal = document.getElementById('clearAllModal');
  document.getElementById('changePrice').addEventListener('click', () => {
    if (venueIdx >= 1) {
      openChangePriceModalGeneric();
      return;
    }
    // Venue 1: clear selection and reset to all price bands
    [...selected].forEach(i => { seatNodes[i].classList.remove('selected'); removeMarker(i); });
    selected.clear();
    activeTier = 'ALL';
    [...tiersEl.children].forEach(x => x.classList.toggle('active', x.dataset.tier === 'ALL'));
    applyFilter();
    renderSummary();
  });

  document.getElementById('camKeep').addEventListener('click', () => clearAllModal.classList.remove('show'));
  clearAllModal.addEventListener('click', e => { if (e.target === clearAllModal) clearAllModal.classList.remove('show'); });
  document.getElementById('camChange').addEventListener('click', () => {
    clearAllModal.classList.remove('show');
    resetToOrpheumAndUnlock();
  });

  const checkout = document.getElementById('checkout');
  const card = document.getElementById('checkoutCard');
  // When this seatmap is embedded inside the Subscription Flow prototype, its "Continue"
  // CTA should NOT open the standalone checkout overlay — instead, it hands control back
  // to the parent prototype which advances to its own Review/Login screens.
  const IN_IFRAME = (function(){
    try { return window.parent && window.parent !== window; } catch(e){ return false; }
  })();
  const EMBEDDED = !!FLOW_BRIDGE || IN_IFRAME;
  cta.addEventListener('click', () => {
    if (!selected.size) return;

    if (venueIdx === 0) {
      // Save venue 1 seats + tier, then move to venue 2 (Golden Gate)
      venue1Tier  = allSeats[selected.values().next().value].tier;
      venue1Seats = [...selected].map(i => {
        const s = allSeats[i];
        return { row: s.row, num: s.num, sec: s.secName, tier: s.tier };
      }).sort((a, b) => a.num - b.num);
      venueIdx = 1;
      transitionToVenue2();
      return;
    }

    // Venue 2 confirmed — hand off to parent or standalone checkout
    if (EMBEDDED) {
      const v2Seats = [...selected].map(i => {
        const s = allSeats[i];
        return { sec: s.secName, row: s.row, num: s.num, price: subscriptionPriceForTier(s.tier, true) };
      });
      const v1TierPrice = subscriptionPriceForTier(venue1Tier, false);
      const v2TierPrice = v2Seats.length ? v2Seats[0].price : 0;
      const v1Seats = venue1Seats.map(s => ({
        sec: s.sec, row: s.row, num: s.num,
        price: subscriptionPriceForTier(s.tier, false),
      }));
      if (FLOW_BRIDGE && typeof FLOW_BRIDGE.onContinue === 'function') {
        FLOW_BRIDGE.onContinue({
          venue1: { seats: v1Seats, tierPrice: v1TierPrice },
          venue2: { seats: v2Seats, tierPrice: v2TierPrice },
        });
      } else {
        try {
          window.parent.postMessage({
            type: 'seatmap-continue',
            venue1: { seats: v1Seats, tierPrice: v1TierPrice },
            venue2: { seats: v2Seats, tierPrice: v2TierPrice },
          }, '*');
        } catch(e){}
      }
      return;
    }
    renderCheckout();
    checkout.classList.add('show');
  });

  function transitionToVenue2() {
    // Stepper: mark step 1 done (checkmark), activate step 2
    const steps = document.querySelectorAll('.step');
    if (steps[0]) {
      steps[0].classList.remove('active');
      steps[0].classList.add('done');
      const pin = steps[0].querySelector('.pin');
      if (pin) pin.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;
    }
    if (steps[1]) steps[1].classList.add('active');

    // Update page header
    const occasionEl = document.querySelector('.occasion');
    if (occasionEl) occasionEl.textContent = 'Tuesday · Evening';

    // Clear current seat selection; lock filter to the tier chosen in venue 1
    [...selected].forEach(i => { seatNodes[i].classList.remove('selected'); removeMarker(i); });
    selected.clear();
    activeTier = venue1Tier || 'ALL';
    [...tiersEl.children].forEach(x => x.classList.toggle('active', x.dataset.tier === activeTier));

    // ---------- Swap seatmap to Golden Gate Theatre ----------
    const GGT = window.GGT_SEATMAP;
    if (GGT && GGT.seats && GGT.seats.length) {
      // Remove existing seat/label elements from SVG
      svg.querySelectorAll('.seat, .sec-label, .row-label').forEach(el => el.remove());

      // Clear data structures in-place (preserve closure references)
      allSeats.length = 0;
      seatNodes.length = 0;
      Object.keys(seatMarkers).forEach(k => delete seatMarkers[k]);
      Object.keys(rowIndex).forEach(k => delete rowIndex[k]);

      // Row-letter helper
      const letterFor = idx => {
        if (idx < 26) return String.fromCharCode(65 + idx);
        const ch = String.fromCharCode(65 + (idx - 26));
        return ch + ch;
      };

      // Group GGT seats by section
      const ggtBySec = {};
      GGT.seats.forEach(s => { (ggtBySec[s.sec] || (ggtBySec[s.sec] = [])).push(s); });

      const GGT_SEC_ORDER  = ['BALCONY', 'MEZZANINE', 'BOXES', 'ORCHESTRA'];
      const GGT_SEC_LABELS = { BALCONY: 'UPPER CIRCLE', MEZZANINE: 'DRESS CIRCLE', BOXES: 'BOXES', ORCHESTRA: 'STALLS' };

      let ggtMinX = Infinity, ggtMaxX = -Infinity, ggtMinY = Infinity, ggtMaxY = -Infinity;
      const ggtSecMeta = [];

      GGT_SEC_ORDER.forEach(secKey => {
        const rawSeats = ggtBySec[secKey] || [];
        if (!rawSeats.length) return;
        const displayName = GGT_SEC_LABELS[secKey] || secKey;
        const rows = clusterRows(rawSeats);
        const N = rows.length;
        let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
        const labels = [];

        rows.forEach((rowSeats, rowIdxBack) => {
          const letter = letterFor(N - 1 - rowIdxBack);
          rowSeats.forEach((s, i) => {
            const seat = {
              x: s.x, y: s.y,
              tier: s.tier,
              sec: secKey, secName: displayName,
              row: letter, num: i + 1,
              sold: Math.random() < 0.06,
              wc: false, wcc: false,
            };
            allSeats.push(seat);
            if (s.x < sMinX) sMinX = s.x; if (s.x > sMaxX) sMaxX = s.x;
            if (s.y < sMinY) sMinY = s.y; if (s.y > sMaxY) sMaxY = s.y;
          });
          const left = rowSeats[0], right = rowSeats[rowSeats.length - 1];
          labels.push({ char: letter, xL: left.x - 4, yL: left.y, xR: right.x + 4, yR: right.y });
        });

        ggtSecMeta.push({ name: displayName, cx: (sMinX + sMaxX) / 2, minY: sMinY, maxY: sMaxY, minX: sMinX, maxX: sMaxX, labels });
        if (sMinX < ggtMinX) ggtMinX = sMinX; if (sMaxX > ggtMaxX) ggtMaxX = sMaxX;
        if (sMinY < ggtMinY) ggtMinY = sMinY; if (sMaxY > ggtMaxY) ggtMaxY = sMaxY;
      });

      // Update viewport bounds (vbX/Y/W/H are let so they can be reassigned)
      vbX = ggtMinX - padX;
      vbY = ggtMinY - padTop;
      vbW = (ggtMaxX - ggtMinX) + padX * 2;
      vbH = (ggtMaxY - ggtMinY) + padTop + padBot;
      svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);

      // Section labels
      ggtSecMeta.forEach(m => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', m.cx); t.setAttribute('y', m.minY - 14);
        t.setAttribute('class', 'sec-label'); t.textContent = m.name;
        svg.insertBefore(t, markerLayer);
      });

      // Row labels
      ggtSecMeta.forEach(m => {
        (m.labels || []).forEach(L => {
          const tl = document.createElementNS(ns, 'text');
          tl.setAttribute('x', L.xL); tl.setAttribute('y', L.yL);
          tl.setAttribute('class', 'row-label'); tl.textContent = L.char;
          svg.insertBefore(tl, markerLayer);
          const tr = document.createElementNS(ns, 'text');
          tr.setAttribute('x', L.xR); tr.setAttribute('y', L.yR);
          tr.setAttribute('class', 'row-label'); tr.textContent = L.char;
          svg.insertBefore(tr, markerLayer);
        });
      });

      // Seat circles
      allSeats.forEach((s, i) => {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', s.x); c.setAttribute('cy', s.y); c.setAttribute('r', seatRadius);
        const tier = tierMap[s.tier];
        c.setAttribute('fill', tier ? tier.color : '#ccc');
        c.setAttribute('class', 'seat' + (s.sold ? ' sold' : ''));
        c.dataset.idx = i;
        svg.insertBefore(c, markerLayer);
        seatNodes.push(c);
      });

      // STAGE label
      const stageT = document.createElementNS(ns, 'text');
      stageT.setAttribute('x', (ggtMinX + ggtMaxX) / 2);
      stageT.setAttribute('y', ggtMaxY + 25);
      stageT.setAttribute('class', 'sec-label');
      stageT.textContent = 'STAGE';
      svg.insertBefore(stageT, markerLayer);

      // Rebuild row index
      allSeats.forEach((s, i) => {
        const k = s.sec + '|' + s.row;
        (rowIndex[k] || (rowIndex[k] = [])).push(i);
      });
      Object.values(rowIndex).forEach(arr => arr.sort((a, b) => allSeats[a].num - allSeats[b].num));

      // Resize inner container and refit viewport
      inner.style.width = vbW + 'px';
      inner.style.height = vbH + 'px';
      fit();
    }

    applyFilter();
    renderSummary();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Tell parent prototype to navigate to state-8
    if (EMBEDDED) {
      if (FLOW_BRIDGE && typeof FLOW_BRIDGE.onToGgt === 'function') FLOW_BRIDGE.onToGgt();
      else {
        try { window.parent.postMessage({ type: 'seatmap-to-ggt' }, '*'); } catch(e){}
      }
    }
  }
  function renderCheckout(){
    let tot = 0;
    const lines = [...selected].map(i => {
      const s = allSeats[i];
      const p = subscriptionPriceForTier(s.tier, venueIdx >= 1);
      tot += p;
      return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line-2)">
        <span>${s.secName} · Row ${s.row} · Seat ${s.num}</span><span>$${p.toLocaleString()}</span></div>`;
    }).join('');
    card.innerHTML = `
      <h2>Checkout</h2>
      <p class="lede">${selected.size} seat${selected.size>1?'s':''} for First Tuesday Evening 2026</p>
      <div style="margin:6px 0 14px">${lines}
        <div style="display:flex;justify-content:space-between;padding:10px 0 0;font-weight:700"><span>Total</span><span>${fmt(tot)}</span></div>
      </div>
      <div class="form-row"><label>Email</label><input type="email" placeholder="you@example.com" value="patron@example.com" /></div>
      <div class="form-row"><label>Cardholder name</label><input type="text" placeholder="A. Patron" value="A. Patron"/></div>
      <div class="form-row"><label>Card number</label><input type="text" placeholder="•••• •••• •••• ••••" value="4242 4242 4242 4242"/></div>
      <div class="form-row two">
        <div class="form-row" style="margin:0"><label>Expiry</label><input type="text" placeholder="MM/YY" value="12/29"/></div>
        <div class="form-row" style="margin:0"><label>CVC</label><input type="text" placeholder="•••" value="424"/></div>
      </div>
      <div class="checkout-actions">
        <button class="btn-secondary" id="ck-cancel">Back</button>
        <button class="btn-primary" id="ck-pay">Pay ${fmt(tot)}</button>
      </div>`;
    document.getElementById('ck-cancel').onclick = () => checkout.classList.remove('show');
    document.getElementById('ck-pay').onclick = () => {
      const orderId = 'MQ-' + Math.random().toString(36).slice(2,8).toUpperCase();
      card.innerHTML = `<div class="confirmed">
        <div class="check"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></div>
        <h2>Booking confirmed</h2>
        <p>Tickets are on their way to your inbox.</p>
        <div class="order-id">Order ${orderId}</div>
        <div style="margin-top:18px"><button class="btn-primary" id="ck-done" style="padding:10px 22px">Done</button></div>
      </div>`;
      document.getElementById('ck-done').onclick = () => {
        checkout.classList.remove('show');
        [...selected].forEach(i => { seatNodes[i].classList.remove('selected'); removeMarker(i); });
        selected.clear();
        renderSummary();
      };
    };
  }
  checkout.addEventListener('click', e => { if (e.target===checkout) checkout.classList.remove('show'); });

  // ----- Host integration -----
  // In an iframe, the host page usually renders the chrome — hide this document's fixed header.
  // Inline Subscription Flow uses the same window (FLOW_BRIDGE set): keep the shared sticky-header there.
  if (IN_IFRAME && !FLOW_BRIDGE) {
    document.body.classList.add('seatmap-in-iframe');
  }
  if (IN_IFRAME && !FLOW_BRIDGE) {
    try { window.parent.postMessage({ type: 'seatmap-ready' }, '*'); } catch(e){}
  }

  renderSummary();
}

// In the Subscription Flow (in-window state), init when state-3 is shown.
if (window.__SUBS_FLOW_BRIDGE) {
  window.__INIT_SEATMAP = __initSeatmapApp;
} else {
  __initSeatmapApp();
}
