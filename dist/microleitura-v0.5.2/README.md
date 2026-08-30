# Microleitura v0.5.2

Extensão Chrome (Manifest V3) para dividir textos em microtrechos, marcar a leitura e retomar exatamente onde você parou. Funciona no ChatGPT, em artigos/páginas web e agora também em PDFs por meio de um visualizador próprio baseado no Mozilla PDF.js.

Todo o processamento e armazenamento acontecem localmente no navegador. A extensão não usa CDN, scripts remotos, telemetria ou envio do conteúdo dos PDFs para servidores. As marcações são persistidas em `chrome.storage.local`.

## Instalar ou atualizar

1. Descompacte o ZIP, se necessário.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta `microleitura-v0.5.2` (a pasta que contém `manifest.json`).
5. Para atualizar uma instalação carregada da mesma pasta, substitua os arquivos e clique em **Recarregar** no cartão da extensão.
6. Recarregue as páginas que já estavam abertas.

A atualização mantém as marcações antigas da v0.4.1 em páginas web e no ChatGPT, pois as chaves e os identificadores existentes foram preservados.

## Marcações

- **Lido** — cinza
- **Entendido** — verde
- **Revisar** — amarelo
- **Importante/Dúvida** — vermelho
- **× Limpar** — remove a marcação

O progresso considera marcado qualquer trecho com um dos quatro estados. Trechos sem marcação não entram no percentual lido.

## ChatGPT e páginas web

Abra ou recarregue a página. A extensão detecta especificamente as mensagens do ChatGPT. Em sites comuns, prioriza conteúdo semântico como `article` e `main`, evitando menus, cabeçalhos, rodapés, formulários e barras laterais sempre que possível.

Clique em um microtrecho para abrir a paleta. **Continuar** leva ao primeiro trecho ainda não marcado. **Revisar (N)** percorre em ciclo somente os trechos amarelos e vermelhos.

## PDF remoto

1. Abra o endereço do PDF no Chrome, por exemplo `https://exemplo.com/documento.pdf`.
2. Clique no ícone da extensão.
3. Clique em **Abrir com Microleitura**.

O popup resolve a URL original mesmo quando o Chrome usa frames do visualizador PDF interno. Para URLs web sem extensão `.pdf`, ele permite que o próprio PDF.js confirme o formato. O botão **Diagnóstico PDF** mostra a URL da aba, URL pendente, URL resolvida e frames detectados.

O PDF abre em uma nova guia no visualizador próprio. Todas as páginas são renderizadas, o texto continua selecionável e os microtrechos recebem a mesma paleta, progresso, Continuar e Revisar. O documento é baixado diretamente pelo navegador e processado localmente.

## PDF local

Para arquivos como `file:///Users/.../documento.pdf` ou `file:///C:/.../documento.pdf`:

1. Abra `chrome://extensions`.
2. Abra **Detalhes** da Microleitura.
3. Ative **Permitir acesso a URLs de arquivo**.
4. Abra o PDF local, clique no ícone da extensão e escolha **Abrir com Microleitura**.

Se essa permissão estiver desativada, o visualizador mostra uma explicação com esses passos. Após ativá-la, tente abrir o PDF novamente.

## Identidade e restauração em PDFs

O visualizador associa PDFs remotos à URL normalizada e ao fingerprint do PDF.js. Em PDFs locais, usa o fingerprint e o tamanho do conteúdo, de modo que a identidade não dependa somente do caminho do arquivo. Cada microtrecho também usa número da página, texto normalizado e ocorrência no conteúdo para formar um identificador estável. Isso evita depender apenas de posições frágeis como “página 3, bloco 5”.

## Componentes de terceiros

Esta distribuição inclui `pdfjs-dist` 6.3.289, licenciado sob Apache-2.0. A licença acompanha os arquivos em `pdf/lib/LICENSE.pdfjs`.
