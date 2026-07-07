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

  // Monta a SQL do Bingo — usa LK_SHP_LG_SORTING_HISTORY como fonte real de bipagens
  function buildBingoSQL() {
    return `
DECLARE tz          STRING  DEFAULT '${CONFIG.timezone}';
DECLARE site_id     STRING  DEFAULT '${CONFIG.siteId}';
DECLARE facility_id STRING  DEFAULT '${CONFIG.facilityId}';
DECLARE ope_date    DATE    DEFAULT CURRENT_DATE(tz);
DECLARE perf_date   DATETIME DEFAULT DATETIME_SUB(CAST(ope_date AS DATETIME), INTERVAL 3 DAY);
DECLARE bingo_min   INT64   DEFAULT ${CONFIG.bingoThresholdMin};

WITH ROTAS_BASE AS (
  SELECT
    CAST(r.RTG_ROUTE_ID AS STRING) AS ROTANUM,
    CASE
      WHEN ARRAY_LENGTH(SPLIT(r.RTG_ROUTE_NAME, '_')) >= 2
      THEN CONCAT(SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(0)], '_', SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(1)])
      ELSE r.RTG_ROUTE_NAME
    END AS PREFIXO_MAE,
    LENGTH(r.RTG_ROUTE_NAME) - LENGTH(REPLACE(r.RTG_ROUTE_NAME, '_', '')) AS QTD_UNDERSCORES,
    r.SHP_CYCLE.name AS CICLO
  FROM \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE\` r
  WHERE r.SIT_SITE_ID      = site_id
    AND r.SHP_FACILITY_ID  = facility_id
    AND r.RTG_ROUTE_STATUS = 'planned'
    AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
    AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),
BASE_PACOTES AS (
  SELECT DISTINCT
    CAST(r.RTG_ROUTE_ID AS STRING) AS ROTANUM_PL,
    r.SHP_CYCLE.name AS CICLO_PL,
    CAST(sau.RTG_UNIT_EXTERNAL_ID AS STRING) AS PACOTE_ID
  FROM \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE\` r
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP\` s
      ON s.RTG_ROUTE_UUID = r.RTG_ROUTE_UUID AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION\` sa
      ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
  INNER JOIN \`meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT\` sau
      ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
      AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
      AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
      AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
  WHERE r.SIT_SITE_ID     = site_id
    AND r.SHP_FACILITY_ID = facility_id
    AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
    AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),
BIPAGENS_DIA AS (
  SELECT
    CAST(h.SHP_LG_CC_EXTERNAL_REFERENCE_ID AS STRING) AS PACOTE_ID,
    CAST(h.SHP_LG_PLANNING_ROUTE_ID AS STRING)        AS ROTANUM_HIST,
    COALESCE(
      rb.CICLO,
      CASE
        WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_AM1$') THEN 'AM1'
        WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_PM1$') THEN 'PM1'
        WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_SD$')  THEN 'SD'
        WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_T$')   THEN 'T'
        ELSE NULL
      END
    )                                                  AS CICLO_HIST,
    h.SHP_LG_CC_ACTION_TYPE                            AS ACAO,
    h.SHP_LG_CC_DATE_CREATED                           AS DTTM_BIPAGEM,
    TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT)               AS ASSIGNAMENT
  FROM \`meli-bi-data.WHOWNER.LK_SHP_LG_SORTING_HISTORY\` h
  LEFT JOIN ROTAS_BASE rb ON CAST(h.SHP_LG_PLANNING_ROUTE_ID AS STRING) = rb.ROTANUM
  WHERE h.SIT_SITE_ID        = site_id
    AND h.SHP_LG_FACILITY_ID = facility_id
    AND h.SHP_LG_CC_DATE_CREATED >= CAST(ope_date AS DATETIME)
    AND h.SHP_LG_CC_ACTION_TYPE IN ('add sortable unit','close','dispatch container','prepare dispatch')
    AND h.SHP_LG_CC_EXTERNAL_REFERENCE_ID IS NOT NULL
    AND CAST(h.SHP_LG_CC_EXTERNAL_REFERENCE_ID AS STRING) NOT IN ('0','')
),
BIPAGENS_POR_ROTA AS (
  SELECT
    b.ROTANUM_HIST AS ROTANUM,
    MAX(CASE
      WHEN REGEXP_CONTAINS(b.ASSIGNAMENT, r'^[A-Z0-9]+_(AM|PM|SD|T)')
       AND NOT REGEXP_CONTAINS(b.ASSIGNAMENT, r'^\d+$')
      THEN b.ASSIGNAMENT
    END) AS ROTAOT_LIDA
  FROM BIPAGENS_DIA b
  INNER JOIN BASE_PACOTES p ON b.PACOTE_ID = p.PACOTE_ID AND b.CICLO_HIST = p.CICLO_PL
  GROUP BY 1
),
TABULEIRO AS (
  SELECT
    rb.ROTANUM,
    rb.PREFIXO_MAE AS ROTAPL,
    rb.CICLO,
    MAX(bpr.ROTAOT_LIDA) OVER (PARTITION BY rb.PREFIXO_MAE, rb.CICLO) AS ROTAOT
  FROM ROTAS_BASE rb
  LEFT JOIN BIPAGENS_POR_ROTA bpr ON rb.ROTANUM = bpr.ROTANUM
),
PRIMEIRO_ADD AS (
  SELECT
    b.PACOTE_ID,
    b.ROTANUM_HIST,
    b.CICLO_HIST,
    MIN(b.DTTM_BIPAGEM) AS entrou_station_at
  FROM BIPAGENS_DIA b
  WHERE b.ACAO = 'add sortable unit'
  GROUP BY 1,2,3
),
JA_ATRELADOS AS (
  SELECT DISTINCT PACOTE_ID
  FROM BIPAGENS_DIA
  WHERE ACAO IN ('close','dispatch container','prepare dispatch')
),
BINGO_BASE AS (
  SELECT
    pa.PACOTE_ID AS ID,
    pa.ROTANUM_HIST,
    pa.CICLO_HIST,
    pa.entrou_station_at,
    TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), pa.entrou_station_at, MINUTE) AS minutos_parado
  FROM PRIMEIRO_ADD pa
  INNER JOIN BASE_PACOTES bp ON pa.PACOTE_ID = bp.PACOTE_ID AND pa.CICLO_HIST = bp.CICLO_PL
  LEFT JOIN JA_ATRELADOS ja ON pa.PACOTE_ID = ja.PACOTE_ID
  WHERE ja.PACOTE_ID IS NULL
    AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), pa.entrou_station_at, MINUTE) > bingo_min
)
SELECT
  b.ID,
  COALESCE(SPLIT(t.ROTAOT,'_')[SAFE_OFFSET(0)], t.ROTAPL, 'SEM_ROTA') AS ROTA,
  COALESCE(t.ROTAOT, t.ROTAPL, 'SEM_ROTA')                             AS ROTACOMPLETA,
  b.CICLO_HIST                                                          AS CICLO,
  REPLACE(FORMAT('%.2f', COALESCE(SHI.SHP_ORDER_COST,0)),'.',',' )     AS VALOR,
  COALESCE(SHI.SHP_ORDER_COST, 0)                                       AS VALOR_NUM,
  (SELECT MAX(ITE.SHP_ITEM_DESC) FROM UNNEST(SHI.ITEMS) ITE)           AS CONTEUDO,
  FORMAT_TIMESTAMP('%H:%M', b.entrou_station_at, tz)                    AS hora_entrada,
  b.minutos_parado
FROM BINGO_BASE b
LEFT JOIN TABULEIRO t ON b.ROTANUM_HIST = t.ROTANUM
LEFT JOIN \`meli-bi-data.WHOWNER.BT_SHP_SHIPMENTS\` SHI
    ON SHI.SHP_SHIPMENT_ID = SAFE_CAST(b.ID AS INT64)
ORDER BY
  b.CICLO_HIST ASC,
  REGEXP_EXTRACT(COALESCE(SPLIT(t.ROTAOT,'_')[SAFE_OFFSET(0)], t.ROTAPL,''), r'^[A-Za-z]+') ASC,
  SAFE_CAST(REGEXP_EXTRACT(COALESCE(SPLIT(t.ROTAOT,'_')[SAFE_OFFSET(0)], t.ROTAPL,''), r'\d+') AS INT64) ASC,
  COALESCE(SHI.SHP_ORDER_COST, 0) DESC
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
