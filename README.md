# Video Downloader — Detector de Vídeos

Extensão para **Chrome e Edge (Manifest V3)** que detecta vídeos nas páginas (MP4, WebM, HLS e DASH) e permite baixá-los na melhor qualidade disponível. Mostra um botão "Baixar" sobre cada vídeo e uma lista no popup para escolher outras qualidades.

> ## 🚧 Projeto em desenvolvimento
>
> A extensão ainda está em fase inicial (versão `0.1.0`) e **muita coisa pode falhar ou mudar**: nem todo site é suportado e alguns formatos ainda não funcionam.
> **Aceitamos ajuda!** Se quiser contribuir, abra uma *issue* com o site/vídeo que falhou ou envie um *pull request* — correções, novos parsers, testes e melhorias de interface são todos bem-vindos.

## Como usar

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` (ou `edge://extensions`) e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta [`extension/`](extension/).
4. Abra uma página com vídeo, aguarde alguns segundos e use o botão sobre o vídeo ou o ícone da extensão.

## O que ela faz (e o que não faz)

- Detecta vídeos diretos (MP4/WebM) e streams HLS (`.m3u8`) e DASH (`.mpd`).
- Baixa a melhor qualidade disponível e permite escolher outras no popup.
- Não processa conteúdo protegido por DRM, e não deve ser usada para baixar material sem permissão do dono. Respeite os direitos autorais e os termos de uso dos sites.

## Estrutura

- `extension/`: código-fonte da extensão (`background/`, `content/`, `downloader/`, `parsers/`, `popup/`, `offscreen/`, `utils/`) e testes em `extension/tests/`. Detalhes técnicos e histórico de mudanças em [`extension/README.md`](extension/README.md).
- `dist/` e o `.zip` de distribuição são gerados a partir de `extension/` e não ficam no repositório.

## Testes

```bash
cd extension
npm install
npm test          # testes unitários (Node.js)
npm run test:e2e  # testes ponta a ponta (Playwright)
```

## Como ajudar

1. Faça um fork e crie uma branch para a sua alteração.
2. Rode `npm test` antes de enviar.
3. Descreva no pull request o site e o tipo de vídeo que você testou.

## Licença

Ainda não definida. Enquanto não houver um arquivo `LICENSE`, todos os direitos permanecem com o autor — se você quiser contribuir ou reutilizar o código, abra uma issue para combinarmos.
