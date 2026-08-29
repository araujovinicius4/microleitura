# Microleitura v0.4.1 — Rótulos por significado

Esta versão mantém as funções do ChatGPT e passa a funcionar em páginas web comuns.

## Marcações
A paleta agora mostra o significado de cada cor:
- **Lido** — cinza
- **Entendido** — verde
- **Revisar** — amarelo
- **Importante/Dúvida** — vermelho

## Revisar
O botão **Revisar** percorre somente os trechos amarelos e vermelhos.

## Como instalar/atualizar
1. Descompacte o ZIP.
2. Abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Remova a versão antiga ou clique em **Carregar sem compactação** e selecione esta pasta.
5. Recarregue as páginas que já estavam abertas.

## Sites
A extensão roda em páginas `http` e `https`. No ChatGPT ela mantém a detecção específica de mensagens. Em sites comuns, prioriza elementos semânticos como `article` e `main`, evitando menus, cabeçalhos, rodapés, formulários e barras laterais sempre que possível.

Teste sugerido: https://queroficarrico.com/blog/
# microleitura-web
