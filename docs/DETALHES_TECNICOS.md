# Video Downloader — MVP

Extensão Chrome/Edge (Manifest V3) para detectar vídeos em páginas web e
baixá-los na melhor qualidade disponível. Este é o **MVP** descrito na
"Primeira etapa" do escopo do projeto.

## Como carregar (chrome://extensions)

1. Abra `chrome://extensions` (funciona também no Edge, em `edge://extensions`).
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação**.
4. Selecione a raiz do repositório.
5. Abra uma página com vídeo, aguarde alguns segundos e clique no ícone da
   extensão.

## Atualização: botão sobre o vídeo + correção de duplicatas (Instagram)

Depois do primeiro teste real (Instagram), dois problemas apareceram e foram
corrigidos:

1. **"18 vídeos" de 332 B cada, todos do mesmo domínio**: o CDN do
   Instagram (`fbcdn.net`) serve vídeo por range request, e cada
   chunk/probe vinha com uma querystring assinada totalmente diferente
   (`oe`, `oh`, `_nc_ht`, `bytestart`/`byteend` etc.). A deduplicação só
   ignorava uma lista fixa de parâmetros conhecidos (`token`, `expires`...)
   e não esses — cada chunk virava uma entrada nova. Corrigido em duas
   frentes: (a) `groupKey`/`mediaKey` agora ignoram a querystring inteira,
   agrupando pelo caminho (`utils/id.js`); (b) o tamanho estimado agora usa
   o total do header `Content-Range` quando presente (não o `Content-Length`
   do chunk isolado), e uma resposta minúscula sem `Content-Range` é
   descartada por não ser um vídeo de verdade (`MIN_PLAUSIBLE_DIRECT_VIDEO_BYTES`
   em `background/service-worker.js`). Teste de regressão em
   `tests/id.test.mjs`.
2. **Botão direto em cada vídeo da página** (`content/overlay-ui.js`): em
   vez de depender só da lista no popup, cada `<video>` detectado agora
   ganha um botão "Baixar" sobreposto no próprio canto do player, que
   acompanha scroll/resize (via `requestAnimationFrame` + `ResizeObserver`,
   isolado em Shadow DOM para não vazar CSS de/para a página). Clicar nele
   baixa a melhor qualidade daquele vídeo específico direto, com o mesmo
   feedback de progresso (spinner → percentual → concluído/erro) exibido
   no próprio botão. O popup continua existindo para escolher outras
   qualidades manualmente.

Limitação nova conhecida: se o vídeo estiver dentro de um `<iframe>`
cross-origin, o botão fica confinado à área visível do iframe (limitação
de `position: fixed` em navegador, não tem como desenhar fora do frame sem
mensageria adicional entre frames — não implementado nesta fase). E se o
navegador servir o vídeo inteiramente do cache de disco sem gerar evento
de rede, a extensão pode não ter classificado o recurso a tempo do clique
("Nenhum vídeo encontrado nesta aba").

## Segunda atualização: botão travado em "Analisando…" + suporte a blob local

Testando numa página com uma gravação local (webcam/tela, tipo
MediaRecorder — `<video src="blob:...">` sem nenhuma requisição de rede
correspondente), dois problemas apareceram:

