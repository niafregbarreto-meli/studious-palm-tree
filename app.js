// ─── Bingo Hora a Hora — App ───────────────────────────────────────────────

const $ = id => document.getElementById(id);

let refreshTimer    = null;
let countdownTimer  = null;
let secondsLeft     = CONFIG.refreshIntervalMs / 1000;
let lastData        = null; // cache para não apagar tela em falha

// ── Formatação ───────────────────────────────────────────────────────────────

function fmtBRL(valor) {
  const num = parseFloat((valor || '0').replace(',', '.'));
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
}

function fmtMinutos(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

// Converte "AM1_1" → "A1", "PM1_2" → "P2", "SD_3" → "S3"
function simplifyRota(rotapl) {
  if (!rotapl || rotapl === 'SEM_ROTA') return rotapl;
  // Pega a letra inicial do ciclo + número após o último underscore
  const parts = rotapl.split('_');
  const letra = parts[0][0]; // A, P, S
  const num   = parts[parts.length - 1];
  return `${letra}${num}`;
}

// ── Agrupamento ──────────────────────────────────────────────────────────────

function groupByRota(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.ROTAPL;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  // Ordena por valor desc dentro de cada grupo (a SQL já faz isso, mas garante client-side)
  for (const [, list] of map) {
    list.sort((a, b) => parseFloat((b.VALOR_NUM || 0)) - parseFloat((a.VALOR_NUM || 0)));
  }
  return map;
}

// ── DOM ───────────────────────────────────────────────────────────────────────

function createPackageRow(row) {
  const min     = parseInt(row.minutos_parado, 10);
  const cls     = min >= CONFIG.criticalThresholdMin ? 'bingo-critical'
                : min >= CONFIG.warningThresholdMin  ? 'bingo-warning'
                : '';
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  tr.innerHTML = `
    <td class="col-id">${row.ID}</td>
    <td class="col-valor">${fmtBRL(row.VALOR)}</td>
    <td class="col-conteudo" title="${row.CONTEUDO || ''}">${row.CONTEUDO || '—'}</td>
    <td class="col-hora">${row.hora_entrada || '—'}</td>
    <td class="col-tempo">${fmtMinutos(min)}</td>
  `;
  return tr;
}

function createRouteSection(rotapl, rows) {
  const totalVal = rows.reduce((s, r) => s + parseFloat((r.VALOR_NUM || 0)), 0);
  const maxMin   = Math.max(...rows.map(r => parseInt(r.minutos_parado, 10)));
  const hasCrit  = maxMin >= CONFIG.criticalThresholdMin;
  const simple   = simplifyRota(rotapl);

  const section = document.createElement('section');
  section.className = `route-card${hasCrit ? ' has-critical' : ''}`;
  section.dataset.rotapl = rotapl;

  const header = document.createElement('header');
  header.className = 'route-header';
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'true');
  header.innerHTML = `
    <span class="route-label">
      <span class="route-simple">${simple}</span>
      <span class="route-full">${rotapl}</span>
    </span>
    <span class="route-stats">
      <span class="stat-count">${rows.length} pacote${rows.length !== 1 ? 's' : ''}</span>
      <span class="stat-value">${fmtBRL(totalVal)}</span>
      <span class="stat-max-time">${fmtMinutos(maxMin)} parado</span>
    </span>
    <span class="toggle-icon">▾</span>
  `;
  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    section.classList.toggle('collapsed', expanded);
  });

  const table = document.createElement('table');
  table.className = 'package-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>ID Pacote</th>
        <th>Valor</th>
        <th>Conteúdo</th>
        <th>Entrada</th>
        <th>Tempo parado</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  rows.forEach(r => tbody.appendChild(createPackageRow(r)));
  table.appendChild(tbody);

  section.appendChild(header);
  section.appendChild(table);
  return section;
}

function render(rows) {
  const container = $('route-container');
  // Limpa apenas as route-cards (preserva #empty-state)
  container.querySelectorAll('.route-card').forEach(el => el.remove());

  $('empty-state').hidden = rows.length > 0;

  if (rows.length === 0) return;

  const grouped = groupByRota(rows);

  // Ordena rotas: SEM_ROTA por último
  const sortedKeys = [...grouped.keys()].sort((a, b) => {
    if (a === 'SEM_ROTA') return 1;
    if (b === 'SEM_ROTA') return -1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    container.appendChild(createRouteSection(key, grouped.get(key)));
  }

  // Resumo global
  const totalCount = rows.length;
  const totalVal   = rows.reduce((s, r) => s + parseFloat((r.VALOR_NUM || 0)), 0);
  $('total-count').textContent  = totalCount;
  $('total-value').textContent  = fmtBRL(totalVal);
  $('total-routes').textContent = grouped.size;
}

// ── Refresh ───────────────────────────────────────────────────────────────────

function showLoading(on) {
  $('loading-overlay').hidden = !on;
}

function showError(msg) {
  const toast = $('error-toast');
  toast.textContent = `⚠ ${msg}`;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 8000);
}

function updateLastRefresh() {
  const now = new Date();
  $('last-refresh').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function startCountdown() {
  clearInterval(countdownTimer);
  secondsLeft = CONFIG.refreshIntervalMs / 1000;
  countdownTimer = setInterval(() => {
    secondsLeft--;
    const m = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
    const s = String(secondsLeft % 60).padStart(2, '0');
    $('countdown').textContent = `${m}:${s}`;
    if (secondsLeft <= 0) clearInterval(countdownTimer);
  }, 1000);
}

async function refresh() {
  showLoading(true);
  try {
    const rows = await BQ.fetchBingoData();
    lastData   = rows;
    render(rows);
    updateLastRefresh();
    startCountdown();
  } catch (err) {
    console.error('[Bingo] Erro ao buscar dados:', err);
    showError(err.message || 'Erro ao consultar BigQuery.');
    // Mantém os dados anteriores na tela
    if (lastData) render(lastData);
  } finally {
    showLoading(false);
  }
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, CONFIG.refreshIntervalMs);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('btn-refresh').addEventListener('click', () => {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refresh().then(startAutoRefresh);
  });

  refresh().then(startAutoRefresh);
});
