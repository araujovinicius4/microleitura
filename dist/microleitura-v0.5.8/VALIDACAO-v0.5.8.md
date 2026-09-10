# Microleitura v0.5.8 — correção do editor

## Causa e reprodução

O `content.js` inicial era idêntico por SHA-256 ao distribuído na v0.5.7.
A comparação direta dos arquivos distribuídos v0.5.6 e v0.5.7 mostrou a
introdução de `uncoveredTextNodes()` e `repairUncoveredText()`, sua chamada
antes de `eligibleBlock()` para blocos processados e a inclusão de divs
processadas no fallback. A alteração da expressão de segmentação foi preservada.

O teste sintético em Chrome headless reproduziu o caminho de um bloco marcado
como processado reutilizado como editor dentro de uma raiz de mensagem. Depois
de inserir XYZ em abcde|fghij, a v0.5.7 manteve abcdeXYZfghij, mas moveu o caret
para 0. Foram observadas mutações characterData e childList, 3 chamadas de
processPage, 5 chamadas de reparo e 2 extractContents em conteúdo editável
(contadores incluem a preparação do cenário). O reparo extraiu o texto e o
reinseriu em um span, invalidando a posição do caret.

Isso demonstra uma causa concreta no código, mas não comprova que o ChatGPT
autenticado reutiliza exatamente essa estrutura. Um prompt fora das raízes de
mensagens também agendava processamento, porém essa localização, isoladamente,
não demonstra que seria alcançada por Range. Não houve teste em sessão
autenticada do ChatGPT; a confirmação no site real depende de validação manual.

## Proteções implementadas

- `isEditableElement()` reconhece input, textarea, select, contenteditable,
  textbox e searchbox, incluindo ancestrais, isContentEditable e designMode.
- `candidateBlocks()` exclui raízes e candidatos editáveis, inclusive os
  previamente processados; `eligibleBlock()` rejeita edição explicitamente.
- Os dois walkers excluem texto editável. `repairUncoveredText()` protege o
  bloco e cada nó. A seleção e o elemento ativo recebem uma verificação adicional.
- `wrapRange()` rejeita blocos contendo editores para não extrair elementos
  editáveis entre dois nós de leitura. Blocos mistos usam reparo por nó somente
  no texto de leitura, preservando a identidade DOM do editor.
- Raízes e chunks editáveis não recebem controles, bindings ou progresso.
- O observer ignora mutações com alvo editável; lotes com alterações de leitura
  continuam agendando processamento. `characterData: true` foi mantido.
- Não há salvamento/restauração artificial do caret nem alteração de
  `isInteractiveTarget()`, chaves de persistência ou arquitetura PDF.

## Testes automatizados

Executar com Node e Chrome instalado (ou definir CHROME_PATH):

```powershell
node tests/editor.cjs --baseline
node tests/editor.cjs
node --check content.js
```

O teste usa Chrome headless com perfil temporário e o protocolo DevTools.
O content script é injetado com storage simulado e detecção de ChatGPT dirigida
pela fixture; os contadores são inseridos somente na cópia em memória do teste.
Não há logging de diagnóstico no código distribuído.

Verifica abcdeXYZfghij com caret 8; inserções sucessivas; Backspace; Delete;
setas esquerda/direita; seleção e substituição; Enter e Shift+Enter; ausência
de ciclos de processamento causados pela edição; ausência de spans no editor;
streaming por childList e characterData; re-render; cobertura de texto comum,
strong, em, span e texto ao redor de links; clique em links sem preventDefault
ou abertura de paleta; blocos HTML mistos; controles; roles sem contenteditable;
edição herdada e raiz editável.

Os testes de links verificam preservação do evento e do href, não navegação
externa. O comportamento de Enter é o nativo da fixture, não o envio do ChatGPT.
PDF é validado por identidade byte a byte da pasta pdf e dos arquivos de popup
com v0.5.7, sem alegar uma nova validação interativa do visualizador.

A pasta recebida não possui .git. Por isso a verificação de whitespace usa
`git diff --no-index --check` contra a distribuição v0.5.7 (status 1 também
indica diferenças esperadas); nenhum erro de whitespace deve ser emitido.

## Validação manual no ChatGPT

Resultado automatizado em 08/09/2026: suíte completa aprovada (exit 0).
O cenário corrigido produziu abcdeXYZfghij, caret 8 e zero extrações no editor.
Todas as verificações de edição, observer, cobertura, streaming, links e
controles descritas acima passaram. Sintaxe JS e manifest válidos; verificação
de whitespace sem erros. Os 208 arquivos de PDF, popup e estilos comparados
permaneceram idênticos à v0.5.7.

Recarregar a extensão e a aba após atualizar. Digitar uma frase longa, mover o
caret ao meio e continuar; usar Backspace, Delete e setas; selecionar e substituir
texto; testar Enter e Shift+Enter. Confirmar caret estável e respostas ainda
marcáveis, inclusive durante streaming e ao clicar em links.

## Entrega

Arquivos de origem alterados: content.js, manifest.json e README.md.
Adicionados: tests/editor.cjs e este relatório.
Pasta unpacked: dist/microleitura-v0.5.8.
ZIP: dist/microleitura-v0.5.8.zip.
SHA-256: dist/microleitura-v0.5.8.zip.sha256.
