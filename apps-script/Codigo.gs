/**
 * Bingo Hora a Hora — Backend compartilhado (Google Apps Script)
 *
 * Fornece histórico COMPARTILHADO entre várias máquinas para o index.html.
 * Guarda os dados em abas de uma planilha Google:
 *   - SEEN         : [id, primeiraLeituraTs]  (quando o pacote entrou "Na estação")
 *   - ENCONTRADOS  : [id, ts]                 (pacotes marcados como encontrados)
 *   - AUDITORIAS   : [rota, rep, ts]          (gaiolas auditadas)
 *
 * Protocolo (consumido pelo index.html):
 *   GET  ?action=state          -> { seen, encontrados, auditorias }
 *   POST { action:"sync", ids:[...], ts }
 *                               -> { seen, encontrados, auditorias, resolvidos,
 *                                    houveHistorico, novos:[...] }
 *   POST { action:"encontrado", id, marcado:true|false } -> { ok:true }
 *   POST { action:"auditoria", rota, rep }               -> { ok:true }
 *
 * IMPORTANTE: o index.html envia POST com Content-Type text/plain para evitar
 * o preflight CORS. Por isso lemos e.postData.contents e fazemos JSON.parse.
 */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "state";
  if (action === "state") {
    return json_({
      seen: lerSeen_(),
      encontrados: lerEncontrados_(),
      auditorias: lerAuditorias_()
    });
  }
  return json_({ erro: "acao desconhecida" });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case "sync":       return json_(sincronizar_(body));
      case "encontrado": return json_(marcarEncontrado_(body));
      case "auditoria":  return json_(registrarAuditoria_(body));
      default:           return json_({ erro: "acao desconhecida" });
    }
  } finally {
    lock.releaseLock();
  }
}

/* ─── Ações ──────────────────────────────────────────────────── */

function sincronizar_(body) {
  var agora = Number(body.ts) || Date.now();
  var ids = body.ids || [];
  var seenAntigo = lerSeen_();
  var houveHistorico = Object.keys(seenAntigo).length > 0;

  var idsAtuais = {};
  ids.forEach(function (id) { idsAtuais[String(id)] = true; });

  // resolvidos = estavam no histórico e não estão mais na estação
  var resolvidos = 0;
  Object.keys(seenAntigo).forEach(function (id) {
    if (!idsAtuais[id]) resolvidos++;
  });

  // preserva a primeira leitura; novos recebem o timestamp atual
  var novos = [];
  var seenNovo = {};
  ids.forEach(function (idRaw) {
    var id = String(idRaw);
    if (seenAntigo[id] === undefined) { seenNovo[id] = agora; novos.push(id); }
    else { seenNovo[id] = seenAntigo[id]; }
  });

  gravarSeen_(seenNovo);

  return {
    seen: seenNovo,
    encontrados: lerEncontrados_(),
    auditorias: lerAuditorias_(),
    resolvidos: resolvidos,
    houveHistorico: houveHistorico,
    novos: novos
  };
}

function marcarEncontrado_(body) {
  var sh = aba_("ENCONTRADOS", ["id", "ts"]);
  var id = String(body.id);
  var dados = sh.getDataRange().getValues();
  var linha = -1;
  for (var i = 1; i < dados.length; i++) {
    if (String(dados[i][0]) === id) { linha = i + 1; break; }
  }
  if (body.marcado) {
    if (linha === -1) sh.appendRow([id, Date.now()]);
  } else if (linha !== -1) {
    sh.deleteRow(linha);
  }
  return { ok: true };
}

function registrarAuditoria_(body) {
  var sh = aba_("AUDITORIAS", ["rota", "rep", "ts"]);
  var rota = String(body.rota);
  var dados = sh.getDataRange().getValues();
  var linha = -1;
  for (var i = 1; i < dados.length; i++) {
    if (String(dados[i][0]) === rota) { linha = i + 1; break; }
  }
  if (linha === -1) sh.appendRow([rota, body.rep, Date.now()]);
  else sh.getRange(linha, 1, 1, 3).setValues([[rota, body.rep, Date.now()]]);
  return { ok: true };
}

/* ─── Leitura / escrita das abas ─────────────────────────────── */

function lerSeen_() {
  var sh = aba_("SEEN", ["id", "ts"]);
  var dados = sh.getDataRange().getValues();
  var mapa = {};
  for (var i = 1; i < dados.length; i++) {
    if (dados[i][0] !== "") mapa[String(dados[i][0])] = Number(dados[i][1]);
  }
  return mapa;
}

function gravarSeen_(mapa) {
  var sh = aba_("SEEN", ["id", "ts"]);
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([["id", "ts"]]);
  var ids = Object.keys(mapa);
  if (!ids.length) return;
  var linhas = ids.map(function (id) { return [id, mapa[id]]; });
  sh.getRange(2, 1, linhas.length, 2).setValues(linhas);
}

function lerEncontrados_() {
  var sh = aba_("ENCONTRADOS", ["id", "ts"]);
  var dados = sh.getDataRange().getValues();
  var mapa = {};
  for (var i = 1; i < dados.length; i++) {
    if (dados[i][0] !== "") mapa[String(dados[i][0])] = Number(dados[i][1]);
  }
  return mapa;
}

function lerAuditorias_() {
  var sh = aba_("AUDITORIAS", ["rota", "rep", "ts"]);
  var dados = sh.getDataRange().getValues();
  var mapa = {};
  for (var i = 1; i < dados.length; i++) {
    if (dados[i][0] !== "") mapa[String(dados[i][0])] = { rep: dados[i][1], ts: Number(dados[i][2]) };
  }
  return mapa;
}

/* ─── Utilidades ─────────────────────────────────────────────── */

function aba_(nome, cabecalho) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]);
  }
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
