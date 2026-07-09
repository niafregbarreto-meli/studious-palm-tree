/**
 * Bingo Hora a Hora — Atualização automática da aba DADOS (sem clicar em
 * "Extrair" manualmente).
 *
 * Substitui a extração manual do Connected Sheets: este script roda a
 * consulta diretamente no BigQuery (usando o serviço avançado "BigQuery",
 * com o acesso já delegado da sua conta) e escreve o resultado na aba
 * "DADOS" da mesma planilha, no formato que o index.html espera:
 *   SHP_SHIPMENT_ID | MOEDA_LOCAL | SHP_ITEM_DESC | ENTROU_STATION
 *
 * INSTALAÇÃO (uma vez):
 * 1. No editor de Apps Script (o mesmo projeto do Codigo.gs), adicione este
 *    arquivo: "+" ao lado de "Arquivos" → Script → cole este conteúdo.
 * 2. Ative o serviço avançado do BigQuery:
 *    Editor → ícone "+" ao lado de "Serviços" → BigQuery API → Adicionar.
 * 3. Confirme/ajuste PROJECT_ID abaixo (o projeto do BigQuery a faturar —
 *    use "meli-bi-data" ou o projeto onde sua conta já tem cota).
 * 4. Execute uma vez a função `atualizarDadosBigQuery` manualmente pelo
 *    editor (▶ Executar) para autorizar os escopos pedidos.
 * 5. Crie o gatilho automático: rode `criarGatilhoAtualizacao()` uma vez
 *    (ou Gatilhos → + Adicionar gatilho → função
 *    atualizarDadosBigQuery → baseado em tempo → a cada 30 minutos).
 *
 * A partir daí a aba DADOS se atualiza sozinha — não precisa mais clicar em
 * "Extrair".
 */

var PROJECT_ID = "meli-bi-data"; // projeto do BigQuery (faturamento)
var ABA_DADOS  = "DADOS";        // precisa bater com SHEET_ABA no index.html

var SQL_VALORES = [
  "WITH rotas AS (",
  "  SELECT r.RTG_ROUTE_UUID",
  "  FROM `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_ROUTE` r",
  "  WHERE r.SIT_SITE_ID='MLB' AND r.SHP_FACILITY_ID='SSC2'",
  "    AND r.RTG_ROUTE_STATUS='planned'",
  "    AND r.RTG_ROUTE_DEPARTURE_DTTM >= CAST(CURRENT_DATE('America/Sao_Paulo') AS DATETIME)",
  "    AND r.RTG_ROUTE_DEPARTURE_DTTM <  CAST(DATE_ADD(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY) AS DATETIME)",
  "),",
  "ids AS (",
  "  SELECT DISTINCT SAFE_CAST(sau.RTG_UNIT_EXTERNAL_ID AS INT64) AS ID",
  "  FROM rotas r",
  "  JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP` s ON s.RTG_ROUTE_UUID=r.RTG_ROUTE_UUID AND s.RTG_STOP_LAST_UPDATED_DTTM >= DATETIME_SUB(CAST(CURRENT_DATE('America/Sao_Paulo') AS DATETIME), INTERVAL 3 DAY)",
  "  JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION` sa ON sa.RTG_STOP_UUID=s.RTG_STOP_UUID AND sa.RTG_ACTION_LAST_UPDATED_DTTM >= DATETIME_SUB(CAST(CURRENT_DATE('America/Sao_Paulo') AS DATETIME), INTERVAL 3 DAY)",
  "  JOIN `meli-bi-data.WHOWNER.BT_SHP_LG_RTG_STOP_ACTION_UNIT` sau ON sau.RTG_ACTION_UUID=sa.RTG_ACTION_UUID AND sau.RTG_ACTION_LAST_UPDATED_DTTM >= DATETIME_SUB(CAST(CURRENT_DATE('America/Sao_Paulo') AS DATETIME), INTERVAL 3 DAY) AND sau.RTG_UNIT_EXTERNAL_TYPE='shipment'",
  "),",
  "entrada AS (",
  "  SELECT SHP_SHIPMENT_ID AS PCT, MIN(SHP_LG_LAST_UPDATED) AS ENTROU",
  "  FROM `meli-bi-data.WHOWNER.BT_SHP_LG_SHIPMENTS`",
  "  WHERE SHP_LG_STATUS='at_station' AND SHP_LG_SUB_STATUS='sorting'",
  "    AND SHP_LG_LAST_UPDATED >= DATETIME_SUB(CURRENT_DATETIME('America/Sao_Paulo'), INTERVAL 3 DAY)",
  "  GROUP BY 1",
  ")",
  "SELECT",
  "  CAST(SHI.SHP_SHIPMENT_ID AS STRING) AS SHP_SHIPMENT_ID,",
  "  CONCAT('R$ ', REPLACE(FORMAT('%.2f', SHI.SHP_ORDER_COST), '.', ',')) AS MOEDA_LOCAL,",
  "  (SELECT MAX(ITE.SHP_ITEM_DESC) FROM UNNEST(SHI.ITEMS) ITE) AS SHP_ITEM_DESC,",
  "  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S%Ez', TIMESTAMP(entrada.ENTROU,'America/Sao_Paulo'),'America/Sao_Paulo') AS ENTROU_STATION",
  "FROM ids",
  "JOIN `meli-bi-data.WHOWNER.BT_SHP_SHIPMENTS` SHI ON SHI.SHP_SHIPMENT_ID = ids.ID",
  "LEFT JOIN entrada ON entrada.PCT = SHI.SHP_SHIPMENT_ID"
].join("\n");

