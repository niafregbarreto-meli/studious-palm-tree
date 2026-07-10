/**
 * Bingo Hora a Hora — Atualização automática da aba DADOS (sem clicar em
 * "Extrair" manualmente).
 *
 * Substitui a extração manual do Connected Sheets: este script roda a
 * consulta diretamente no BigQuery (via REST API + token OAuth do próprio
 * script, SEM o serviço avançado "BigQuery" — esse serviço costuma falhar
 * com "invalid authentication credentials" em projetos GCP "Padrão") e
 * escreve o resultado na aba "DADOS" da mesma planilha, no formato que o
 * index.html espera:
 *   SHP_SHIPMENT_ID | MOEDA_LOCAL | SHP_ITEM_DESC | ENTROU_STATION
 *
 * Também mantém um HISTÓRICO para estatísticas por data: a cada execução,
 * calcula um resumo do momento (pacotes parados na estação, valor total em
 * risco, maior tempo parado) e adiciona uma linha na aba "HISTORICO" — cria
 * a aba automaticamente se não existir. Com o gatilho de 30 em 30 minutos,
 * isso forma uma série temporal pronta para tabela dinâmica/gráfico por dia.
 *
 * INSTALAÇÃO (uma vez):
 * 1. No editor de Apps Script (o mesmo projeto do Codigo.gs), adicione este
 *    arquivo: "+" ao lado de "Arquivos" → Script → cole este conteúdo.
 * 2. Confirme que o appsscript.json tem "https://www.googleapis.com/auth/bigquery"
 *    em oauthScopes (veja o comentário no index.html/README). NÃO precisa
 *    ativar nenhum serviço avançado.
 * 3. Confirme/ajuste PROJECT_ID abaixo (o projeto do BigQuery a faturar —
 *    use "meli-bi-data" ou o projeto onde sua conta já tem cota).
 * 4. Execute uma vez a função `atualizarDadosBigQuery` manualmente pelo
 *    editor (▶ Executar) para autorizar os escopos pedidos. Se já tinha
 *    autorizado uma versão anterior, revogue o acesso em
 *    myaccount.google.com/permissions e autorize de novo, para garantir que
 *    o escopo do BigQuery seja concedido.
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
 *
 * NÃO usa o serviço avançado "BigQuery" (BigQuery.Jobs.*) — esse serviço
 * exige que o projeto GCP vinculado ao script tenha a API habilitada
 * explicitamente no Cloud Console, o que o projeto "Padrão" do Apps Script
 * normalmente não permite (causa "invalid authentication credentials" mesmo
 * com o escopo correto autorizado). Em vez disso, chamamos a API REST do
 * BigQuery diretamente com o token OAuth do próprio script — mesma
 * identidade que já tem acesso delegado ao BigQuery via Connected Sheets.
 */
function atualizarDadosBigQuery() {
  var token = ScriptApp.getOAuthToken();
  var base = "https://bigquery.googleapis.com/bigquery/v2/projects/" + PROJECT_ID;

  function chamar(url, payload) {
    var opts = {
      method: payload ? "post" : "get",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    };
    if (payload) opts.payload = JSON.stringify(payload);
    var resp = UrlFetchApp.fetch(url, opts);
    var json = JSON.parse(resp.getContentText());
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json;
  }

  var json = chamar(base + "/queries", { query: SQL_VALORES, useLegacySql: false, timeoutMs: 30000 });
  var jobRef = json.jobReference;

  while (!json.jobComplete) {
    Utilities.sleep(1000);
    json = chamar(base + "/queries/" + jobRef.jobId);
  }

  var linhas = [["SHP_SHIPMENT_ID", "MOEDA_LOCAL", "SHP_ITEM_DESC", "ENTROU_STATION"]];
  (json.rows || []).forEach(function (row) {
    linhas.push(row.f.map(function (cell) { return cell.v; }));
  });

  var pageToken = json.pageToken;
  while (pageToken) {
    var pagina = chamar(base + "/queries/" + jobRef.jobId + "?pageToken=" + encodeURIComponent(pageToken));
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

  registrarHistorico_(linhas);
}

/**
 * Calcula um resumo do momento (pacotes parados, valor em risco, maior
 * tempo) a partir das linhas de DADOS e adiciona uma linha na aba
 * HISTORICO. Roda a cada execução (a cada 30 min pelo gatilho), formando
 * uma série temporal para estatísticas por data.
 */
function registrarHistorico_(linhas) {
  var agora = new Date();
  var parados = 0, valorTotal = 0, maxMin = -1, idMaxTempo = "", idMaisCaro = "", valorMaisCaro = -1;

  for (var i = 1; i < linhas.length; i++) {
    var id = linhas[i][0];
    var valorTxt = linhas[i][1];
    var entrou = linhas[i][3];
    var valorNum = parseMoeda_(valorTxt);

    if (entrou) {
      parados++;
      valorTotal += valorNum;
      var entrouMs = Date.parse(entrou);
      if (!isNaN(entrouMs)) {
        var minutos = Math.round((agora.getTime() - entrouMs) / 60000);
        if (minutos > maxMin) { maxMin = minutos; idMaxTempo = id; }
      }
    }
    if (valorNum > valorMaisCaro) { valorMaisCaro = valorNum; idMaisCaro = id; }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("HISTORICO");
  if (!sh) {
    sh = ss.insertSheet("HISTORICO");
    sh.appendRow(["DATA", "HORA", "PACOTES_PARADOS", "VALOR_TOTAL", "MAX_TEMPO_MIN", "ID_MAIOR_TEMPO", "ID_MAIS_CARO", "VALOR_MAIS_CARO"]);
  }
  sh.appendRow([
    Utilities.formatDate(agora, "America/Sao_Paulo", "yyyy-MM-dd"),
    Utilities.formatDate(agora, "America/Sao_Paulo", "HH:mm"),
    parados,
    Math.round(valorTotal * 100) / 100,
    Math.max(maxMin, 0),
    idMaxTempo,
    idMaisCaro,
    Math.round(valorMaisCaro * 100) / 100
  ]);
}

// "R$ 1.234,56" -> 1234.56
function parseMoeda_(txt) {
  if (!txt) return 0;
  var limpo = String(txt).replace(/[^0-9.,-]/g, "").replace(/\./g, "").replace(",", ".");
  var n = parseFloat(limpo);
  return isNaN(n) ? 0 : n;
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
