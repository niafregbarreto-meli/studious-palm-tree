-- ============================================================
-- BINGO HORA A HORA - SSC2
-- Detecta pacotes em at_station há mais de 1 hora sem atelar
-- ============================================================

DECLARE tz         STRING   DEFAULT 'America/Sao_Paulo';
DECLARE site_id    STRING   DEFAULT 'MLB';
DECLARE facility_id STRING  DEFAULT 'SSC2';
DECLARE cycles     ARRAY<STRING> DEFAULT ['AM1', 'PM1', 'SD'];

DECLARE ope_date   DATE     DEFAULT CURRENT_DATE(tz);
DECLARE perf_date  DATETIME DEFAULT DATETIME_SUB(CAST(ope_date AS DATETIME), INTERVAL 3 DAY);

-- Threshold: pacotes parados há mais de N minutos
DECLARE bingo_threshold_min INT64 DEFAULT 60;

-- ─────────────────────────────────────────────────────────────
-- 1. ROTAS DO DIA (igual ao padrão das queries existentes)
-- ─────────────────────────────────────────────────────────────
WITH rotas_filtradas AS (
    SELECT
        r.RTG_ROUTE_UUID,
        -- Prefixo legível: AM1_1 → mantém os dois primeiros segmentos
        CASE
            WHEN ARRAY_LENGTH(SPLIT(r.RTG_ROUTE_NAME, '_')) >= 2
            THEN CONCAT(
                SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(0)], '_',
                SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(1)]
            )
            ELSE r.RTG_ROUTE_NAME
        END AS ROTAPL
    FROM `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE` r
    WHERE r.SIT_SITE_ID          = site_id
      AND r.SHP_FACILITY_ID      = facility_id
      AND r.SHP_CYCLE.name       IN UNNEST(cycles)
      AND r.RTG_ROUTE_STATUS     = 'planned'
      AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
      AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),

-- ─────────────────────────────────────────────────────────────
-- 2. IDs JÁ ATRELADOS (presentes nas rotas planejadas)
-- ─────────────────────────────────────────────────────────────
atrelados AS (
    SELECT DISTINCT
        SAFE_CAST(sau.RTG_UNIT_EXTERNAL_ID AS INT64) AS shipment_id
    FROM rotas_filtradas rf
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP` s
        ON s.RTG_ROUTE_UUID = rf.RTG_ROUTE_UUID
        AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION` sa
        ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID
        AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT` sau
        ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
        AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
        AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
        AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
),

-- ─────────────────────────────────────────────────────────────
-- 3. ROTA POR ID (para mostrar qual rota estava prevista)
-- ─────────────────────────────────────────────────────────────
id_com_rota AS (
    SELECT
        SAFE_CAST(sau.RTG_UNIT_EXTERNAL_ID AS INT64) AS shipment_id,
        rf.ROTAPL
    FROM rotas_filtradas rf
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP` s
        ON s.RTG_ROUTE_UUID = rf.RTG_ROUTE_UUID
        AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION` sa
        ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID
        AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT` sau
        ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
        AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
        AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
        AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY sau.RTG_UNIT_EXTERNAL_ID ORDER BY rf.ROTAPL) = 1
),

-- ─────────────────────────────────────────────────────────────
-- 4. PACOTES EM at_station HÁ MAIS DE bingo_threshold_min
-- ─────────────────────────────────────────────────────────────
at_station AS (
    SELECT
        SHI.SHP_SHIPMENT_ID,
        SHI.SHP_ORDER_COST                                          AS VALOR,
        (SELECT MAX(ITE.SHP_ITEM_DESC) FROM UNNEST(SHI.ITEMS) ITE) AS CONTEUDO,
        SHI.SHP_LAST_STATUS_CHANGE                                  AS entrou_station_at,
        TIMESTAMP_DIFF(
            CURRENT_TIMESTAMP(),
            SHI.SHP_LAST_STATUS_CHANGE,
            MINUTE
        )                                                           AS minutos_na_station
    FROM `meli-bi-data.WHOWNER.BT_SHP_SHIPMENTS` SHI
    WHERE SHI.SHP_STATUS    = 'sorting'
      AND SHI.SHP_SUBSTATUS = 'at_station'
      -- Apenas pacotes de hoje (evita varrer partições antigas)
      AND DATE(SHI.SHP_LAST_STATUS_CHANGE, tz) = ope_date
      -- BINGO: parado mais do que o threshold
      AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), SHI.SHP_LAST_STATUS_CHANGE, MINUTE) > bingo_threshold_min
),

-- ─────────────────────────────────────────────────────────────
-- 5. BINGO = at_station E NÃO atrelado
-- ─────────────────────────────────────────────────────────────
bingo AS (
    SELECT
        ats.SHP_SHIPMENT_ID                     AS ID,
        COALESCE(r.ROTAPL, 'SEM_ROTA')          AS ROTAPL,
        ats.VALOR,
        ats.CONTEUDO,
        ats.entrou_station_at,
        ats.minutos_na_station
    FROM at_station ats
    -- Exclui os que já foram atrelados
    LEFT JOIN atrelados atr ON atr.shipment_id = ats.SHP_SHIPMENT_ID
    -- Traz a rota prevista (se tiver)
    LEFT JOIN id_com_rota r ON r.shipment_id   = ats.SHP_SHIPMENT_ID
    WHERE atr.shipment_id IS NULL
)

-- ─────────────────────────────────────────────────────────────
-- RESULTADO FINAL
-- Agrupado por rota, ordenado pelo maior valor dentro de cada rota
-- ─────────────────────────────────────────────────────────────
SELECT
    ID,
    ROTAPL,
    REPLACE(FORMAT('%.2f', COALESCE(VALOR, 0)), '.', ',') AS VALOR,
    CONTEUDO,
    FORMAT_TIMESTAMP('%H:%M', entrou_station_at, tz)       AS hora_entrada,
    minutos_na_station                                     AS minutos_parado
FROM bingo
ORDER BY
    ROTAPL           ASC,
    COALESCE(VALOR, 0) DESC;
