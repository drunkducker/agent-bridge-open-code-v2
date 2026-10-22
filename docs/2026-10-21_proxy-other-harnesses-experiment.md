# Experimento real: caminhos API de Claude, Antigravity e OpenCode

**Conclusão: persistência é uma opção concreta para Claude, mas o primeiro problema a corrigir é a ligação das ferramentas do cliente no caminho atual. No agy, a amostra teve timeouts nos dois caminhos e não confirmou ganho consistente. No OpenCode/GLM gratuito, incompatibilidade v2 e restrição do provedor impediram concluir o ciclo API. Nenhum transporte direto foi implementado: as condições dos logins disponíveis não sustentaram esse uso independente.**

Executado em 21/10/2026, horário de São Paulo; os JSON usam timestamps UTC. AgentBridge **v0.6.0, HEAD `dabb7e2`**, compilado novamente em worktree temporário. Somente experimentos: **nenhum arquivo de produção alterado, nenhum commit, login novo, extração de token ou gravação de headers de autenticação**. Os CLIs oficiais continuam responsáveis pelo próprio login. A cópia temporária do CLIProxyAPI foi estudada, sem instalar ou executar o programa, e removida ao final.

Cada harness é comparado **apenas com seus próprios caminhos**. Não se trata de um ranking entre modelos ou harnesses. **Codex não foi executado novamente**; seu estudo permanece em [proxy-live-experiment](2026-10-21_proxy-live-experiment.md).

## O que foi comparado

1. **AgentBridge atual:** `/v1/chat/completions`, modo API, `stream: true`, adaptador de produção, spawn por requisição. No OpenCode, o adaptador verificou a versão e recusou v2 antes da geração.
2. **Persistente experimental:** mesma interface HTTP/SSE, adaptador injetado. Claude e agy mantêm stdin NDJSON aberto no binário oficial. OpenCode mantém um servidor v2 privado e usa `/api/experimental/generate` sem ferramentas nativas. A resposta JSON dessa rota é bufferizada pelo protótipo.
3. **Direto mínimo:** estudado no CLIProxyAPI e na documentação dos provedores, mas **não implementado nem medido** para os logins/modelos disponíveis. As razões estão abaixo; não foram atribuídos tempos ou acertos a esses caminhos.

Modelos fixos: Claude **`haiku`**, agy **`gemini-3.8-flash-low`**, OpenCode **`opencode/glm-5.3-flash-free`**. Não houve substituição por modelo pago. O servidor OpenCode encontrado foi **v2.1.2** e confirmou o GLM solicitado como habilitado.

### Tarefas e critérios

- **Resposta curta:** `Responda exatamente: PONTE_OK`, três tentativas por caminho, ordem atual/persistente, persistente/atual, atual/persistente. O acerto exige igualdade do texto após trim.
- **Ferramenta do cliente:** pedir `consultar_estoque({"sku":"CANECA-AZUL"})`, validar nome e argumento, ler uma fixture JSON real com quantidade 17, devolver esse resultado na segunda chamada e exigir `Estoque: 17 unidades.`. Uma execução do ciclo por caminho, como no estudo Codex.
- **Streaming:** tempo até o primeiro conteúdo textual e até o primeiro fragmento **não vazio** de `function.arguments`; contagem de deltas de texto, de tool calls e de argumentos. Um chunk só com nome/ID da ferramenta não é contado como argumento.
- **Latência:** início do fetch até fim do SSE, incluindo o wrapper local. O ciclo soma as duas requisições; não inclui a leitura local da fixture. Os erros conservam o tempo até a falha. A mediana das três tentativas inclui falhas e está identificada; também apresentamos a mediana das respostas corretas quando houve timeout.
- **Verificação:** três respostas curtas + pedido de ferramenta + resposta final = cinco verificações previstas por caminho. Quando o primeiro pedido não foi válido, a segunda chamada não foi feita. Isso aparece explicitamente, sem transformar uma chamada omitida em sucesso.

