/* ==========================================================================
   Multimodal Transportation Route Optimizer
   Pure HTML / CSS / vanilla JS. No frameworks, no graph or Dijkstra library.
   ========================================================================== */

/* ==========================================================================
   GRAPH DATA STRUCTURE
   ========================================================================== */

/**
 * The transportation network is a weighted, undirected graph.
 * Nodes  -> transit stations (with a screen position for the SVG canvas).
 * Edges  -> connections between two stations, each tagged with a mode of
 *           transport and three independent weights: time, fare, distance.
 */
const Graph = {
  nodes: new Map(),   // id -> { id, name, description, x, y }
  edges: [],          // { id, from, to, mode, time, fare, distance }
  _nodeSeq: 1,
  _edgeSeq: 1,

  reset(){
    this.nodes.clear();
    this.edges = [];
    this._nodeSeq = 1;
    this._edgeSeq = 1;
  },

  addNode(name, description, x, y){
    const id = `n${this._nodeSeq++}`;
    const node = { id, name: name.trim(), description: (description || '').trim(), x, y };
    this.nodes.set(id, node);
    return node;
  },

  addEdge(fromId, toId, mode, time, fare, distance){
    const id = `e${this._edgeSeq++}`;
    const edge = { id, from: fromId, to: toId, mode, time, fare, distance };
    this.edges.push(edge);
    return edge;
  },

  nodeByName(name){
    const target = name.trim().toLowerCase();
    for (const n of this.nodes.values()){
      if (n.name.toLowerCase() === target) return n;
    }
    return null;
  },

  edgeExists(fromId, toId, mode){
    return this.edges.some(e =>
      e.mode === mode &&
      ((e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId))
    );
  },

  edgesOf(nodeId){
    return this.edges.filter(e => e.from === nodeId || e.to === nodeId);
  },

  removeNode(nodeId){
    this.nodes.delete(nodeId);
    this.edges = this.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  },

  removeEdge(edgeId){
    this.edges = this.edges.filter(e => e.id !== edgeId);
  },

  /** Undirected adjacency list: nodeId -> [{ edge, to }] */
  buildAdjacency(){
    const adjacency = {};
    for (const id of this.nodes.keys()) adjacency[id] = [];
    for (const edge of this.edges){
      if (!adjacency[edge.from] || !adjacency[edge.to]) continue; // defensive
      adjacency[edge.from].push({ edge, to: edge.to });
      adjacency[edge.to].push({ edge, to: edge.from });
    }
    return adjacency;
  }
};

const MODES = ['Walking', 'Bus', 'Metro', 'Train', 'Taxi', 'Bicycle'];
const MODE_ICON = { Walking:'🚶', Bus:'🚌', Metro:'🚇', Train:'🚆', Taxi:'🚕', Bicycle:'🚲' };
const MODE_COLOR = {
  Walking:'#7a8699', Bus:'#e07a4c', Metro:'#2a9d8f',
  Train:'#6366e0', Taxi:'#d99a00', Bicycle:'#4fa878'
};

/* ==========================================================================
   PRIORITY QUEUE  (binary min-heap, keyed by tentative distance)
   ========================================================================== */

class MinHeap {
  constructor(){ this.items = []; }

  size(){ return this.items.length; }
  isEmpty(){ return this.items.length === 0; }

  push(entry){
    this.items.push(entry);
    this._siftUp(this.items.length - 1);
  }

