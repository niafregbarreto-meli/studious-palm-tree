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

## Comparação hora a hora (histórico local)

A cada carga, a ferramenta guarda no navegador (`localStorage`) quais pacotes
estavam "Na estação" e desde quando. Na carga seguinte ela cruza os dados e
mostra:

- **Persistem da carga anterior** — continuam na estação (a falha real).
- **Novos nesta carga** — apareceram agora.
- **Resolvidos desde a última** — sairam da estação (foram atrelados).
- **Tempo parado** — há quanto tempo cada pacote está na estação; linhas com
  mais de 60 minutos são destacadas em vermelho.

O histórico é por navegador/máquina. Para monitoramento em um único posto, é
suficiente e não exige infraestrutura. Use **Reiniciar** para limpar a tela
sem apagar o histórico.

## Busca automática de valores (opcional)

Para que o usuário só precise carregar os faltantes, preencha a constante
`URL_VALORES_CSV` no início do `<script>` com a URL de um CSV publicado
(planilha Q_BACKOFFICE conectada ao BigQuery → **Arquivo → Compartilhar →
Publicar na web → CSV**). Quando preenchida, os valores são buscados
automaticamente e as etapas 2 e 3 são puladas. Se a busca falhar, a ferramenta
volta ao modo manual.

## Recomendação de atualização

Após cada análise, um contador no cabeçalho lembra de baixar os faltantes
novamente. A cada 3 ciclos, a ferramenta pergunta ao operador como está o
fluxo da operação: se as ilhas estiverem cheias, o intervalo passa de 30 para
45 minutos.

## Detalhes técnicos

- **Rota simplificada**: extraída do primeiro segmento de `N.º Rota`
  (ex.: `A1_PM1` → `A1`).
- **Filtro de falha**: apenas `Localização do pacote = "Na estação"`.
- **Detecção de colunas**: tolerante a acentuação, maiúsculas/minúsculas e
  variações de nome; delimitador (`,`, `;` ou tab) detectado automaticamente.
- **Sem chamadas externas**: todo o processamento ocorre no navegador.
