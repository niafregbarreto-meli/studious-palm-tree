# Bingo Hora a Hora — SSC2

Ferramenta interna de monitoramento para identificar pacotes que estão
fisicamente **na estação** de separação, porém **sem atrelamento**, agrupados
por rota e ordenados pelo maior valor.

A aplicação é um único arquivo `index.html` autocontido (HTML, CSS e JavaScript
em um só arquivo, sem dependências externas), pronto para publicação em
[grid.adminml.com](https://grid.adminml.com/).

## Fluxo de uso

1. **Carregar faltantes** — Em
   [envios.adminml.com/logistics/sorting/monitoring](https://envios.adminml.com/logistics/sorting/monitoring),
   selecione o grupo e o dia e clique em **Baixar faltantes**. Carregue o CSV
   gerado. A ferramenta filtra automaticamente os pacotes com localização
   **"Na estação"**.

2. **Executar consulta no BigQuery** — A ferramenta gera uma consulta com os
   IDs já preenchidos. Copie, execute no projeto `meli-bi-data` e baixe o
   resultado em CSV (colunas `SHP_SHIPMENT_ID`, `MOEDA_LOCAL`, `SHP_ITEM_DESC`).

3. **Carregar valores** — Carregue o CSV do BigQuery para cruzar valor e
   conteúdo por ID. Esta etapa é opcional: é possível analisar apenas por rota.

4. **Analisar resultado** — Os pacotes aparecem agrupados por rota (nome
   simplificado, ex.: `A1`, `B3`), ordenados pelo maior valor dentro de cada
   rota. É possível buscar, expandir/recolher e exportar o resultado em CSV.

## Detalhes técnicos

- **Rota simplificada**: extraída do primeiro segmento de `N.º Rota`
  (ex.: `A1_PM1` → `A1`).
- **Filtro de falha**: apenas `Localização do pacote = "Na estação"`.
- **Detecção de colunas**: tolerante a acentuação, maiúsculas/minúsculas e
  variações de nome; delimitador (`,`, `;` ou tab) detectado automaticamente.
- **Sem chamadas externas**: todo o processamento ocorre no navegador.
