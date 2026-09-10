# Microleitura v0.6.0 — frames e SEI/Ebserh

Data: 2026-09-09. Baseline: distribuição local v0.5.9.

## Diagnóstico e origem da evidência

O usuário confirmou no DevTools o caminho
`div#divArvoreConteudo > div#divArvoreHtml > iframe#ifrArvoreHtml > html > body > div > p`.
Informou uma URL aproximada do próprio domínio:
`https://sei.ebserh.gov.br/sei/controlador.php?acao=documento_visualizar...`.
O manifesto v0.5.9 não tinha `all_frames`; seu content script pesquisava somente
o próprio `document`. Essa combinação explica por que o HTML no iframe não era
segmentado. Não houve inspeção independente da sessão autenticada.

| Contexto real informado | URL/origem | Comportamento v0.6.0 |
| --- | --- | --- |
| Shell do SEI | `https://sei.ebserh.gov.br`; rota exata não informada | Rotas sem identificação de documento são excluídas, sem observer ou timer de processamento |
| `iframe#ifrArvoreHtml`, `top: false` | Mesma origem, `/sei/controlador.php?acao=documento_visualizar...` | Segmentação local, paleta, quatro estados, barra e persistência |
| Editor | URL e frame reais não fornecidos | Proteção por DOM editável e `designMode`, validada sinteticamente |
| Outros frames/menu/PDF | Quantidade, URLs e origens reais não fornecidas | Não foram inventados índices ou resultados reais |

**Não houve teste autenticado no SEI.** A quantidade total de frames, os parâmetros
reais de identidade e o fluxo de PDF autenticado continuam pendentes.

## Implementação

- `manifest.json`: versão `0.6.0`, `all_frames: true`, demais propriedades e
  permissões preservadas. Sem `match_about_blank`: não há caso concreto confirmado
  de documento `about:blank`/`srcdoc` que justifique habilitá-lo.
- `getFrameContext()` consulta `window.top === window` e, com proteção de acesso,
  `window.frameElement?.id`. A ação `documento_visualizar` também identifica o
  documento SEI, permitindo execução sem acesso ao elemento no pai cross-origin.
- Cada instância opera apenas sobre seu documento. Não acessa `top.document` nem
  `iframe.contentDocument`; não há background, mensagens ou coordenação global.
- No domínio Ebserh, somente contexto reconhecido de documento inicia leitura.
  Outros sites preservam raízes semânticas; fallback de `body` exige parágrafos
  fora de navegação/controles, sendo mais conservador em frames genéricos.
- `input`, `textarea`, `select`, conteúdo editável herdado, textbox e searchbox
  mantêm as proteções da v0.5.8. Body editável e `designMode=on` impedem ativação.
  As proteções de Range permanecem; tabelas textuais são aceitas em frames de
  leitura sem processar célula e seus parágrafos duas vezes.
- Uma barra por documento HTML, com contagem e controles sobre os chunks do
  próprio documento. Não há barra no shell SEI. ChatGPT conserva os controles por
  mensagem, como no baseline. Dois documentos de leitura em frames distintos
  podem ter uma barra cada; não há eleição global de um único documento ativo.
- Observer é ligado às raízes de leitura, desconectado durante processamento e
  filtra mutações de barra/paleta e edição. Shell SEI não inicia observer.
  Contextos genéricos usam uma verificação periódica de raízes e URL para detectar
  conteúdo inserido depois, sem observar toda a UI quando não há raiz elegível.
- Troca de `pathname + search` agenda reconciliação. Troca da chave descarta
  wrappers/controles anteriores fora de edição e carrega o estado correspondente.
  A chave é conferida novamente após a leitura assíncrona do storage, e cada mapa
  fica associado à chave em que foi carregado para evitar gravar na URL seguinte.

## Persistência: decisão provisória explícita

Não foi fornecida a URL real completa com parâmetros de identificação confirmados.
`id_documento`, `id_procedimento` e `id` **não são tratados como parâmetros reais
do SEI**. O `id` usado nos testes é exclusivamente sintético.

`getDocumentStorageKey()` mantém a chave v0.5.9 em ChatGPT/HTML genérico. No SEI,
usa `microleitura:v4:` + origem + pathname + `:sei-content:` + SHA-256 do texto de
leitura normalizado, excluindo UI da extensão, controles e áreas editáveis.
Nenhum parâmetro da query do SEI é persistido nessa identidade. Não migra estados
legados por pathname para o SEI, pois poderiam pertencer a outro documento.
O algoritmo `t1-` de IDs estáveis dos chunks da v0.5.9 foi preservado.

Consequências verificadas: mesmo conteúdo após reload ou troca de token restaura
marcas; conteúdos diferentes usam chaves distintas; inline e UI da extensão não
alteram a identidade. **Dois documentos com texto exatamente igual compartilham
identidade. Uma edição textual, inclusive assinatura acrescentada, muda a chave.**
Também não há sincronização em tempo real entre duas instâncias simultâneas do
mesmo documento. Assim, esta versão não comprova o requisito de isolamento
absoluto por documento do SEI. Para fechá-lo, é necessário confirmar um
identificador estável real e substituir esse fallback por uma chave baseada nele.