/**
 * Roda a consulta no BigQuery e escreve o resultado na aba DADOS.
 * Chamada pelo gatilho automático (a cada 30 min) ou manualmente.
 */
function atualizarDadosBigQuery() {
  var request = { query: SQL_VALORES, useLegacySql: false };
  var queryResults = BigQuery.Jobs.query(request, PROJECT_ID);
  var jobId = queryResults.jobReference.jobId;

  // aguarda o job terminar (poll simples)
  while (!queryResults.jobComplete) {
    Utilities.sleep(1000);
    queryResults = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId);
  }

  var linhas = [["SHP_SHIPMENT_ID", "MOEDA_LOCAL", "SHP_ITEM_DESC", "ENTROU_STATION"]];
  var rows = queryResults.rows || [];
  rows.forEach(function (row) {
    linhas.push(row.f.map(function (cell) { return cell.v; }));
  });

  // pagina se houver mais resultados
  var pageToken = queryResults.pageToken;
  while (pageToken) {
    var pagina = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId, { pageToken: pageToken });
    (pagina.rows || []).forEach(function (row) {
      linhas.push(row.f.map(function (cell) { return cell.v; }));
    });
    pageToken = pagina.pageToken;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ABA_DADOS);
  if (!sh) sh = ss.insertSheet(ABA_DADOS);
  sh.clearContents();
  // Formata as colunas A (ID) e D (ENTROU_STATION) como TEXTO simples antes de
  // escrever, para evitar que o Sheets detecte automaticamente algumas
  // células como data/número e outras não (causa a inconsistência de "sai em
  // uns pacotes e não em outros"). ID muito longo também não vira notação
  // científica.
  var linhasDados = Math.max(linhas.length, 2);
  sh.getRange(1, 1, linhasDados, 4).setNumberFormat("@");
  if (linhas.length > 1) {
    sh.getRange(1, 1, linhas.length, linhas[0].length).setValues(linhas);
  } else {
    sh.getRange(1, 1, 1, 4).setValues([linhas[0]]);
  }

  Logger.log("DADOS atualizado: " + (linhas.length - 1) + " linhas.");
}

/**
 * Cria o gatilho de tempo (30 minutos) para atualizarDadosBigQuery.
 * Execute esta função UMA VEZ pelo editor (▶ Executar → criarGatilhoAtualizacao).
 * Não crie de novo depois — isso duplicaria o gatilho.
 */
function criarGatilhoAtualizacao() {
  // remove gatilhos antigos da mesma função, para não duplicar
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "atualizarDadosBigQuery") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("atualizarDadosBigQuery")
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log("Gatilho criado: atualizarDadosBigQuery a cada 30 minutos.");
}
