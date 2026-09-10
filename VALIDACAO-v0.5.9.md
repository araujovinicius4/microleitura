# Microleitura v0.5.9 — persistência

## Causa comprovada antes da alteração

`node tests/persistence.cjs --baseline` executou o content.js distribuído na
v0.5.8 em Chrome headless. Uma resposta começou com um parágrafo e recebeu os
outros por streaming. Após marcar quatro trechos, o teste reconstruiu um DOM
limpo e executou novamente o script com o mesmo armazenamento simulado.

O armazenamento permaneceu intacto. A chave antes e depois foi literalmente
`microleitura:v4:nullblank` (fixture about:blank; não é uma URL real do ChatGPT).
O texto permaneceu igual, mas todos os IDs mudaram:

| Estado | ID v0.5.8 antes | ID v0.5.8 depois | ID v0.5.9 antes e depois |
| --- | --- | --- | --- |
| gray | dl2xp | eqb5bi | t1-bzsaxn |
| green | 1tblyzl | 1hqlj76 | t1-o0d0hr |
| yellow | rn3y0a | 9ts6rz | t1-x924qs |
| red | 1j1lhc1 | 8s22ts | t1-cdgs43 |

Exemplo de texto idêntico: `Primeiro trecho suficientemente longo para leitura.`
O teste imprime BEFORE/AFTER com texto, chave, ID, atributo e classe de leitura.

O componente instável era `messageFingerprint(root)`: hash dos primeiros 800
caracteres de `normalize(root.innerText)`. Esse conteúdo muda enquanto a resposta
cresce e passa a incluir a barra Microleitura, contagem e botões. Chunks antigos
mantinham o fingerprint parcial; novos chunks recebiam outro. No reload,
`loadMarkState()` carregava os dados e `applyMark()` era chamado com uma busca
sem correspondência. Não houve evidência de apagamento pelo storage.

Outro caminho confirmado: após substituir inline HTML mantendo o texto, o
reparo por nó criava limites de chunks diferentes dos de um carregamento limpo.
O teste ampliado detectou isso e agora passa.

## Correção e identidade

- Texto de leitura normalizado, excluindo editores e controles da extensão,
  compõe o contexto da raiz. Não há dependência de innerText, wrappers ou layout.
- ID `t1-` combina hash desse contexto, texto do chunk e ocorrência apenas entre
  chunks textualmente idênticos. Raízes de conteúdo inteiramente idêntico usam
  ocorrência entre essas raízes; não há índice absoluto de span ou bloco.
- Ao completar streaming, os chunks recebem IDs atualizados em conjunto e as
  marcas existentes acompanham o texto. Depois de concluída a resposta, o DOM
  limpo produz os mesmos IDs. Não foi inventado um seletor de message ID.
- Blocos de leitura alterados ou com cobertura perdida são reconciliados usando
  a segmentação existente. Blocos contendo editor continuam no reparo protegido.
- Todos os chunks recebem reidratação final, inclusive os criados pelo reparo.
  A barra de progresso é atualizada depois dessa restauração.
- ChatGPT usa origem + pathname: query e fragmento não alteram a chave.
  HTML genérico conserva query, pois ela pode identificar outro documento.
- Não foram alterados cores, gestos, semântica, CSS, popup ou arquivos PDF.

## Compatibilidade e limites

O prefixo de storage v4 permanece. Chaves antigas do mesmo caminho com query
são consultadas sem exclusão; a chave canônica prevalece. IDs legados compatíveis
com o fingerprint disponível são copiados para IDs novos, sem apagar originais.
Limpar uma marca grava um valor nulo para impedir sua ressurreição pelo fallback.

Hashes antigos calculados com texto parcial de streaming ou com uma contagem
histórica da barra não contêm texto recuperável. Não é possível recuperar com
segurança todos esses estados apenas pelo hash; eles permanecem armazenados.
Frases idênticas que já colidiam na versão antiga também não podem ser separadas
retroativamente com certeza. A migração é, portanto, parcial e não destrutiva.

O contexto usa o conteúdo completo de leitura da raiz. Alterações posteriores
no conteúdo da mensagem podem mudar os IDs; mudanças de streaming na página
aberta transferem marcas de chunks com texto igual. Marcar antes de uma frase
terminar não garante transferência quando o próprio texto/limite da frase muda.
Raízes inteiramente idênticas continuam dependendo da ordem entre suas cópias.

## Validação automatizada

- `node tests/persistence.cjs --baseline`: falha visual reproduzida na v0.5.8,
  com storage simulado preservado e quatro IDs diferentes após reload.
- `node tests/persistence.cjs`: quatro cores, classe gray, IDs, reload e nova
  inicialização simulando reabertura aprovados, em ChatGPT sintético e HTML.
  Progresso `4/5 · 80%`; `Revisar (2)`; navegação pelos dois itens de revisão;
  Continuar aponta ao quinto trecho. Streaming no mesmo bloco, re-render inline
  e independência de duas frases repetidas também aprovados.
- `node tests/storage-key.cjs`: antes/depois
  `microleitura:v4:https://chatgpt.com/c/example`, mesmo com query/fragmento
  diferentes; consulta de chaves antigas e conservação de query em HTML aprovadas.
- `node tests/pdf-persistence.cjs`: viewer e PDF.js reais, PDF sintético servido
  em loopback, quatro cores e IDs restaurados após nova navegação; annotation
  layer e text layer presentes. Chrome storage é adaptado para localStorage
  no teste. IDs: q4a6f1, 18kn2wx, wubnbu, 1cltnid. Não testa cliques em links PDF;
  os arquivos PDF, popup e estilos permanecem byte a byte iguais à v0.5.8.
- `node tests/editor.cjs`: regressão da proteção v0.5.8; caret 8 após inserir XYZ
  no meio de abcdefghij e zero extrações no editor, além dos demais casos de
  edição, seleção, controles, streaming e links da suíte existente.
- Sintaxe: `node --check content.js`. Manifest JSON: versão 0.5.9.
- Sem repositório .git: usar `git diff --no-index --check` contra v0.5.8.

## Validação real pendente

Não há sessão autenticada do ChatGPT disponível. Os testes de HTML/ChatGPT usam
storage simulado e nova navegação/inicialização, não comprovam o armazenamento
nativo de uma extensão instalada nem fechamento físico de uma aba do ChatGPT.
O teste PDF usa persistência de localStorage através de um adaptador da API.

O usuário deve recarregar a extensão e a conversa; marcar quatro cores depois
do streaming; pressionar F5; conferir cores, progresso, Continuar e Revisar;
fechar a aba e abrir a mesma conversa; repetir a conferência. Confirmar também
digitação no meio do prompt, Backspace, Delete, seleção, Enter e Shift+Enter.
A proteção do caret passou nos testes sintéticos; a confirmação no site real
permanece manual, conforme solicitado.

## Entrega

Alterados: content.js, manifest.json e README.md.
Adicionados: tests/persistence.cjs, tests/storage-key.cjs,
tests/pdf-persistence.cjs e este relatório. tests/editor.cjs preservado.
Unpacked: dist/microleitura-v0.5.9.
ZIP: dist/microleitura-v0.5.9.zip.
SHA-256: dist/microleitura-v0.5.9.zip.sha256.