Os processos stdio persistentes retêm uma conversa. Não são um pool de requisições independentes: contexto, cache, papéis das instruções e aquecimento diferem. O sistema inicial fica fixo; schemas/instruções alterados são enviados no texto da nova entrada. As diferenças medidas são dos caminhos completos, **não uma medição isolada do custo de spawn**. A primeira chamada stdio inclui a criação do processo; o servidor OpenCode é iniciado antes das medições, com inicialização registrada separadamente.

## Claude / Haiku

Tempos em segundos, arredondados.

| Medida | AgentBridge atual | Persistente experimental | Direto mínimo |
|---|---:|---:|---|
| Resposta curta, mediana de três | 3,09 | 1,24 | Não implementado |
| Três tempos observados | 3,48 / 2,48 / 3,09 | 1,89 / 1,05 / 1,24 | — |
| Respostas curtas corretas | 3/3 | 3/3 | Não medido |
| Primeiro texto, mediana | 2,12 | 0,96 | — |
| Deltas de texto nas três respostas | 1 / 1 / 1 | 1 / 1 / 1 | — |
| Pedido de estoque | 4,43; ferramenta ausente | 1,15; correto | — |
| Resposta após resultado | Não realizada | 1,09; correta | — |
| Ciclo completo | Não concluiu | 2,24 | — |
| Primeiros argumentos da ferramenta | Não chegaram | 1,15 | — |
| Chunks de tool call / argumentos, no pedido | 0 / 0 | 2 / 1 | — |
| Deltas de texto na resposta final | Não realizada | 2 | — |
| Verificações corretas / executadas | 3/4; faltou a quinta | 5/5 | Não medido |

Um processo persistente atendeu cinco turnos. A mediana curta foi cerca de 2,5 vezes menor nesta amostra, mas isso inclui a conversa aquecida e não demonstra o mesmo ganho em chamadas independentes, contexto longo ou concorrência.

### Falha funcional encontrada e controle

O caminho atual respondeu que `consultar_estoque` não estava disponível. A inspeção offline do mesmo despacho confirmou:

- instruções para usar uma ponte nativa presentes;
- `mcpServerNames: []`;
- schemas `<tools>` ausentes;
- `extraArgs: ["--tools", ""]`.

A ponte monta `mcpServers` em [tools/run.ts](../src/server/tools/run.ts), mas [common.ts](../src/server/common.ts) só os transfere para as opções do adaptador quando `isAgent` é verdadeiro. A chamada estudada é API. O resultado real e o diagnóstico sustentam um defeito de ligação da ponte, não incapacidade do Haiku de usar a ferramenta.

Para separar esse defeito da persistência, fiz um controle **ainda com spawn por requisição**, injetando o adaptador original para selecionar a emulação textual usada no protótipo. Ele concluiu as duas chamadas: **2,24 s + 3,34 s = 5,58 s**, com um evento de argumentos no pedido, chegando em 2,24 s. Logo, **a ferramenta funciona sem persistir o processo** quando schema e instruções chegam por esse outro caminho.

A seleção por objeto injetado muda a estratégia de ferramentas: [runTools](../src/server/tools/run.ts) escolhe a ponte nativa somente quando o destino é a string `claude`. Isso impede atribuir toda a diferença do ciclo à persistência. Não alterei esse comportamento de produção, conforme o escopo solicitado.

**O que vale para nós:** corrigir primeiro o encaminhamento da ponte MCP e sua regressão HTTP. Depois, avaliar stdio persistente por conversa, com isolamento entre clientes, schemas, cancelamento, timeout, reinício e encerramento. O protótipo é evidência de viabilidade e não uma implementação pronta para ativação global.

Dados: [Claude JSON](research/claude-proxy-paths-results.json), incluindo `currentDispatchDiagnostic` e `spawnEmulationControl`. Script: [compare-claude-proxy-live.mjs](../scripts/research/compare-claude-proxy-live.mjs).

## Antigravity / Gemini 3.8 Flash Low