1. **Botão travava para sempre em "Analisando…"**: quando o download falha
   ou termina de forma efetivamente síncrona (ex.: cai no branch "Formato
   não suportado", que não tinha nenhum `await` antes de lançar o erro), o
   primeiro push de progresso podia chegar ao content script ANTES da
   resposta da mensagem inicial — e nesse momento o botão ainda não sabia
   seu próprio `downloadKey` (só aprendia isso pela resposta), então
   descartava o push por não conseguir casar com nada. Corrigido: o botão
   agora gera um `requestId` **antes** de enviar a mensagem e guarda isso
   localmente de forma síncrona; todo push de progresso carrega esse
   mesmo `requestId`, então o primeiro push já casa mesmo chegando antes
   da resposta (`content/overlay-ui.js` + `requestId` propagado em
   `background/service-worker.js`).
2. **Blob sem fonte de rede correspondente (gravação local) não baixava**:
   antes, qualquer grupo `blob` sem uma URL de rede correlacionada caía em
   "Formato não suportado" — mas nem todo `blob:` vem de streaming
   adaptativo; um `MediaRecorder` gera o vídeo inteiramente no lado do
   cliente, sem nenhuma requisição HTTP para observar. Implementado um
   caminho de download dedicado: o background pede ao content script da
   aba para ler os bytes do `blob:` diretamente (só é resolvível no
   documento que criou o blob), que faz `fetch(blobUrl)` na própria
   página e devolve o conteúdo; o background monta o arquivo e dispara o
   download normalmente. Funciona bem para gravações locais completas;
   para um blob alimentado por MediaSource/streaming, o resultado é só o
   que estiver bufferizado no momento (limite de segurança: 300 MB).
   Passou a valer tanto pelo botão sobreposto quanto pelo popup.
3. **Mensagens de erro corretas**: "Formato não suportado" e "Stream ainda
   não carregada" (mensagens já aprovadas no escopo do projeto) estavam
   sendo engolidas por um fallback genérico ("Erro ao processar o
   download") por não baterem em nenhum padrão de regex reconhecido.
   Corrigido com uma lista de passagem direta.

## Terceira atualização: blob revogado antes do download (Instagram) —
## captura na criação, não na URL

Testando no Instagram, o download de blob ainda falhava, agora com
`net::ERR_FILE_NOT_FOUND` ao tentar `fetch()` na URL blob — confirmado via
console (F12). Causa: o player revoga a URL (`URL.revokeObjectURL`) muito
pouco depois de criá-la, então por mais "fresca" que a extensão tenha
achado a URL, tentar buscá-la de novo mais tarde (quando o usuário clica
em baixar) já não funciona — a URL simplesmente não existe mais no
registro do navegador.

Correção: em vez de tentar `fetch()` na URL blob (que depende dela
continuar válida), `content/page-hook.js` agora intercepta, no MAIN world
da própria página:

- `URL.createObjectURL(blob)` — guarda uma referência ao objeto `Blob` em
  si (não à URL). Um objeto Blob continua legível via `.arrayBuffer()`
  mesmo depois da URL que apontava para ele ser revogada. Cobre gravações
  locais (MediaRecorder) e qualquer blob simples.
- `SourceBuffer.appendBuffer(chunk)` — guarda cada pedaço de dados
  conforme o player alimenta o `MediaSource` (esse é o mecanismo real por
  trás da maioria dos players de streaming adaptativo, Instagram
  provavelmente incluso). Na hora do download, os pedaços já capturados
  são concatenados na ordem em que foram anexados.

Quando o usuário clica em baixar, `content/video-detector.js` pede esses
dados já capturados ao `page-hook.js` (ponte via `postMessage` entre os
dois mundos), em vez de tentar buscar a URL na rede.

Limitação desse caminho: só existe o que já foi capturado — se o usuário
clicar em baixar antes do vídeo ter sido reproduzido/bufferizado por
completo, o arquivo final reflete só o que já passou pelo player até ali.

(O outro item que estava listado aqui — múltiplos `SourceBuffer`, ex.:
áudio e vídeo em streams separados, descartando um deles — foi corrigido
de verdade na "Quinta atualização" abaixo, não é mais uma limitação.)

## Quarta atualização: extensão não baixava vídeo nenhum — causa raiz

Depois das atualizações anteriores, um teste real relatou que a extensão
**não conseguia baixar vídeo nenhum**, em qualquer site. Desta vez foi
possível reproduzir e depurar de ponta a ponta com um navegador Chromium
de verdade (Playwright carregando a extensão sem compactação — ver
`tests/e2e/`), em vez de só inspecionar o código. Cinco bugs reais foram
encontrados e corrigidos; os quatro primeiros bloqueavam o download quase
completamente, o quinto corrompia o nome do arquivo final.

1. **Causa raiz do "não baixa nada": `URL.createObjectURL` não existe no
   service worker do Manifest V3.** Todo caminho de download que não seja
   um único arquivo MP4/WebM direto — ou seja, **HLS, DASH e blob/
   MediaSource, que é como a esmagadora maioria dos vídeos na web real é
   servida hoje** (Instagram, TikTok, YouTube, a maior parte dos players
   de streaming adaptativo) — monta o vídeo final como um `Blob` em
   memória e precisava de um object URL (`blob:...`) para entregar isso a
   `chrome.downloads.download()`. `URL.createObjectURL` existe em
   qualquer página normal, mas **não existe no contexto do service
   worker** (confirmado em runtime: `typeof URL.createObjectURL` é
   `undefined` lá) — então toda chamada batia num
   `TypeError: URL.createObjectURL is not a function` e o download
   simplesmente falhava com "Erro ao processar o download", sem nenhuma
   pista visível de que a causa era essa. Isso por si só já explica o
   sintoma relatado: qualquer vídeo real de um site como Instagram usa
   `blob:`/MediaSource, então caía direto nesse erro.
2. **`chrome.downloads.download({ filename })` é ignorado** para URLs
   `blob:`/`data:` — e também para URLs `http(s)` normais sempre que o
   nome desejado não é exatamente igual ao nome que já está na própria
   URL. Testado isoladamente e confirmado: pedir para baixar
   `.../abc123.mp4` como `"Meu_Video.mp4"` resulta em `abc123.mp4` salvo
   — o parâmetro é simplesmente ignorado nesta versão do Chrome, com ou
   sem `chrome.downloads.onDeterminingFilename` (também testado — não
   dispara neste ambiente). Sem isso, mesmo depois de resolver o bug #1,
   todo download acabaria salvo como `download`/`download.mp4`, sem
   usar o título do vídeo/página como o projeto pede.
3. **`chrome.runtime.sendMessage` não entrega um `ArrayBuffer` bruto de
   forma confiável** entre o service worker e um documento offscreen — o
   `Blob` reconstruído do lado de lá virava o texto literal
   `"[object Object]"` (15 bytes) em vez do conteúdo real do vídeo.
   Descoberto tentando corrigir o bug #1 via `chrome.offscreen`: os bytes
   agora viajam como base64 (mesma técnica que já era usada, e já
   funcionava, entre o content script e o service worker para blob
   local).
4. **Bug real no parser DASH**: `getAttr()` (`parsers/dash-parser.js`)
   usava um regex sem checagem de limite antes do nome do atributo, então
   `width="..."` batia dentro do sufixo de `bandwidth="..."` e pegava o
   valor de `bandwidth` por engano — sempre que `bandwidth` vinha antes
   de `width` no mesmo elemento, que é a ordem mais comum em manifests
   DASH reais (inclusive a que o próprio `ffmpeg` gera). Os testes
   unitários existentes não pegavam isso porque os manifestos de teste
   colocavam `width` antes de `bandwidth`. Corrigido, com teste de
   regressão em `tests/dash-parser.test.mjs` usando a ordem de atributos
   do ffmpeg.
5. **Título/`og:title` da página não chegava ao nome do arquivo com
   alguma frequência**: `ensureGroup()` (`background/service-worker.js`)
   só preenchia `pageTitle`/`ogTitle` no momento em que um grupo de vídeo
   era **criado**. Só que a detecção por rede (`webRequest`) e a
   detecção pelo content script (que é quem manda o título/og:title da
   página) chegam em ordens não determinísticas — quando a rede
   detectava o vídeo primeiro (comum, já que a requisição começa quase
   junto com o carregamento da página), o grupo nascia sem título nenhum
   e **nunca mais era atualizado**, mesmo o content script mandando o
   título certo segundos depois. Resultado: nome de arquivo caía direto
   para o nome extraído da URL, ignorando um `<title>`/`og:title`
   perfeitamente presente na página. Corrigido: `ensureGroup()` agora
   também reatualiza esses campos num grupo já existente (nunca apaga um
   valor bom com um nulo).

### Arquitetura de download depois desta correção

Todo download que precisa de um `Blob` montado em memória (HLS, DASH,
blob/MediaSource, **e agora também o MP4/WebM direto**, unificado pelo
mesmo motivo do bug #2 acima) passa pelo mesmo caminho:

1. O service worker busca/monta os bytes (fetch de segmentos, ou lê o
   que o content script capturou de um `blob:`) e produz um `Blob`.
2. `downloader/segment-downloader.js` (`downloadBlob`) manda esses bytes,
   em base64, para um **documento offscreen** (`offscreen/offscreen.js`)
   — a peça de Manifest V3 feita exatamente para dar acesso a APIs de DOM
   que o service worker não tem.
3. O documento offscreen decodifica o base64, cria o `Blob` e o object
   URL **ali mesmo**, e dispara o download através do mecanismo nativo do
   HTML — um `<a href="blob:..." download="nome">` clicado
   programaticamente — em vez de `chrome.downloads.download()`. Isso
   importa por dois motivos: (a) um `blob:` URL só é resolvível pelo
   mesmo contexto de execução que o criou, então criar no offscreen e
   baixar via `chrome.downloads.download()` chamado do service worker
   falha com `FILE_FAILED`; chamar `chrome.downloads.download()`
   diretamente do offscreen também não funciona, porque documentos
   offscreen não têm acesso a `chrome.downloads`; (b) o atributo
   `download` do HTML respeita o nome do arquivo de forma confiável para
   `blob:`, ao contrário da opção `filename` da API (bug #2).
4. O clique ainda gera uma entrada normal em `chrome.downloads` (é o
   mesmo mecanismo nativo do navegador por trás), que o service worker
   localiza depois por URL exata (`findDownloadIdByUrl`) para acompanhar
   progresso/conclusão do jeito que a UI já esperava.

Documentado com mais detalhe nos comentários de
`downloader/segment-downloader.js` e `offscreen/offscreen.js`. Permissão
nova no manifesto: `offscreen`.

## Quinta atualização: vídeo baixava sem áudio (players com SourceBuffer de vídeo e áudio separados, ex.: YouTube/Instagram)

Relato real: um vídeo baixado veio **sem áudio nenhum** (não deu erro,
o arquivo só saiu mudo). Três bugs, encontrados testando contra um vídeo
real do YouTube e depois validados contra um post real do Instagram — os
dois primeiros em como a extensão lê dados de um
`<video src="blob:...">` alimentado via `MediaSource` (ver "Terceira
atualização" acima para o mecanismo geral), o terceiro no nome do
arquivo final:

1. **Áudio descartado de propósito quando o player usa dois
   `SourceBuffer`s** (um só de vídeo, outro só de áudio — em vez de um
   único stream com os dois já muxados). É assim que o YouTube entrega
   mídia via MSE, e não é incomum em outros players adaptativos também.
   `resolveBlobContent()` (`content/page-hook.js`) tinha uma heurística
   "MVP" que **mantinha só o `SourceBuffer` com mais bytes acumulados**
   (normalmente o de vídeo, por ser maior) e **descartava os outros em
   silêncio** — download "funcionava" sem erro nenhum, só que o arquivo
   final não tinha a faixa de áudio. Corrigido: agora todos os
   `SourceBuffer`s com dados capturados são devolvidos como streams
   separados, e cada um vira um arquivo (`_video`/`_audio`) — o mesmo
   padrão que HLS/DASH já usam quando o áudio vem em rendition/
   Representation separada. Mux automático num único arquivo continua
   fora do escopo do MVP (mesma limitação documentada para DASH).
2. **Bug relacionado, encontrado corrigindo o #1**: o `mimeType` real de
   um `SourceBuffer` costuma vir com parâmetros de codec entre aspas e
   com vírgula dentro (ex.: `video/mp4; codecs="avc1.4d401f,
   mp4a.40.2"`). Usar essa string inteira para montar o `data:` URI do
   download (`background/service-worker.js`) quebra a codificação — a
   vírgula dentro das aspas do `codecs` é confundida com o separador de
   dados do `data:` URI, e o arquivo final sai maior que o esperado e
   corrompido. Corrigido: só o tipo base (`video/mp4`, sem os
   parâmetros) é usado a partir da captura (`baseMimeType()` em
   `content/page-hook.js`) — os codecs em si não fazem diferença para o
   Blob final.

Os dois cobertos por um cenário novo em `tests/e2e/run.mjs`
("Blob/MediaSource com vídeo e áudio em SourceBuffers separados") que
alimenta dois `SourceBuffer`s de verdade (vídeo e áudio) e confere que os
**dois** arquivos saem completos.

Validado também contra um post público real do Instagram (não só o
fixture sintético): o player de vídeo do Instagram usa exatamente esse
padrão de dois `SourceBuffer`s, e depois da correção os dois arquivos
(vídeo de 765993 bytes + áudio de 67339 bytes, ambos validados com
`ffprobe`) baixaram completos e corretos.

3. **Terceiro bug, encontrado no mesmo teste contra o Instagram real**: o
   `og:title` de um post do Instagram é a **legenda inteira do post**, que
   pode ter centenas de caracteres. Isso gerava um nome de arquivo tão
   comprido que, somado à pasta de downloads do usuário, o **caminho
   completo passava dos ~260 caracteres que o Windows aceita**
   (`MAX_PATH`) — o download falhava com `FILE_FAILED`, um erro genérico
   do Chrome sem nenhuma pista visível da causa real. Corrigido:
   `buildFilename()`/`sanitizeFilename()` (`utils/filename.js`) agora
   limitam o **nome de arquivo final** (não só o título) a 80 caracteres,
   cortando sempre o título — nunca o sufixo de qualidade/áudio nem a
   extensão, que carregam informação que o usuário precisa. Teste de
   regressão em `tests/filename.test.mjs` usando a legenda real que
   causou o problema.

## O que foi implementado

- **Manifest V3** completo, com permissões mínimas necessárias
  (`downloads`, `storage`, `tabs`, `webRequest`, `scripting`, `activeTab`,
  `offscreen` + `host_permissions: <all_urls>`, necessário para observar
  requisições de mídia em qualquer site). `offscreen` existe só para
  contornar a ausência de `URL.createObjectURL` no service worker — ver
  "Quarta atualização" acima.
- **Detecção de `<video>`/`<source>`**: varredura inicial + `MutationObserver`
  (debounced) para players carregados dinamicamente, e listener de `play`
  para vídeos que só resolvem a fonte real após interação do usuário.
- **MP4/WebM direto**: detectado via `webRequest.onHeadersReceived`
  (Content-Type e extensão) e via atributo `src`/`<source>` do elemento.
- **HLS (.m3u8)**: parser completo de master e media playlist
  (`parsers/hls-parser.js`) — variantes, resolução, bandwidth, codecs,
  grupo de áudio separado, `EXT-X-MAP` (init segment fMP4), `EXT-X-KEY`.
  Download real via download+concatenação de segmentos em ordem
  (remux por concatenação, sem recodificação).
- **DASH (.mpd)**: parser de manifesto (`parsers/dash-parser.js`) sem
  depender de `DOMParser` (indisponível no service worker) —
  AdaptationSet/Representation, `SegmentTemplate` (`$Number$`, `$Time$`,
  `SegmentTimeline`), `SegmentList`, `SegmentBase`/arquivo único,
  `ContentProtection`. Download real de vídeo e, quando separado, do
  áudio correspondente.
- **Blob / MediaSource**: `content/page-hook.js` (injetado no MAIN world da
  página) observa `MediaSource.addSourceBuffer`, `fetch` e `XMLHttpRequest`
  para tentar correlacionar a fonte real por trás de um `<video
  src="blob:...">` com uma URL de mídia detectada na rede.
- **Detecção de DRM (somente informativa)**: EME
  (`requestMediaKeySystemAccess`, evento `encrypted`), `EXT-X-KEY` com
  `KEYFORMAT` proprietário (HLS) e `ContentProtection` (DASH/Widevine,
  PlayReady, FairPlay). Quando detectado, a extensão **bloqueia o
  download** e mostra "Conteúdo protegido por DRM" — nenhuma tentativa de
  contornar, decifrar ou extrair chaves é feita.
- **Agrupamento e deduplicação** de qualidades por vídeo
  (`utils/id.js`), com seleção automática da melhor qualidade.
- **Popup** moderno com card por vídeo, botão "BAIXAR MELHOR QUALIDADE",
  lista de outras qualidades, progresso de download em tempo real e aviso
  de DRM.
- **Estados de download**: Detectado → Analisando → Preparando → Baixando
  vídeo/áudio → Finalizando → Concluído / Erro, com percentual.
- **Nome de arquivo**: prioridade título do vídeo > OpenGraph > `<title>`
  da página > nome extraído da URL, sanitizado (`utils/filename.js`).
- **Logs em níveis** (DEBUG/INFO/WARN/ERROR), DEBUG desativado por padrão;
  pode ser ativado pelo checkbox no rodapé do popup.
- **Limpeza por aba**: estado removido ao fechar a aba; reiniciado ao
  navegar para uma nova página.

## Limitações conhecidas (fase 2, fora do MVP)

- **Mux real de áudio+vídeo**: quando o DASH entrega áudio e vídeo em
  streams separados, a extensão baixa **dois arquivos** (`..._1080p.mp4`
  e `..._1080p_audio.mp4`) em vez de juntá-los automaticamente num único
  MP4. Mux automático (remux sem recodificação) é o próximo passo.
- **HLS com áudio em rendition separada** (`EXT-X-MEDIA:TYPE=AUDIO` com
  URI própria, comum em HLS fMP4/CMAF): hoje baixa apenas o vídeo; o
  áudio separado ainda não é baixado automaticamente.
- **HLS com criptografia AES-128 "simples"** (`EXT-X-KEY` sem
  `KEYFORMAT` proprietário — não é DRM, mas exige descriptografia
  AES-128-CBC): não suportado ainda, retorna "Formato não suportado".
- **DASH com `SegmentTemplate` por `@duration` sem `SegmentTimeline` e sem
  duração do período conhecida**: não é possível calcular o número de
  segmentos com segurança; retorna "Stream ainda não carregada".
- **Blob sem correlação de rede**: se a extensão não conseguir associar o
  `blob:` a nenhuma URL de mídia real vista na rede, o download fica
  desabilitado para esse item (não há extração de dados de dentro do
  `MediaSource`/`SourceBuffer`).
- **Detecção de DRM via EME é heurística**: alguns players chamam
  `requestMediaKeySystemAccess` apenas para checar capacidade, sem
  necessariamente reproduzir conteúdo protegido. Isso pode gerar
  falso-positivo ocasional marcando um vídeo `blob:` como DRM quando não
  é. Ajuste fino fica para uma próxima iteração.
- **Um único grupo "blob" por página**: se a página tiver múltiplos
  vídeos distintos via `blob:` simultaneamente, o MVP os trata como um
  único grupo (limitação de agrupamento, não de detecção).
- **Sem ícones customizados**: a extensão usa o ícone padrão do Chrome
  (peça de quebra-cabeça) — não é bloqueante para uso/teste.

## O que **não** foi e não será implementado

Por definição do escopo (e por exigência legal — Lei 9.610/98, art. 107):
quebra de DRM, extração de chaves, interceptação de licenças,
descriptografia de mídia protegida, bypass de Widevine/PlayReady/FairPlay.
A extensão apenas **detecta e informa** a presença de DRM.

## Testes

Duas camadas, propositalmente separadas — a lição da "Quarta atualização"
acima foi que boa parte dos bugs reais só existe no comportamento de
runtime do navegador (service worker, `chrome.downloads`, documentos
offscreen, `webRequest`), então a camada de lógica pura sozinha não é
suficiente para confiar que "baixar vídeo" funciona de verdade.

### 1. Lógica pura (parsers, classificador, filename, dedupe) — roda em Node, sem navegador

```bash
cd extension
node tests/run-all.mjs
# ou: npm test
```

Cobrem: HLS (master/media playlist, áudio separado, `EXT-X-MAP`, DRM via
`EXT-X-KEY`, playlist ao vivo), DASH (`SegmentList`, `SegmentTemplate` +
`SegmentTimeline`, resolução de URLs relativas, `ContentProtection`,
regressão do bug `width`/`bandwidth` — ver "Quarta atualização"),
classificação por Content-Type/extensão, geração/sanitização de nome de
arquivo, deduplicação e agrupamento por URL normalizada.

Estado atual: **33/33 testes passando**.

### 2. End-to-end (`tests/e2e/`) — carrega a extensão de verdade num Chromium real

Usa Playwright para carregar a extensão **sem compactação**, exatamente
como `chrome://extensions` faz, e baixar vídeo de verdade de um servidor
HTTP local que simula um CDN de vídeo real (responde range request com
206 + `Content-Range`, como o `fbcdn.net` do Instagram). Foi assim que os
5 bugs da "Quarta atualização" foram encontrados — nenhum deles aparecia
rodando só a lógica pura.

Instalação (só precisa fazer uma vez; baixa um Chromium próprio do
Playwright, não usa o Chrome instalado no sistema):

```bash
cd extension
npm install
npx playwright install chromium
```

Rodar:

```bash
node tests/e2e/run.mjs
# ou: npm run test:e2e
# ou os dois: npm run test:all
```

Cenários cobertos, cada um baixando o vídeo de ponta a ponta e checando
o arquivo final (tamanho em bytes e nome de arquivo, não só "não deu
erro"):

- **MP4 direto**: download via popup, nome de arquivo vem do `<title>`
  da página.
- **Feed estilo Instagram** (3 vídeos autoplay/loop, cada um com
  querystring assinada tipo `?token=...&oe=...&oh=...`): deduplicação
  correta (3 vídeos distintos, não dezenas de fragmentos), download pelo
  **botão sobreposto no vídeo** (não o popup — é o fluxo real de uso),
  nome de arquivo vem do `og:title` da página.
- **HLS**: parse de media playlist + download/concatenação de 3
  segmentos `.ts`.
- **DASH**: parse de manifesto com vídeo+áudio em `AdaptationSet`
  separados (gerado pelo `ffmpeg`, mesma ordem de atributos
  `bandwidth`/`width` que causava o bug #4 da "Quarta atualização") +
  download dos dois arquivos.
- **Blob/MediaSource** (o caso mais próximo do Instagram real): um vídeo
  alimentado via `MediaSource.addSourceBuffer`/`appendBuffer` em pedaços,
  sem nenhuma URL de rede direta — captura via `content/page-hook.js` +
  download pelo botão sobreposto.
- **Blob/MediaSource com vídeo e áudio em `SourceBuffer`s separados**
  (estilo YouTube — ver "Quinta atualização"): confere que os **dois**
  arquivos (vídeo e áudio) saem completos, não só o maior dos dois.

Não cobre (ainda precisa de teste manual, ver abaixo): DRM/EME real,
sites de terceiros de verdade (Instagram/TikTok/etc. — os fixtures são
servidos localmente), variação entre versões do Chrome/Edge instaladas
em outras máquinas.

### 3. Manual (contra sites reais, antes de cada release)

- Página com DRM (ex.: um serviço de streaming com Widevine) — deve
  aparecer "Conteúdo protegido por DRM" e o download deve ficar
  bloqueado.
- Pelo menos um site real de cada categoria (feed tipo Instagram/TikTok,
  HLS, DASH) — os fixtures do E2E são sintéticos; sites reais têm
  variações que vale a pena checar de vez em quando (headers extras,
  manifests mais complexos, CDNs diferentes).
- Interface do popup num navegador de verdade (nenhum vídeo, um vídeo,
  vários vídeos, download ativo, erro) — o E2E dirige o popup por
  mensagem, não valida pixel a pixel.
