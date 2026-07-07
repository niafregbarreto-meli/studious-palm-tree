-- ============================================================
-- BINGO HORA A HORA — SSC2
-- Detecta pacotes bipados na estação há mais de 1 hora sem atelar
-- Usa LK_SHP_LG_SORTING_HISTORY (fonte real das bipagens)
-- e a lógica de Q_SEPARACAO para o nome simplificado da ROTA
-- ============================================================

DECLARE tz          STRING  DEFAULT 'America/Sao_Paulo';
DECLARE site_id     STRING  DEFAULT 'MLB';
DECLARE facility_id STRING  DEFAULT 'SSC2';

DECLARE ope_date    DATE     DEFAULT CURRENT_DATE(tz);
DECLARE perf_date   DATETIME DEFAULT DATETIME_SUB(CAST(ope_date AS DATETIME), INTERVAL 3 DAY);

-- BINGO: pacotes bipados há mais de N minutos sem atelar
DECLARE bingo_threshold_min INT64 DEFAULT 60;

-- ─────────────────────────────────────────────────────────────
-- 1. TABULEIRO DE ROTAS (lógica de Q_SEPARACAO)
--    Mapeia ROTAPL → ROTA (A1, A2, B1...) para exibição
-- ─────────────────────────────────────────────────────────────
WITH ROTAS_BASE AS (
    SELECT
        CAST(r.RTG_ROUTE_ID AS STRING)                           AS ROTANUM,
        r.RTG_ROUTE_NAME                                         AS NOME_ROTA,
        CASE
            WHEN ARRAY_LENGTH(SPLIT(r.RTG_ROUTE_NAME, '_')) >= 2
            THEN CONCAT(SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(0)], '_', SPLIT(r.RTG_ROUTE_NAME, '_')[OFFSET(1)])
            ELSE r.RTG_ROUTE_NAME
        END                                                      AS PREFIXO_MAE,
        LENGTH(r.RTG_ROUTE_NAME) - LENGTH(REPLACE(r.RTG_ROUTE_NAME, '_', ''))
                                                                 AS QTD_UNDERSCORES,
        r.SHP_CYCLE.name                                         AS CICLO,
        vt.SHP_LG_VEHICLE_TYPE                                   AS VEICULO
    FROM `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE` r
    LEFT JOIN `meli-bi-data.WHOWNER.LK_SHP_LG_VEHICLES_TYPES` vt
        ON vt.SHP_LG_VEHICLE_TYPE_ID = r.SHP_LG_VEHICLE_TYPE_ID
    WHERE r.SIT_SITE_ID          = site_id
      AND r.SHP_FACILITY_ID      = facility_id
      AND r.RTG_ROUTE_STATUS     = 'planned'
      AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
      AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),

-- ─────────────────────────────────────────────────────────────
-- 2. BIPAGENS DO DIA (fonte: LK_SHP_LG_SORTING_HISTORY)
--    Capta o ciclo real da bipagem para cruzar com o planejamento
-- ─────────────────────────────────────────────────────────────
BIPAGENS_DIA AS (
    SELECT
        CAST(h.SHP_LG_CC_EXTERNAL_REFERENCE_ID AS STRING)       AS PACOTE_ID,
        CAST(h.SHP_LG_PLANNING_ROUTE_ID AS STRING)              AS ROTANUM_HIST,
        COALESCE(
            rb.CICLO,
            CASE
                WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_AM1$') THEN 'AM1'
                WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_PM1$') THEN 'PM1'
                WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_SD$')  THEN 'SD'
                WHEN REGEXP_CONTAINS(TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT), r'_T$')   THEN 'T'
                ELSE NULL
            END
        )                                                        AS CICLO_HIST,
        h.SHP_LG_CC_ACTION_TYPE                                  AS ACAO,
        h.SHP_LG_CC_DATE_CREATED                                 AS DTTM_BIPAGEM,
        TRIM(h.SHP_SORTING_HIST_ASSIGNAMENT)                     AS ASSIGNAMENT
    FROM `meli-bi-data.WHOWNER.LK_SHP_LG_SORTING_HISTORY` h
    LEFT JOIN ROTAS_BASE rb
        ON CAST(h.SHP_LG_PLANNING_ROUTE_ID AS STRING) = rb.ROTANUM
    WHERE h.SIT_SITE_ID        = site_id
      AND h.SHP_LG_FACILITY_ID = facility_id
      AND h.SHP_LG_CC_DATE_CREATED >= CAST(ope_date AS DATETIME)
      AND h.SHP_LG_CC_ACTION_TYPE IN ('add sortable unit', 'close', 'dispatch container', 'prepare dispatch')
      AND h.SHP_LG_CC_EXTERNAL_REFERENCE_ID IS NOT NULL
      AND CAST(h.SHP_LG_CC_EXTERNAL_REFERENCE_ID AS STRING) NOT IN ('0', '')
),