| Medida | AgentBridge atual | Persistente experimental | Direto mínimo |
|---|---:|---:|---|
| Mediana das três tentativas, incluindo timeout | 6,77 | 65,58 | Não implementado |
| Três tempos observados | 90,32 timeout / 5,58 / 6,77 | 65,58 / 1,98 / 90,01 timeout | — |
| Respostas curtas corretas | 2/3 | 2/3 | Não medido |
| Mediana apenas das duas respostas corretas | 6,18 | 33,78 | — |
| Primeiro texto, mediana apenas das corretas | 5,68 | 33,73 | — |
| Deltas de texto nas três respostas | — / 2 / 2 | 3 / 3 / — | — |
| Pedido de estoque | 90,27; timeout | 4,23; correto | — |
| Resposta após resultado | Não realizada | 2,60; correta | — |
| Ciclo completo | Não concluiu | 6,83 | — |
| Primeiros argumentos da ferramenta | Não chegaram | 4,23 | — |
| Chunks de tool call / argumentos, no pedido | — | 2 / 1 | — |
| Deltas de texto na resposta final | Não realizada | 2 | — |
| Verificações corretas / executadas | 2/4; faltou a quinta | 4/5 | Não medido |

Os timeouts ocorreram em 90 s. No adaptador atual apareceram como HTTP 504; no protótipo, o erro de timeout genérico foi mapeado para HTTP 502, com mensagem `Persistent turn timed out`. São limites atingidos, não tempos conhecidos de conclusão do modelo. O traço `—` nas contagens significa que a medição falhou, não uma propriedade inferida do streaming interno.

O persistente teve **dois processos**: o primeiro foi encerrado após o timeout; a tarefa de estoque posterior iniciou outro. A chamada que falhou não foi repetida silenciosamente. Houve quatro turnos concluídos. Apesar de uma resposta curta em 1,98 s e de um ciclo de ferramenta correto, a amostra **não sustenta vantagem estável de latência ou confiabilidade**.

