// ─── BigQuery REST API ─────────────────────────────────────────────────────
const BQ = (() => {

  // Tenta obter o token OAuth da sessão do grid.adminml.com
  function getAuthToken() {
    // grid.adminml.com pode expor o token via meta tag ou variável global
    if (window.__GRID_AUTH_TOKEN__) return window.__GRID_AUTH_TOKEN__;
    const meta = document.querySelector('meta[name="auth-token"]');
    if (meta) return meta.content;
    throw new Error('Token de autenticação não encontrado. Verifique a integração com grid.adminml.com.');
  }

  const BASE = `https://bigquery.googleapis.com/bigquery/v2/projects/${CONFIG.bq.projectId}`;

  async function apiFetch(path, opts = {}) {
    const token = getAuthToken();
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Monta a SQL do Bingo com os parâmetros do CONFIG
  function buildBingoSQL() {
    const cyclesLiteral = CONFIG.cycles.map(c => `'${c}'`).join(', ');
    return `
DECLARE tz          STRING  DEFAULT '${CONFIG.timezone}';
DECLARE site_id     STRING  DEFAULT '${CONFIG.siteId}';
DECLARE facility_id STRING  DEFAULT '${CONFIG.facilityId}';
DECLARE cycles      ARRAY<STRING> DEFAULT [${cyclesLiteral}];
DECLARE ope_date    DATE    DEFAULT CURRENT_DATE(tz);
DECLARE perf_date   DATETIME DEFAULT DATETIME_SUB(CAST(ope_date AS DATETIME), INTERVAL 3 DAY);
DECLARE bingo_min   INT64   DEFAULT ${CONFIG.bingoThresholdMin};

WITH rotas_filtradas AS (
  SELECT
    r.RTG_ROUTE_UUID,
    CASE
      WHEN ARRAY_LENGTH(SPLIT(r.RTG_ROUTE_NAME, '_')) >= 2
      THEN CONCAT(SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(0)], '_', SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(1)])
      ELSE r.RTG_ROUTE_NAME
    END AS ROTAPL
  FROM \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE\` r
  WHERE r.SIT_SITE_ID          = site_id
    AND r.SHP_FACILITY_ID      = facility_id
    AND r.SHP_CYCLE.name       IN UNNEST(cycles)
    AND r.RTG_ROUTE_STATUS     = 'planned'
    AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
    AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),
atrelados AS (
  SELECT DISTINCT SAFE_CAST(sau.RTG_UNIT_EXTERNAL_ID AS INT64) AS shipment_id
  FROM rotas_filtradas rf
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP\` s
      ON s.RTG_ROUTE_UUID = rf.RTG_ROUTE_UUID AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION\` sa
      ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT\` sau
      ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
      AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
      AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
      AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
),
id_com_rota AS (
  SELECT
    SAFE_CAST(sau.RTG_UNIT_EXTERNAL_ID AS INT64) AS shipment_id,
    rf.ROTAPL
  FROM rotas_filtradas rf
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP\` s
      ON s.RTG_ROUTE_UUID = rf.RTG_ROUTE_UUID AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION\` sa
      ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT\` sau
      ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
      AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
      AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
      AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY sau.RTG_UNIT_EXTERNAL_ID ORDER BY rf.ROTAPL) = 1
),
at_station AS (
  SELECT
    SHI.SHP_SHIPMENT_ID,
    SHI.SHP_ORDER_COST AS VALOR,
    (SELECT MAX(ITE.SHP_ITEM_DESC) FROM UNNEST(SHI.ITEMS) ITE) AS CONTEUDO,
    SHI.SHP_LAST_STATUS_CHANGE AS entrou_station_at,
    TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), SHI.SHP_LAST_STATUS_CHANGE, MINUTE) AS minutos_na_station
  FROM \`meli-bi-data.WHOWNER.BT_SHP_SHIPMENTS\` SHI
  WHERE SHI.SHP_STATUS    = 'sorting'
    AND SHI.SHP_SUBSTATUS = 'at_station'
    AND DATE(SHI.SHP_LAST_STATUS_CHANGE, tz) = ope_date
    AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), SHI.SHP_LAST_STATUS_CHANGE, MINUTE) > bingo_min
),
bingo AS (
  SELECT
    ats.SHP_SHIPMENT_ID AS ID,
    COALESCE(r.ROTAPL, 'SEM_ROTA') AS ROTAPL,
    ats.VALOR,
    ats.CONTEUDO,
    ats.entrou_station_at,
    ats.minutos_na_station
  FROM at_station ats
  LEFT JOIN atrelados atr ON atr.shipment_id = ats.SHP_SHIPMENT_ID
  LEFT JOIN id_com_rota r ON r.shipment_id   = ats.SHP_SHIPMENT_ID
  WHERE atr.shipment_id IS NULL
)
SELECT
  CAST(ID AS STRING) AS ID,
  ROTAPL,
  REPLACE(FORMAT('%.2f', COALESCE(VALOR, 0)), '.', ',') AS VALOR,
  COALESCE(VALOR, 0) AS VALOR_NUM,
  CONTEUDO,
  FORMAT_TIMESTAMP('%H:%M', entrou_station_at, tz) AS hora_entrada,
  minutos_na_station AS minutos_parado
FROM bingo
ORDER BY ROTAPL ASC, COALESCE(VALOR, 0) DESC
    `.trim();
  }

  async function runQuery(sql) {
    const body = {
      configuration: {
        query: {
          query: sql,
          useLegacySql: false,
          location: CONFIG.bq.location,
          maximumBytesBilled: String(CONFIG.bq.maxBytesBilled),
        },
      },
    };
    const job = await apiFetch(`/jobs`, { method: 'POST', body: JSON.stringify(body) });
    return job.jobReference.jobId;
  }

  async function pollJob(jobId, maxWaitMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const status = await apiFetch(`/jobs/${jobId}`);
      if (status.status.state === 'DONE') {
        if (status.status.errorResult) {
          throw new Error(status.status.errorResult.message);
        }
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Timeout aguardando BigQuery.');
  }

  async function getResults(jobId) {
    const rows = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ maxResults: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await apiFetch(`/jobs/${jobId}/queryResults?${params}`);
      const schema = page.schema?.fields || [];
      for (const row of page.rows || []) {
        const obj = {};
        row.f.forEach((cell, i) => { obj[schema[i].name] = cell.v; });
        rows.push(obj);
      }
      pageToken = page.pageToken || null;
    } while (pageToken);
    return rows;
  }

  async function fetchBingoData() {
    const sql   = buildBingoSQL();
    const jobId = await runQuery(sql);
    await pollJob(jobId);
    return getResults(jobId);
  }

  return { fetchBingoData };
})();