-- ─────────────────────────────────────────────────────────────
-- 3. PACOTES PLANEJADOS (vínculo rota ↔ pacote)
-- ─────────────────────────────────────────────────────────────
BASE_PACOTES AS (
    SELECT DISTINCT
        CAST(r.RTG_ROUTE_ID AS STRING)              AS ROTANUM_PL,
        r.SHP_CYCLE.name                            AS CICLO_PL,
        CAST(sau.RTG_UNIT_EXTERNAL_ID AS STRING)    AS PACOTE_ID
    FROM `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE` r
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP` s
        ON s.RTG_ROUTE_UUID = r.RTG_ROUTE_UUID
        AND s.RTG_STOP_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION` sa
        ON sa.RTG_STOP_UUID = s.RTG_STOP_UUID
        AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
    INNER JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT` sau
        ON sau.RTG_ACTION_UUID = sa.RTG_ACTION_UUID
        AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= perf_date
        AND sau.RTG_UNIT_EXTERNAL_TYPE = 'shipment'
        AND sau.RTG_UNIT_EXTERNAL_ID IS NOT NULL
    WHERE r.SIT_SITE_ID          = site_id
      AND r.SHP_FACILITY_ID      = facility_id
      AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(ope_date AS DATETIME)
      AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(ope_date, INTERVAL 1 DAY) AS DATETIME)
),

-- ─────────────────────────────────────────────────────────────
-- 4. ROTA OT POR ROTANUM (igual a Q_SEPARACAO: BIPAGENS_POR_ID)
--    Descobre qual nome de OT (ex: A1_AM1) foi lido na bipagem
-- ─────────────────────────────────────────────────────────────
BIPAGENS_POR_ROTA AS (
    SELECT
        b.ROTANUM_HIST                                           AS ROTANUM,
        MAX(
            CASE
                WHEN REGEXP_CONTAINS(b.ASSIGNAMENT, r'^[A-Z0-9]+_(AM|PM|SD|T)')
                 AND NOT REGEXP_CONTAINS(b.ASSIGNAMENT, r'^\d+$')
                THEN b.ASSIGNAMENT
            END
        )                                                        AS ROTAOT_LIDA
    FROM BIPAGENS_DIA b
    INNER JOIN BASE_PACOTES p
        ON b.PACOTE_ID = p.PACOTE_ID
        AND b.CICLO_HIST = p.CICLO_PL
    WHERE b.PACOTE_ID IS NOT NULL
      AND b.PACOTE_ID NOT IN ('0', '')
    GROUP BY 1
),

-- Propaga ROTAOT pela família (mesmo PREFIXO_MAE + CICLO)
TABULEIRO AS (
    SELECT
        rb.ROTANUM,
        rb.PREFIXO_MAE                                           AS ROTAPL,
        rb.CICLO,
        rb.VEICULO,
        bpr.ROTAOT_LIDA,
        MAX(bpr.ROTAOT_LIDA) OVER (PARTITION BY rb.PREFIXO_MAE, rb.CICLO)
                                                                 AS ROTAOT
    FROM ROTAS_BASE rb
    LEFT JOIN BIPAGENS_POR_ROTA bpr ON rb.ROTANUM = bpr.ROTANUM
),

-- ─────────────────────────────────────────────────────────────
-- 5. PRIMEIRA BIPAGEM DE CADA PACOTE (quando "entrou" na estação)
-- ─────────────────────────────────────────────────────────────
PRIMEIRO_ADD AS (
    SELECT
        b.PACOTE_ID,
        b.ROTANUM_HIST,
        b.CICLO_HIST,
        MIN(b.DTTM_BIPAGEM)                                      AS entrou_station_at
    FROM BIPAGENS_DIA b
    WHERE b.ACAO = 'add sortable unit'
    GROUP BY 1, 2, 3
),

-- ─────────────────────────────────────────────────────────────
-- 6. PACOTES JÁ ATRELADOS (têm ação de fechamento/despacho)
-- ─────────────────────────────────────────────────────────────
JA_ATRELADOS AS (
    SELECT DISTINCT PACOTE_ID
    FROM BIPAGENS_DIA
    WHERE ACAO IN ('close', 'dispatch container', 'prepare dispatch')
),

-- ─────────────────────────────────────────────────────────────
-- 7. ENRIQUECER COM VALOR E CONTEÚDO (BT_SHP_SHIPMENTS)
-- ─────────────────────────────────────────────────────────────
BINGO_BASE AS (
    SELECT
        pa.PACOTE_ID                                             AS ID,
        pa.ROTANUM_HIST,
        pa.CICLO_HIST,
        pa.entrou_station_at,
        TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), pa.entrou_station_at, MINUTE)
                                                                 AS minutos_parado
    FROM PRIMEIRO_ADD pa
    -- Somente pacotes com planejamento (descarta clandestinos)
    INNER JOIN BASE_PACOTES bp
        ON pa.PACOTE_ID = bp.PACOTE_ID
        AND pa.CICLO_HIST = bp.CICLO_PL
    -- Exclui já atrelados
    LEFT JOIN JA_ATRELADOS ja ON pa.PACOTE_ID = ja.PACOTE_ID
    WHERE ja.PACOTE_ID IS NULL
      AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), pa.entrou_station_at, MINUTE) > bingo_threshold_min
),

-- ─────────────────────────────────────────────────────────────
-- 8. MONTA RESULTADO FINAL COM ROTA SIMPLIFICADA
-- ─────────────────────────────────────────────────────────────
BINGO_COMPLETO AS (
    SELECT
        b.ID,
        -- Nome simplificado (A1, B3...) vem do split do ROTAOT
        COALESCE(
            SPLIT(t.ROTAOT, '_')[SAFE_OFFSET(0)],
            t.ROTAPL,
            'SEM_ROTA'
        )                                                        AS ROTA,
        COALESCE(t.ROTAOT, t.ROTAPL, 'SEM_ROTA')               AS ROTACOMPLETA,
        t.CICLO,
        t.VEICULO,
        REPLACE(FORMAT('%.2f', COALESCE(SHI.SHP_ORDER_COST, 0)), '.', ',')
                                                                 AS VALOR,
        COALESCE(SHI.SHP_ORDER_COST, 0)                         AS VALOR_NUM,
        (SELECT MAX(ITE.SHP_ITEM_DESC) FROM UNNEST(SHI.ITEMS) ITE)
                                                                 AS CONTEUDO,
        FORMAT_TIMESTAMP('%H:%M', b.entrou_station_at, tz)      AS hora_entrada,
        b.minutos_parado
    FROM BINGO_BASE b
    LEFT JOIN TABULEIRO t
        ON b.ROTANUM_HIST = t.ROTANUM
    LEFT JOIN `meli-bi-data.WHOWNER.BT_SHP_SHIPMENTS` SHI
        ON SHI.SHP_SHIPMENT_ID = SAFE_CAST(b.ID AS INT64)
)

-- ─────────────────────────────────────────────────────────────
-- RESULTADO: agrupado por ROTA, maior valor primeiro
-- ─────────────────────────────────────────────────────────────
SELECT
    ID,
    ROTA,
    ROTACOMPLETA,
    CICLO,
    VEICULO,
    VALOR,
    VALOR_NUM,
    CONTEUDO,
    hora_entrada,
    minutos_parado
FROM BINGO_COMPLETO
ORDER BY
    CICLO       ASC,
    -- Ordena rotas: letra alfabética, depois número (A1, A2, B1...)
    REGEXP_EXTRACT(ROTA, r'^[A-Za-z]+') ASC,
    SAFE_CAST(REGEXP_EXTRACT(ROTA, r'\d+') AS INT64) ASC,
    VALOR_NUM   DESC;
