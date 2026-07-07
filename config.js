// ─── Configuração do ambiente ──────────────────────────────────────────────
const CONFIG = {
  // BigQuery
  bq: {
    projectId:  'meli-bi-data',
    location:   'US',
    // Custo máximo por query (~50 GB)
    maxBytesBilled: 50 * 1024 * 1024 * 1024,
  },

  // Operação
  facilityId:  'SSC2',
  siteId:      'MLB',
  timezone:    'America/Sao_Paulo',
  cycles:      ['AM1', 'PM1', 'SD'],

  // BINGO: minutos sem atelar para acionar alerta
  bingoThresholdMin: 60,

  // Auto-refresh (ms)
  refreshIntervalMs: 30 * 60 * 1000, // 30 minutos

  // Severidade visual
  criticalThresholdMin: 90,  // vermelho
  warningThresholdMin:  60,  // laranja
};