  /** Removes and returns the entry with the smallest dist. */
  pop(){
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0){
      this.items[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  _siftUp(i){
    while (i > 0){
      const parent = (i - 1) >> 1;
      if (this.items[parent].dist <= this.items[i].dist) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  _siftDown(i){
    const n = this.items.length;
    while (true){
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.items[left].dist < this.items[smallest].dist) smallest = left;
      if (right < n && this.items[right].dist < this.items[smallest].dist) smallest = right;
      if (smallest === i) break;
      [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
      i = smallest;
    }
  }
}

/* ==========================================================================
   EDGE WEIGHT SELECTION
   The single Dijkstra implementation below is completely agnostic to what
   the weight "means" — it only ever calls getEdgeWeight(edge, criterion).
   ========================================================================== */

function getEdgeWeight(edge, criterion){
  switch (criterion){
    case 'time':     return edge.time;
    case 'fare':     return edge.fare;
    case 'distance': return edge.distance;
    default: throw new Error(`Unknown optimization criterion: ${criterion}`);
  }
}

/* ==========================================================================
   DIJKSTRA ALGORITHM
   Manual implementation using the MinHeap above as the priority queue.
   When recordSteps is true, a step-by-step trace is captured for the
   "Animate Dijkstra" visualization.
   ========================================================================== */

function runDijkstra(sourceId, criterion, { recordSteps = false } = {}){
  const startTime = performance.now();
  const adjacency = Graph.buildAdjacency();

  const distance = {};   // node -> shortest known distance so far
  const previous = {};   // node -> { from, edgeId } used to reach it optimally
  const visited = new Set();

  for (const id of Graph.nodes.keys()){
    distance[id] = Infinity;
    previous[id] = null;
  }
  distance[sourceId] = 0;

  const pq = new MinHeap();
  pq.push({ node: sourceId, dist: 0 });

  const steps = [];
  let edgesRelaxed = 0;

  const snapshot = (extra) => ({
    distances: { ...distance },
    visited: [...visited],
    ...extra
  });

  while (!pq.isEmpty()){
    const { node: current, dist: currentDist } = pq.pop();

    // Lazy-deletion: an outdated heap entry for an already-visited node.
    if (visited.has(current)) continue;
    visited.add(current);

    if (recordSteps){
      steps.push({ type: 'visit', node: current, ...snapshot({}) });
    }

    for (const { edge, to: neighbor } of (adjacency[current] || [])){
      if (visited.has(neighbor)) continue;

      const weight = getEdgeWeight(edge, criterion);
      const candidateDistance = currentDist + weight;
      edgesRelaxed++;

      if (candidateDistance < distance[neighbor]){
        distance[neighbor] = candidateDistance;
        previous[neighbor] = { from: current, edgeId: edge.id };
        pq.push({ node: neighbor, dist: candidateDistance });

        if (recordSteps){
          steps.push({
            type: 'relax', from: current, to: neighbor, edgeId: edge.id,
            newDist: candidateDistance, improved: true, ...snapshot({})
          });
        }
      } else if (recordSteps){
        steps.push({
          type: 'relax', from: current, to: neighbor, edgeId: edge.id,
          newDist: candidateDistance, improved: false, ...snapshot({})
        });
      }
    }
  }

  const executionTime = performance.now() - startTime;
  return {
    distance, previous, steps,
    nodesVisited: visited.size,
    edgesRelaxed,
    executionTime
  };
}

/* ==========================================================================
   PATH RECONSTRUCTION
   Walks the `previous` map backwards from target to source.
   ========================================================================== */

function reconstructPath(previous, sourceId, targetId){
  if (sourceId === targetId) return { nodeIds: [sourceId], edgeIds: [] };
  if (!previous[targetId]) return null; // unreachable

  const nodeIds = [targetId];
  const edgeIds = [];
  let cursor = targetId;

  while (cursor !== sourceId){
    const step = previous[cursor];
    if (!step) return null;
    edgeIds.unshift(step.edgeId);
    nodeIds.unshift(step.from);
    cursor = step.from;
  }
  return { nodeIds, edgeIds };
}

function summarizePath(edgeIds){
  const edges = edgeIds.map(id => Graph.edges.find(e => e.id === id));
  const totals = edges.reduce((acc, e) => {
    acc.time += e.time; acc.fare += e.fare; acc.distance += e.distance;
    return acc;
  }, { time: 0, fare: 0, distance: 0 });

  let transfers = 0;
  for (let i = 1; i < edges.length; i++){
    if (edges[i].mode !== edges[i - 1].mode) transfers++;
  }
  return { edges, totals, transfers };
}

/* ==========================================================================
   GRAPH VISUALIZATION  (SVG, no visualization library)
   ========================================================================== */

const svg = document.getElementById('graph-svg');
const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = 27;

let dragState = null;     // { nodeId, offsetX, offsetY }
let highlightedEdgeIds = new Set();
let nodeVisualState = {}; // nodeId -> 'current' | 'visited' | 'path' | 'source'

function svgEl(tag, attrs = {}){
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function pairKey(a, b){ return [a, b].sort().join('|'); }

/** Groups edges sharing the same node pair so parallel connections can fan out. */
function groupParallelEdges(){
  const groups = {};
  for (const edge of Graph.edges){
    const key = pairKey(edge.from, edge.to);
    (groups[key] = groups[key] || []).push(edge);
  }
  return groups;
}

function renderGraph(){
  svg.innerHTML = '';
  const parallelGroups = groupParallelEdges();
  const drawnOffset = {}; // edge.id -> curve offset, computed once per pair

  for (const key in parallelGroups){
    const group = parallelGroups[key];
    group.forEach((edge, i) => {
      const offset = (i - (group.length - 1) / 2) * 30;
      drawnOffset[edge.id] = offset;
    });
  }

  // Edges first, so nodes sit visually on top.
  for (const edge of Graph.edges){
    drawEdge(edge, drawnOffset[edge.id] || 0);
  }
  // Nodes.
  for (const node of Graph.nodes.values()){
    drawNode(node);
  }
}

function edgeGeometry(edge, offset){
  const from = Graph.nodes.get(edge.from);
  const to = Graph.nodes.get(edge.to);
  if (!from || !to) return null;

  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // unit normal
  const mx = (from.x + to.x) / 2 + nx * offset;
  const my = (from.y + to.y) / 2 + ny * offset;

  const path = offset === 0
    ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;

  return { from, to, midX: mx, midY: my, path };
}

function drawEdge(edge, offset){
  const geo = edgeGeometry(edge, offset);
  if (!geo) return;
  const color = MODE_COLOR[edge.mode] || '#888';
  const group = svgEl('g', { class: 'edge-group', 'data-edge-id': edge.id });

  const visibleLine = svgEl('path', {
    d: geo.path, class: 'edge-line' + (highlightedEdgeIds.has(edge.id) ? ' path-highlight' : ''),
    stroke: color
  });
  const hitbox = svgEl('path', { d: geo.path, class: 'edge-hitbox' });

  const labelBg = svgEl('rect', {
    x: geo.midX - 16, y: geo.midY - 10, width: 32, height: 20, rx: 5, class: 'edge-label-bg'
  });
  const icon = svgEl('text', { x: geo.midX, y: geo.midY - 1, class: 'edge-icon' });
  icon.textContent = MODE_ICON[edge.mode] || '';

  const label = svgEl('text', { x: geo.midX, y: geo.midY + 10, class: 'edge-label' });
  label.textContent = `${edge.time}m`;

  group.append(hitbox, visibleLine, labelBg, icon, label);
  group.addEventListener('click', (e) => { e.stopPropagation(); showEdgeInfo(edge); });

  svg.appendChild(group);
}

function drawNode(node){
  const group = svgEl('g', {
    class: 'node-group' + (nodeVisualState[node.id] ? ` state-${nodeVisualState[node.id]}` : ''),
    'data-node-id': node.id, transform: `translate(${node.x},${node.y})`
  });

  const circle = svgEl('circle', { r: NODE_RADIUS, class: 'node-circle' });
  const label = svgEl('text', { class: 'node-label', y: 4 });
  label.textContent = truncate(node.name, 14);

  group.append(circle, label);

  if (node.description){
    const sub = svgEl('text', { class: 'node-sublabel', y: NODE_RADIUS + 14 });
    sub.textContent = truncate(node.description, 22);
    group.appendChild(sub);
  }

  group.addEventListener('pointerdown', (e) => startDrag(e, node.id));
  svg.appendChild(group);
}

function startDrag(evt, nodeId){
  evt.stopPropagation();
  const pt = clientToSvgPoint(evt.clientX, evt.clientY);
  const node = Graph.nodes.get(nodeId);
  dragState = { nodeId, offsetX: pt.x - node.x, offsetY: pt.y - node.y };
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
}

function onDrag(evt){
  if (!dragState) return;
  const pt = clientToSvgPoint(evt.clientX, evt.clientY);
  const node = Graph.nodes.get(dragState.nodeId);
  if (!node) return;
  node.x = clamp(pt.x - dragState.offsetX, NODE_RADIUS, svg.width.baseVal.value - NODE_RADIUS);
  node.y = clamp(pt.y - dragState.offsetY, NODE_RADIUS, svg.height.baseVal.value - NODE_RADIUS);
  renderGraph();
}

function endDrag(){
  dragState = null;
  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', endDrag);
}

function clientToSvgPoint(clientX, clientY){
  const rect = svg.getBoundingClientRect();
  const scaleX = svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width / rect.width : 1;
  const scaleY = svg.viewBox.baseVal.height ? svg.viewBox.baseVal.height / rect.height : 1;
  return {
    x: (clientX - rect.left) * (scaleX || 1) || (clientX - rect.left),
    y: (clientY - rect.top) * (scaleY || 1) || (clientY - rect.top)
  };
}

/* ---- edge info popover ---- */

function showEdgeInfo(edge){
  const panel = document.getElementById('edge-info');
  const body = document.getElementById('edge-info-body');
  const from = Graph.nodes.get(edge.from), to = Graph.nodes.get(edge.to);
  body.innerHTML = `
    <h3>${MODE_ICON[edge.mode]} ${edge.mode}</h3>
    <div class="edge-info-row"><span>Route</span><b>${from.name} ↔ ${to.name}</b></div>
    <div class="edge-info-row"><span>Travel time</span><b>${edge.time} min</b></div>
    <div class="edge-info-row"><span>Fare</span><b>₹${edge.fare}</b></div>
    <div class="edge-info-row"><span>Distance</span><b>${edge.distance} km</b></div>
  `;
  panel.classList.remove('hidden');
}

document.getElementById('edge-info-close').addEventListener('click', () => {
  document.getElementById('edge-info').classList.add('hidden');
});
svg.addEventListener('click', () => document.getElementById('edge-info').classList.add('hidden'));

/* ==========================================================================
   UI EVENT HANDLERS
   ========================================================================== */

function populateSelects(){
  const nodeOptions = [...Graph.nodes.values()]
    .map(n => `<option value="${n.id}">${n.name}</option>`).join('');

  const selects = ['edge-from', 'edge-to', 'route-source', 'route-target'];
  for (const id of selects){
    const el = document.getElementById(id);
    const prev = el.value;
    el.innerHTML = nodeOptions || '<option value="">— no stations yet —</option>';
    if ([...el.options].some(o => o.value === prev)) el.value = prev;
  }
}

function setMsg(elId, text, kind){
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = 'field-msg' + (kind ? ` ${kind}` : '');
}

/* ---- Add station ---- */
document.getElementById('btn-add-node').addEventListener('click', () => {
  const nameInput = document.getElementById('node-name');
  const descInput = document.getElementById('node-desc');
  const name = nameInput.value.trim();

  if (!name){ setMsg('node-msg', 'Enter a station name.', 'error'); return; }
  if (Graph.nodeByName(name)){ setMsg('node-msg', 'A station with that name already exists.', 'error'); return; }

  const count = Graph.nodes.size;
  const x = 180 + (count % 5) * 260;
  const y = 140 + Math.floor(count / 5) * 220;
  Graph.addNode(name, descInput.value, x, y);

  nameInput.value = ''; descInput.value = '';
  setMsg('node-msg', `Added "${name}".`, 'success');
  populateSelects(); renderGraph(); updateStats();
});

/* ---- Add connection ---- */
document.getElementById('btn-add-edge').addEventListener('click', () => {
  const fromId = document.getElementById('edge-from').value;
  const toId = document.getElementById('edge-to').value;
  const mode = document.getElementById('edge-mode').value;
  const time = parseFloat(document.getElementById('edge-time').value);
  const fare = parseFloat(document.getElementById('edge-fare').value);
  const distance = parseFloat(document.getElementById('edge-distance').value);

  if (!fromId || !toId){ setMsg('edge-msg', 'Add at least two stations first.', 'error'); return; }
  if (fromId === toId){ setMsg('edge-msg', 'From and To must be different stations.', 'error'); return; }
  if (!(time > 0)){ setMsg('edge-msg', 'Time must be greater than 0.', 'error'); return; }
  if (!(fare >= 0)){ setMsg('edge-msg', 'Fare must be 0 or more.', 'error'); return; }
  if (!(distance > 0)){ setMsg('edge-msg', 'Distance must be greater than 0.', 'error'); return; }
  if (Graph.edgeExists(fromId, toId, mode)){
    setMsg('edge-msg', `A ${mode} connection already exists between these stations.`, 'error'); return;
  }

  Graph.addEdge(fromId, toId, mode, time, fare, distance);
  setMsg('edge-msg', 'Connection added.', 'success');
  renderGraph(); updateStats();
});

/* ---- Find route ---- */
document.getElementById('btn-find-route').addEventListener('click', () => {
  const sourceId = document.getElementById('route-source').value;
  const targetId = document.getElementById('route-target').value;
  const criterion = document.querySelector('input[name="criterion"]:checked').value;

  if (!sourceId || !targetId){ setMsg('route-msg', 'Choose a source and destination.', 'error'); return; }
  if (sourceId === targetId){ setMsg('route-msg', 'Source and destination must differ.', 'error'); return; }

  const result = runDijkstra(sourceId, criterion, { recordSteps: false });
  const path = reconstructPath(result.previous, sourceId, targetId);

  clearNodeVisualState();
  if (!path){
    setMsg('route-msg', 'No route exists between these stations.', 'error');
    highlightedEdgeIds = new Set();
    document.getElementById('route-result').innerHTML =
      '<p class="empty-state">No path found — these stations are not connected.</p>';
    renderGraph();
  } else {
    setMsg('route-msg', '', '');
    highlightedEdgeIds = new Set(path.edgeIds);
    path.nodeIds.forEach((id, i) => {
      nodeVisualState[id] = (i === 0) ? 'source' : (i === path.nodeIds.length - 1) ? 'path' : 'path';
    });
    renderGraph();
    renderRouteResult(path, criterion);
  }

  updateStats(result);
});

function renderRouteResult(path, criterion){
  const { edges, totals, transfers } = summarizePath(path.edgeIds);
  const nodes = path.nodeIds.map(id => Graph.nodes.get(id));

  let chainHtml = `<div class="route-chain"><span class="route-node endpoint">${nodes[0].name}</span>`;
  edges.forEach((edge, i) => {
    chainHtml += `
      <div class="route-hop">
        <span>${MODE_ICON[edge.mode]}</span>
        <span class="hop-mode">${edge.mode} · ${edge.time}m · ₹${edge.fare} · ${edge.distance}km</span>
      </div>
      <span class="route-node ${i === edges.length - 1 ? 'endpoint' : ''}">${nodes[i + 1].name}</span>`;
  });
  chainHtml += `</div>`;

  const metricsHtml = `
    <div class="route-metrics">
      <div class="metric ${criterion === 'time' ? 'optimized' : ''}"><span class="m-val">${totals.time}</span><span class="m-lab">Minutes</span></div>
      <div class="metric ${criterion === 'fare' ? 'optimized' : ''}"><span class="m-val">₹${totals.fare}</span><span class="m-lab">Fare</span></div>
      <div class="metric ${criterion === 'distance' ? 'optimized' : ''}"><span class="m-val">${totals.distance.toFixed(1)}</span><span class="m-lab">Km</span></div>
      <div class="metric"><span class="m-val">${transfers}</span><span class="m-lab">Transfers</span></div>
    </div>`;

  document.getElementById('route-result').innerHTML = chainHtml + metricsHtml;
}

/* ---- Clear graph / load example ---- */
document.getElementById('btn-clear-graph').addEventListener('click', () => {
  if (Graph.nodes.size === 0) return;
  if (!confirm('Clear the entire graph? This cannot be undone.')) return;
  Graph.reset();
  clearNodeVisualState();
  highlightedEdgeIds = new Set();
  stopAnimation();
  populateSelects(); renderGraph(); updateStats();
  document.getElementById('route-result').innerHTML = '<p class="empty-state">Add stations and connections, then find a route.</p>';
  setMsg('route-msg', '', '');
  resetVizPanel();
});

document.getElementById('btn-load-example').addEventListener('click', () => {
  loadExampleGraph();
  populateSelects(); renderGraph(); updateStats();
});

/* ==========================================================================
   ALGORITHM ANIMATION
   Pre-computes the full step trace, then steps through it either one at a
   time (Step) or automatically on an interval (Play/Pause).
   ========================================================================== */

let animSteps = [];
let animIndex = -1;
let animTimer = null;
let animSourceId = null;

document.getElementById('btn-animate').addEventListener('click', () => {
  const sourceId = document.getElementById('route-source').value;
  if (!sourceId){ setMsg('route-msg', 'Choose a source station to animate from.', 'error'); return; }
  const criterion = document.querySelector('input[name="criterion"]:checked').value;

  const result = runDijkstra(sourceId, criterion, { recordSteps: true });
  animSteps = result.steps;
  animIndex = -1;
  animSourceId = sourceId;
  clearNodeVisualState();
  highlightedEdgeIds = new Set();
  renderGraph();
  resetVizPanel();
  document.querySelector('#viz-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('viz-step').addEventListener('click', stepAnimation);
document.getElementById('viz-play').addEventListener('click', playAnimation);
document.getElementById('viz-pause').addEventListener('click', stopAnimation);
document.getElementById('viz-reset').addEventListener('click', () => {
  stopAnimation();
  animIndex = -1;
  clearNodeVisualState();
  highlightedEdgeIds = new Set();
  renderGraph();
  resetVizPanel();
});

function playAnimation(){
  if (animSteps.length === 0) return;
  stopAnimation();
  animTimer = setInterval(() => {
    const more = stepAnimation();
    if (!more) stopAnimation();
  }, 850);
}

function stopAnimation(){
  if (animTimer){ clearInterval(animTimer); animTimer = null; }
}

/** Advances the animation by exactly one recorded step. Returns false when done. */
function stepAnimation(){
  if (animIndex >= animSteps.length - 1) return false;
  animIndex++;
  const step = animSteps[animIndex];
  applyAnimationStep(step);
  return animIndex < animSteps.length - 1;
}

function applyAnimationStep(step){
  // Update node visual states.
  clearNodeVisualState();
  step.visited.forEach(id => { nodeVisualState[id] = 'visited'; });
  if (animSourceId) nodeVisualState[animSourceId] = 'source';
  nodeVisualState[step.node || step.to] = 'current';

  // Highlight the edge currently being relaxed (if any).
  highlightedEdgeIds = step.type === 'relax' ? new Set([step.edgeId]) : new Set();

  renderGraph();
  updateVizPanel(step);
}

function updateVizPanel(step){
  document.getElementById('viz-current').textContent =
    Graph.nodes.get(step.node || step.to)?.name || '—';

  document.getElementById('viz-visited').textContent =
    step.visited.map(id => Graph.nodes.get(id)?.name).filter(Boolean).join(', ') || '—';

  if (step.type === 'relax'){
    const from = Graph.nodes.get(step.from)?.name;
    const to = Graph.nodes.get(step.to)?.name;
    const verdict = step.improved ? `→ new distance ${round(step.newDist)}` : `→ no improvement`;
    document.getElementById('viz-relaxing').textContent = `${from} → ${to} ${verdict}`;
  } else {
    document.getElementById('viz-relaxing').textContent = `visiting ${Graph.nodes.get(step.node)?.name}`;
  }

  const table = document.getElementById('viz-dist-table');
  table.innerHTML = '';
  for (const node of Graph.nodes.values()){
    const d = step.distances[node.id];
    const finite = Number.isFinite(d);
    const chip = document.createElement('span');
    chip.className = 'dist-chip ' + (finite ? 'finite' : 'inf');
    chip.textContent = `${node.name}: ${finite ? round(d) : '∞'}`;
    table.appendChild(chip);
  }
}

function resetVizPanel(){
  document.getElementById('viz-current').textContent = '—';
  document.getElementById('viz-visited').textContent = '—';
  document.getElementById('viz-relaxing').textContent = '—';
  document.getElementById('viz-dist-table').innerHTML = '';
}

function clearNodeVisualState(){ nodeVisualState = {}; }

/* ==========================================================================
   EXAMPLE GRAPH
   A 10-station network with six transport modes, deliberately built so the
   fastest, cheapest, and shortest-distance routes between the same two
   stations can genuinely differ.
   ========================================================================== */

function loadExampleGraph(){
  Graph.reset();

  const positions = {
    'Home':            [150, 150],
    'Bus Stop A':      [400, 150],
    'Central Station': [650, 230],
    'Metro Station B': [900, 230],
    'University':      [1150, 230],
    'Riverside Park':  [900, 480],
    'Old Town':        [650, 480],
    'Airport':         [650, 780],
    'Tech Park':       [1150, 480],
    'Lakeview':        [1150, 730]
  };
  const descriptions = {
    'Home': 'Residential start point',
    'Central Station': 'Main interchange hub',
    'University': 'Campus terminus',
    'Airport': 'International terminal'
  };

  const ids = {};
  for (const [name, [x, y]] of Object.entries(positions)){
    const node = Graph.addNode(name, descriptions[name] || '', x, y);
    ids[name] = node.id;
  }

  const link = (a, b, mode, time, fare, distance) =>
    Graph.addEdge(ids[a], ids[b], mode, time, fare, distance);

  link('Home', 'Bus Stop A', 'Walking', 7, 0, 0.5);
  link('Bus Stop A', 'Central Station', 'Bus', 12, 15, 3.2);
  link('Home', 'Central Station', 'Taxi', 10, 120, 4.0);
  link('Central Station', 'Metro Station B', 'Metro', 6, 20, 2.1);
  link('Bus Stop A', 'Metro Station B', 'Bus', 18, 18, 5.0);
  link('Metro Station B', 'University', 'Walking', 9, 0, 0.8);
  link('Central Station', 'University', 'Train', 15, 35, 8.5);
  link('Metro Station B', 'Riverside Park', 'Bicycle', 14, 0, 3.3);
  link('Riverside Park', 'Old Town', 'Walking', 20, 0, 1.6);
  link('Old Town', 'University', 'Bus', 10, 12, 2.4);
  link('Central Station', 'Old Town', 'Metro', 8, 22, 3.0);
  link('Old Town', 'Airport', 'Taxi', 25, 200, 14.0);
  link('University', 'Tech Park', 'Bus', 16, 14, 6.2);
  link('Tech Park', 'Lakeview', 'Bicycle', 22, 0, 5.5);
  link('Lakeview', 'Airport', 'Taxi', 30, 250, 18.0);
  link('Metro Station B', 'Tech Park', 'Metro', 11, 25, 4.8);

  clearNodeVisualState();
  highlightedEdgeIds = new Set();
  document.getElementById('route-result').innerHTML =
    '<p class="empty-state">Example network loaded. Pick a source and destination, then find a route.</p>';
}

/* ==========================================================================
   UTILITY FUNCTIONS
   ========================================================================== */

function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
function round(v){ return Math.round(v * 100) / 100; }
function truncate(str, max){ return str.length > max ? str.slice(0, max - 1) + '…' : str; }

function updateStats(lastRun){
  document.getElementById('stat-nodes').textContent = Graph.nodes.size;
  document.getElementById('stat-edges').textContent = Graph.edges.length;
  const modesUsed = new Set(Graph.edges.map(e => e.mode));
  document.getElementById('stat-modes').textContent = modesUsed.size;

  if (lastRun){
    document.getElementById('stat-visited').textContent = lastRun.nodesVisited;
    document.getElementById('stat-relaxed').textContent = lastRun.edgesRelaxed;
    document.getElementById('stat-time').textContent = `${round(lastRun.executionTime)} ms`;
  }
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

(function init(){
  loadExampleGraph();
  populateSelects();
  renderGraph();
  updateStats();
})();