A [documentação oficial de headless](https://www.antigravity.google/docs/cli/headless/) descreve stdin contínuo, um `result` por turno e fechamento ao encerrar stdin. Não foi necessário inventar ACP nem acessar o backend privado. Os argumentos do cliente chegaram reconstruídos ao fim da emulação; não houve demonstração de fragmentos nativos progressivos de argumentos.

**O que vale para nós:** tratar a persistência como experimento, sem promovê-la como padrão por velocidade. Antes disso, medir estabilidade e cancelamento em amostra maior e confirmar o enquadramento contratual. A documentação de consumidor restringe wrappers, como explicado abaixo; este teste local não concede autorização para implantação.

Dados: [agy JSON](research/agy-proxy-paths-results.json). Script: [compare-agy-proxy-live.mjs](../scripts/research/compare-agy-proxy-live.mjs).

## OpenCode / GLM-5.3-Flash Free

**Nenhuma resposta de inferência válida foi obtida neste modo API. Os números baixos abaixo são tempos de rejeição, não desempenho de geração.**

| Medida | AgentBridge atual | Servidor v2 experimental | Direto mínimo |
|---|---|---|---|
| Respostas curtas corretas | 0/3 | 0/3 | Não implementado |
| Resultado das três tentativas | HTTP 400, v2 incompatível | HTTP 502; servidor respondeu 503 | — |
| Tempos até rejeição | 0,123 / 0,006 / 0,005 s | 0,758 / 0,194 / 0,187 s | — |
| Mediana até rejeição | 0,006 s | 0,194 s | — |
| Latência de geração válida | Não medida | Não medida | Não medida |
| Pedido de estoque | Falhou antes da inferência | Recusado pelo servidor/provedor | — |
| Segunda chamada do ciclo | Não realizada | Não realizada | — |
| Primeiro texto / argumentos / eventos válidos | Não medidos | Não medidos | — |
| Verificações corretas / executadas | 0/4; faltou a quinta | 0/4; faltou a quinta | Não medido |

O servidor privado v2.1.2 inicializou em **0,34 s**. Isso não resolveu os dois bloqueios distintos:

1. O adaptador de produção v0.6.0 usa o protocolo v1 e recusa v2 com erro explícito. Não sugeriu novo login.
2. A rota de geração do servidor v2 recusou o modo testado. Um diagnóstico adicional preservou a causa: a camada gratuita só pode ser usada dentro do OpenCode. A rota retornou `ServiceUnavailableError`/503; uma sessão nativa com **todas as ferramentas negadas** também falhou com `provider.auth`/403, mantendo o GLM solicitado. Portanto, a falha não se limitou ao nome de uma rota experimental.

Não habilitei ferramentas locais no modo API para satisfazer uma verificação do provedor, não imitei headers de outro cliente, não extraí chaves e não substituí o modelo. Sucesso anterior de um **agente** OpenCode lendo arquivos, registrado no [estudo GLM anterior](2026-10-21_opencode-glm53-experiment.md), não prova suporte a este ciclo API com ferramentas executadas pelo cliente.

**O que vale para nós:** priorizar a compatibilidade v2 para os usos nativos suportados e validar separadamente o contrato API por provedor/modelo. Reutilizar `opencode serve` é uma possibilidade de transporte; não torna automaticamente o GLM gratuito um endpoint API independente. Para um transporte direto, seria necessária uma credencial e modalidade de API autorizadas, sem presumir que o acesso gratuito do CLI se transfere para elas.

Dados: [OpenCode JSON](research/opencode-proxy-paths-results.json), inclusive `routeDiagnostics` com ambas as recusas. Script: [compare-opencode-proxy-live.mjs](../scripts/research/compare-opencode-proxy-live.mjs).

## O que o CLIProxyAPI faz e o que podemos aproveitar

Fonte fixada: **`router-for-me/CLIProxyAPI@0db19025571684b198a2ef508f99b41c717337e8`**, o mesmo commit do estudo Codex. É inspeção de código, **não benchmark do programa CLIProxyAPI completo**.

| Integração | Algoritmo observado no CLIProxyAPI | Implicação para o AgentBridge |
|---|---|---|
| Claude | Executor chama Messages com perfis distintos para chave API/Bearer e compatibilidade de cliente. Traduz mensagens, schemas e resultados para `tool_use`, `tool_result` e `input_schema` | A tradução estruturada pode inspirar um caminho com API autorizada; não concede direito de reproduzir um login de assinatura |
| Claude streaming | O tradutor recebe `input_json_delta`, acumula os argumentos e só emite o tool call completo em `content_block_stop` | Não presumir que copiar esse tradutor entrega argumentos progressivos como no estudo Codex |
| Antigravity | Executor usa rotas Cloud Code `v1internal`, OAuth e contexto/identidade específicos do provedor. Traduz para `contents`, `functionDeclarations` e `functionResponse` | Assumiria protocolo privado, compatibilidade e credenciais que hoje ficam no CLI oficial |
| Antigravity streaming | Tradutor converte `functionCall.args` da resposta para `tool_calls` | Isso, sozinho, não comprova streaming incremental de fragmentos de argumentos |
| OpenCode | Não foi encontrado executor dedicado de OpenCode na pasta de executores; o harness roteia vários provedores | Um executor genérico OpenAI-compatible depende do endpoint e da autorização do provedor escolhido, não de um login OpenCode universal |

Fontes de código: [executor Claude](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/claude_executor_stream.go), [requisição Claude](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/claude/openai/chat-completions/claude_openai_request.go), [resposta Claude](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/claude/openai/chat-completions/claude_openai_response.go), [executor Antigravity](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/antigravity_executor.go), [requisição Antigravity](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/antigravity/openai/chat-completions/antigravity_openai_request.go), [resposta Antigravity](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/antigravity/openai/chat-completions/antigravity_openai_response.go). A [revisão estruturada](research/other-harnesses-source-review.json) registra arquivos, URLs e decisões.

### Por que o terceiro caminho ficou sem implementação

**Claude:** a documentação separa OAuth de assinatura e API keys e restringe coleta/intermediação de credenciais de assinatura por terceiros. Também distingue executar o binário oficial, autenticado pelo próprio usuário, de fornecer uma integração própria que intermedeie essas credenciais. Não demonstramos uma credencial API independente autorizada para este experimento; ler o token da assinatura em memória não elimina essa restrição. Por isso não reproduzi Bearer/fingerprint no backend. [Autenticação e uso de credenciais](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

**Antigravity:** os termos e FAQ proíbem determinados acessos por software de terceiros e alertam para suspensão. A FAQ também declara que usar headless dentro de aplicações/agentes de terceiros não é suportado em planos de consumidor; acordos Enterprise podem ter regras diferentes. O teste de scripting com o binário oficial não resolve o enquadramento de um produto que o envolva. O risco de ToS existe **também para o deployment do wrapper atual/persistente**, não só para HTTP direto. Não extraí OAuth nem reproduzi identidade do cliente. [Termos](https://antigravity.google/terms), [FAQ](https://www.antigravity.google/docs/faq/).

**OpenCode:** Zen documenta uma API com autenticação própria, mas o serviço é multi-provedor e o acesso gratuito escolhido foi expressamente recusado no modo testado. Sem demonstrar autorização independente para esse modelo, o caminho direto não foi implementado. Isso não significa que todo endpoint Zen ou todo provedor OpenCode seja incompatível com API. [Zen](https://opencode.ai/docs/zen), [termos](https://opencode.ai/legal/terms-of-service).

Essas restrições não foram medidas como falha técnica de um transporte inexistente. Não há velocidade estimada para o direto e não se conclui que o resultado Codex se aplica a esses provedores.

## Limites, verificações e reprodução

- Amostra pequena: três tentativas curtas por caminho, um ciclo de ferramenta quando possível. Sem teste de carga, estabilidade longa, expiração de credenciais, isolamento entre clientes, concorrência ou contexto longo.
- **26 requisições Chat Completions** na bateria principal. Além delas: duas no controle Claude, duas chamadas nativas de diagnóstico OpenCode e uma inspeção offline do despacho Claude, sem inferência. Não houve repetição silenciosa dos casos que falharam.
- Os scripts encerram com código diferente de zero quando não completam corretamente as cinco verificações previstas por caminho. Isso ocorreu e está preservado nos JSON; não significa que todos os testes passaram.
- Build TypeScript novo concluído. Os quatro scripts novos passaram por verificação de sintaxe; os JSON e a contagem de três tentativas por caminho foram verificados automaticamente. Nenhum teste ou arquivo de produção foi alterado.
- Worktree/build, clone do CLIProxyAPI, perfis e servidores privados temporários foram removidos/encerrados ao final. Os binários e serviços anteriores do usuário foram preservados. Os JSON não contêm tokens ou headers de autenticação.
- As instruções e a estratégia de ferramentas do injetado Claude diferem da ponte atual. O controle adicional mostra que a correção de ferramentas não depende de persistência. Os protótipos não devem ser promovidos a padrão sem trabalho adicional.

Artefatos: [infraestrutura compartilhada](../scripts/research/other-harnesses-common.mjs), os três scripts/JSON ligados acima, [métricas derivadas](research/other-harnesses-summary.json) e [revisão de fontes](research/other-harnesses-source-review.json).

Para reproduzir com um **dist novo** compilado em diretório temporário, e depois removê-lo:

```sh
node scripts/research/compare-claude-proxy-live.mjs /caminho/do/dist docs/research/claude-proxy-paths-results.json
node scripts/research/compare-agy-proxy-live.mjs /caminho/do/dist docs/research/agy-proxy-paths-results.json
node scripts/research/compare-opencode-proxy-live.mjs /caminho/do/dist docs/research/opencode-proxy-paths-results.json
```

Esses comandos fazem chamadas reais e sobrescrevem seus JSON. O Claude inclui o controle adicional; o OpenCode inclui os dois diagnósticos. `--diagnose-only` reaproveita um JSON existente e executa somente esses controles adicionais. Confirme o enquadramento de uso do provedor antes de repetir, especialmente no Antigravity.