## Testes e limites

Os testes usam Chrome headless com perfil temporário. `tests/frames.cjs` serve
HTML local em duas origens e injeta o content script via CDP em documentos reais
de frame. Somente a comparação do hostname Ebserh é substituída por loopback.
O teste valida execução/DOM em frames, **não** o mecanismo de instalação/injeção
automática de uma extensão carregada no Chrome. `all_frames` é validado no JSON.

| Verificação | Resultado |
| --- | --- |
| Iframe `ifrArvoreHtml`, documento em rota `documento_visualizar` | Passou em fixture; chunks e uma barra |
| Shell com menu/árvore | Zero chunks, zero barras, zero chamadas de observer |
| Negrito, itálico, assinatura e tabela | Conteúdo preservado; texto em duas células segmentado |
| Link e texto ao redor | Link mantém navegação por fragmento, sem paleta; clique no chunk abre paleta |
| Quatro cores, Continuar, Revisar | Passou em frame; regressão também passou em ChatGPT/HTML |
| Reload do frame e da página | IDs e quatro marcas restaurados |
| A → B → voltar A | Isolamento para textos diferentes e restauração passaram |
| Token diferente no mesmo documento | Chave não contém token; marcas preservadas |
| Query e DOM reutilizado sem reload | Estado reconciliado; retorno ao texto A restaura marcas |
| Query-only em HTML genérico, mesmo DOM | Troca de chave sem herdar marcas; voltar restaura |
| Mutação externa e idle | Novo chunk, uma barra; sem ciclo contínuo de observer |
| Body editável, designMode e campo no documento | Sem chunks/controles nas áreas editáveis; frames editáveis sem observer |
| Caret | Offset preservado no frame; suíte v0.5.8 de edição passou |
| Cross-origin | Documento em outra porta executa com `frameElement=null`, sem ler DOM do pai |
| Documento longo e substituição do iframe | 100 parágrafos adicionais segmentados com uma barra; recriar o elemento iframe restaura A |
| ChatGPT sintético | Streaming, inline, texto repetido, quatro estados, reload/reabertura, progresso e edição passaram |
| HTML comum sintético | Marcas/IDs após reload e reabertura passaram |
| PDF.js real com PDF sintético | Quatro estados/IDs restaurados; text layer e annotation layer presentes |
| SEI autenticado, ChatGPT real, PDF do SEI | Não executados |

O viewer, PDF.js, popup e CSS permanecem byte a byte iguais à v0.5.9. Não houve
teste novo de links internos/externos do PDF ou de PDFs autenticados dentro do
SEI. Canvas não é segmentado. O popup existente continua oferecendo o viewer
próprio; a seleção da URL real em um viewer SEI com URL genérica precisa de
validação autenticada antes de prometer abertura automática correta.

Documento longo, assinatura real e navegação do sistema devem ser confirmados
na sessão autenticada. Os testes locais não substituem essa validação visual.

Comandos: `node tests/frames.cjs`, `node tests/editor.cjs`,
`node tests/persistence.cjs`, `node tests/storage-key.cjs`,
`node tests/pdf-persistence.cjs`, `node --check content.js`.
O manifesto foi parseado e comparado ao baseline. Esta pasta não é repositório
Git: `git diff --check` foi substituído por `git diff --no-index --check` contra
os arquivos correspondentes em `dist/microleitura-v0.5.9`.

## Diagnóstico opcional e validação pelo usuário

No DevTools do popup da extensão, executar
`chrome.storage.local.set({ microleituraDebug: true })`, recarregar a página e
filtrar o console por `[Microleitura frame]`. O registro inicial mostra href,
top, frameId, designMode e chunks naquele momento (normalmente zero, antes do
processamento agendado). Para desligar, gravar `false` na mesma preferência.
O modo debug imprime a URL completa localmente; não envia dados a servidor.

1. Recarregar a extensão e o SEI; confirmar injeção no frame em Sources.
2. Abrir HTML e confirmar cursor, paleta, quatro cores, links, tabelas e assinatura.
3. Confirmar barra única dentro do documento, sem barra no shell/árvore.
4. Marcar A, F5, abrir B e voltar A; verificar isolamento e restauração.
5. Testar documento longo, editor/caret, voltar/avançar e PDF autenticado.
6. Fornecer nomes dos parâmetros reais do iframe, ocultando tokens, para concluir
   a identidade por documento e testar documentos distintos com texto idêntico.

## Arquivos e distribuição

Alterados: `manifest.json`, `content.js`, `README.md`, `tests/storage-key.cjs`.
Adicionados: este relatório, `tests/frames.cjs`, `tests/frames/shell.html`,
`tests/frames/documento.html`, `tests/frames/editor.html`.
Distribuição: `dist/microleitura-v0.6.0/`, `dist/microleitura-v0.6.0.zip` e
`dist/microleitura-v0.6.0.zip.sha256`. O ZIP é comparado arquivo por arquivo à
pasta unpacked por SHA-256 antes da entrega. Versão do manifesto: `0.6.0`.
