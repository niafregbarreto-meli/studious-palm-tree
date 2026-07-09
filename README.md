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

O histórico é por navegador/máquina por padrão. Para monitoramento em um único
posto, é suficiente e não exige infraestrutura. Use **Reiniciar** para limpar a
tela sem apagar o histórico.

### Histórico compartilhado entre várias máquinas (opcional)

Para que várias pessoas vejam o mesmo estado (tempo na estação, pacotes
encontrados e gaiolas auditadas) em tempo quase real, use o backend em
`apps-script/Codigo.gs`:

1. Crie uma planilha Google nova.
2. Menu **Extensões → Apps Script** e cole o conteúdo de `apps-script/Codigo.gs`.
3. **Implantar → Nova implantação → Tipo: App da Web**. Execute como *você
   mesmo* e conceda acesso a *qualquer pessoa da organização* (ou conforme a
   política interna).
4. Copie a URL que termina em `/exec`.
5. No `index.html`, preencha a constante `URL_BACKEND` com essa URL.

Com o backend ativo, cada carga de faltantes sincroniza o histórico com a
planilha, e as marcações de "Encontrado"/"Auditada" são propagadas para todas
as máquinas (atualização automática a cada 60 s). Se o backend ficar
indisponível, a ferramenta volta ao histórico local automaticamente.

## Marcações e impressão

- **Encontrado**: cada pacote tem um botão para marcar que já foi localizado
  fisicamente; a linha fica riscada e o estado é salvo.
- **Auditada por**: cada gaiola (rota) tem um campo para registrar o rep que a
  auditou, com data e hora.
- **Seleção + PDF**: selecione pacotes individuais ou gaiolas inteiras e clique
  em **Gerar PDF de impressão** para ter em papel a lista do que buscar, com um
  campo de conferência por item.
- **Verificar agora**: força a próxima verificação (recarregar os faltantes)
  sem esperar o contador, que continua correndo e sobrevive ao recarregar a
  página.

## Busca automática de valores (hospedado no Grid)

Quando a ferramenta é hospedada no Grid, ela lê os valores direto de uma
planilha Google via `Grid.sheets` (OAuth do dono, server-side — sem CORS, sem
CSV manual). Configuração (`SHEET_ID` / `SHEET_ABA` no início do `<script>`):

1. Conecte o Google em Grid (uma vez): `grid.adminml.com/google/auth/...`
   — se o OAuth apontar para `grid.melioffice.com` e não abrir, tente de novo
   com a VPN ativa.
2. Use um nome de aba **simples, sem acentos ou espaços** (ex.: `DADOS`) —
   nomes como "Extração 1" causam erro `Sheet range contains invalid
   characters` no proxy de sheets do Grid.
3. A aba deve ter as colunas `SHP_SHIPMENT_ID`, `MOEDA_LOCAL`,
   `SHP_ITEM_DESC` e `ENTROU_STATION`.

Quando `Grid.sheets` está disponível, o upload dos faltantes já traz valores e
tempo prontos, pulando as etapas 2 e 3. Se a leitura falhar, cai para o CSV
publicado (`URL_VALORES_CSV`, opcional) e depois para o modo manual.

### Atualizar a aba DADOS automaticamente (sem clicar em "Extrair")

O Connected Sheets do BigQuery não permite agendar a atualização da aba
*extraída* — só da página conectada. Para eliminar o clique manual, use
`apps-script/AtualizarDados.gs`: um gatilho de tempo que roda a consulta
direto no BigQuery (serviço avançado BigQuery API) e escreve o resultado na
aba `DADOS`. Instalação: veja os comentários no topo do arquivo — resumindo,
cole o script no mesmo projeto Apps Script da planilha, ative o serviço
avançado do BigQuery, e execute `criarGatilhoAtualizacao()` uma vez.

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
