# Comparação dos caminhos de proxy do AgentBridge

Data: 21/10/2026. Análise de código público, com clones temporários, CodeGraph e verificações locais sem contas de provedores.

**Recomendação: manter o caminho de execução de agentes e acrescentar um caminho de modelos que preserve o protocolo.** O AgentBridge tem vantagem para executar agentes com ferramentas, permissões e sessões. CLIProxyAPI e copilot-api são referências melhores para expor inferência e ferramentas do cliente como API. Esses objetivos podem coexistir, mas o adaptador HTTP atual ainda não entrega a fidelidade necessária para substituir um gateway de modelos.

Não houve benchmark de inferência, latência, qualidade de respostas, disponibilidade dos serviços ou limites de contas. As vantagens de desempenho abaixo são hipóteses arquiteturais. Os testes dinâmicos utilizaram apenas fixtures locais. Não foi alterado código de produção nem incorporado código externo ao produto.

## Escopo e versões

Cada repositório foi clonado com `git clone --depth 1` usando sua branch padrão. Os links abaixo fixam os commits investigados; a disponibilidade atual de cada serviço não foi testada.

| Projeto | Commit examinado | Arquivos indexados | Nós | Relações |
|---|---|---:|---:|---:|
| [AgentBridge](https://github.com/rodolfonobrega/agentbridge/tree/528a5c5cc413332e4f0e6f8cf2d6ccfc841ab66f) | `528a5c5cc413332e4f0e6f8cf2d6ccfc841ab66f` | 155 | 3.743 | 11.369 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/0db19025571684b198a2ef508f99b41c717337e8) | `0db19025571684b198a2ef508f99b41c717337e8` | 1.905 | 43.727 | 163.195 |
| [copilot-api](https://github.com/ericc-ch/copilot-api/tree/0ea08febdd7e3e055b03dd298bf57e669500b5c1) | `0ea08febdd7e3e055b03dd298bf57e669500b5c1` | 49 | 606 | 1.141 |
| [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper/tree/a6c820d9a843f73c2e09aad3b4dead1544c25006) | `a6c820d9a843f73c2e09aad3b4dead1544c25006` | 20 | 301 | 527 |
| [gpt4free](https://github.com/xtekky/gpt4free/tree/de296be3a760e5cbc973c8e06c21054f5756f37b) | `de296be3a760e5cbc973c8e06c21054f5756f37b` | 422 | 9.086 | 24.182 |

As contagens representam o que o CodeGraph indexou, incluindo testes e configuração; não são uma medida de qualidade ou cobertura de todo o produto. No gpt4free, o exame aprofundado se concentrou em `OpenaiChat`, não em todos os adaptadores. No CLIProxyAPI, concentrou-se em Codex e Claude.

O CodeGraph 1.6.2 encontrou erros de I/O do SQLite nos diretórios em `/tmp`. Os bancos menores passaram por `PRAGMA quick_check` e checkpoint e voltaram a responder. Para CLIProxyAPI, a indexação terminou após mover o clone para `/var/tmp` e usar `CODEGRAPH_NO_WAL_DEFER=1`. Como duas condições mudaram, não foi isolada a causa do erro. Os quatro índices foram consultados com sucesso antes da limpeza.

## O que “API” significa aqui

São dimensões diferentes: formato que o cliente envia, transporte usado pelo proxy e credencial aceita pelo serviço. Uma API HTTP compatível com OpenAI não implica usar uma chave da API comercial da OpenAI. Um caminho OAuth pode chamar HTTP diretamente; o CLI também usa protocolos de rede internamente.

| Caminho | Fluxo | Responsabilidade principal do proxy |
|---|---|---|
| Agente instalado | Cliente → AgentBridge → CLI/app-server → provedor | Executar o agente e normalizar seus eventos |
| Modelo direto | Cliente → proxy → HTTP/SSE/WebSocket do serviço | Traduzir mensagens/eventos e administrar a autenticação aplicável |
| Superfície web | Cliente → adaptador → fluxo web do serviço | Reproduzir estados, cookies, preparação de pedidos e eventos web |

“Capturar uma chamada” pode ajudar a descobrir um protocolo. Não significa que esses projetos interceptem um CLI a cada pedido: nos executores diretos examinados, eles constroem e enviam os pedidos por conta própria.

## AgentBridge: algoritmo e limitações atuais

1. O handler OpenAI/Anthropic interpreta o pedido e resolve agente/modelo.
2. `chatTurns` e funções relacionadas convertem mensagens e resultados de ferramentas para turnos de texto; `buildPrompt` monta um prompt com rótulos de conversa.
3. `runAgent` aplica sessão, conta, fallback, cancelamento e limites e despacha pelo contrato `AgentAdapter.run`.
4. Claude executa `spawnProc('claude', ...)`. Codex executa `codex exec --json`, ou usa o daemon `app-server` quando esse transporte é solicitado ao adaptador.
5. Os eventos do agente são normalizados e transformados em respostas ou SSE compatíveis com o protocolo de entrada.

Fontes: [handlers OpenAI](../src/server/openai.ts), [conversão de mensagens](../src/server/tools/format.ts), [execução e prompt](../src/server/common.ts), [Claude](../src/adapters/claude.ts), [Codex](../src/adapters/codex.ts), [daemon Codex](../src/adapters/codex-daemon.ts).

O modo API desativa as ferramentas próprias do agente quando aplicável. Ferramentas fornecidas pelo cliente passam por uma ponte MCP no Claude; nos demais destinos, `runTools` injeta instruções e interpreta blocos de texto, com uma repetição quando encontra chamada inválida. Esse caminho espera o resultado antes de construir a resposta de ferramentas; não repassa os argumentos parciais nativos em tempo real. Fonte: [runTools](../src/server/tools/run.ts).

O adaptador HTTP já permite a coexistência básica de destinos. Contudo, ele recebe `prompt`/`systemPrompt`, cria outra lista `messages`, envia `/chat/completions` ou `/messages` e interpreta texto, reasoning e uso. No caminho examinado, não preserva a estrutura original completa nem interpreta deltas nativos de ferramentas. O caminho OpenAI não recebe `temperature` ou o limite solicitado pelo cliente; o caminho Anthropic constrói um `max_tokens` fixo de 8192. O proxy aplica seu limitador de texto com aproximação de quatro caracteres por token. Fonte: [makeEndpointAdapter](../src/adapters/endpoint.ts), [readParams e createLimiter](../src/server/common.ts).

**Confirmado por fixture HTTP local:** três mensagens de histórico viraram uma mensagem de usuário contendo a conversa; `temperature` foi declarado ignorado; `max_tokens` não chegou ao endpoint OpenAI; schemas de ferramentas viraram texto; um stream contendo apenas `delta.tool_calls` não produziu evento de ferramenta nem texto no adaptador. Isso descreve a tradução atual, não uma falha de inferência de um modelo real.

Há uma otimização intermediária importante: o daemon Codex mantém o processo, serializa turnos e separa instâncias por diretório e identidade de conta. Assim, reduzir o custo de inicialização não exige necessariamente implementar o protocolo remoto. Porém, a montagem atual das opções do proxy em `runAgent` não encaminha uma seleção geral de `transport`; o suporte do adaptador não deve ser anunciado como opção já ligada ao proxy sem esse trabalho adicional.

## CLIProxyAPI: protocolo direto com tradução estruturada

### Codex

1. O módulo de autenticação implementa OAuth com PKCE, troca de código e renovação. Há coordenação de refresh com `singleflight` e tratamento de erros de renovação.
2. O executor resolve modelo, credencial e formato de origem e traduz o pedido para o formato Codex/Responses.
3. Normaliza ferramentas, instruções e campos aceitos; aplica compatibilidade de reasoning e cabeçalhos.
4. No caminho de assinatura examinado, usa `https://chatgpt.com/backend-api/codex/responses` por HTTP, sem lançar o Codex CLI para realizar a inferência. Há também executores WebSocket com reutilização de conexão e estados de sessão.
5. O executor lê eventos SSE e os traduz para o protocolo do cliente. O modo sem streaming também pode consumir SSE internamente e montar o resultado final.

Fontes fixadas: [autenticação Codex](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/auth/codex/openai_auth.go), [executor HTTP](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/codex_executor_execute.go), [stream HTTP](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/codex_executor_stream.go), [WebSocket](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/codex_websockets_stream.go).

O tradutor de respostas conserva estado para associar IDs e índices de chamadas e converter `response.function_call_arguments.delta` em argumentos de ferramentas no formato do cliente. Essa é uma vantagem concreta sobre a emulação textual atual. Fonte: [tradutor Codex → Chat Completions](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/codex/openai/chat-completions/codex_openai_response.go).

**Acesso direto não equivale à API comercial completa:** o tradutor Responses → Codex remove explicitamente `max_output_tokens`, `max_completion_tokens`, `temperature` e `top_p`, força determinadas opções e normaliza papéis. Logo, migrar esse transporte não resolve por si só todos os parâmetros ignorados do AgentBridge. Fonte: [normalização de pedidos Codex](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/codex/openai/responses/codex_openai-responses_request.go#L16-L61).

### Claude

O executor envia HTTP para `https://api.anthropic.com/v1/messages?beta=true` quando não há outro destino configurado. O domínio pode coincidir com o da API comercial; a credencial e o perfil da chamada continuam sendo relevantes. O caminho OAuth possui tratamento próprio de identidade, cabeçalhos, nomes de ferramentas, cache, conteúdo de thinking e assinatura do corpo. O código também aplica ajustes de perfil Claude Code e transporte TLS. A renovação fica sob responsabilidade do proxy.

Fontes: [execução Claude](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/claude_executor_execute.go), [stream Claude](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/claude_executor_stream.go), [refresh](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/claude_executor_auth.go#L149-L181).

**Vantagem:** backend especializado em protocolos, preservando mais estrutura e eventos, com potencial para evitar processos por requisição. **Custo:** muito mais compatibilidade remota sob responsabilidade do projeto. Não se trata apenas de ler um token e executar `fetch`. A complexidade observada impede recomendar uma cópia simplificada desse mecanismo como substituição imediata dos CLIs.

## copilot-api: exemplo menor de tradução direta

1. Faz login por device flow ou usa a credencial GitHub persistida.
2. Obtém token de serviço em `/copilot_internal/v2/token`.
3. Agenda renovação conforme `refresh_in`, antecipando-a em 60 segundos.
4. Envia o payload de Chat Completions ao serviço Copilot, incluindo mensagens e schemas nativos, com cabeçalhos de integração/editor.
5. Para entrada Anthropic, traduz primeiro mensagens, ferramentas, escolhas e parâmetros para OpenAI. Para saída em stream, uma máquina de estados controla início/fim de mensagem, blocos e índices de ferramentas e encaminha argumentos JSON parciais.

Fontes: [token e refresh](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/lib/token.ts), [obtenção do token Copilot](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/github/get-copilot-token.ts), [pedido HTTP](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-chat-completions.ts), [cabeçalhos](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/lib/api-config.ts), [conversão de pedidos](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/routes/messages/non-stream-translation.ts), [stream](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/routes/messages/stream-translation.ts).

A execução offline dos tradutores confirmou preservação de histórico `tool_use`/`tool_result`, repasse de limite e amostragem no payload traduzido e emissão de argumentos parciais. Isso não prova que todo modelo remoto aceite cada parâmetro. É a referência mais simples em TypeScript para desenhar nossa tradução de protocolo; cobre um serviço, sem substituir a orquestração de agentes do AgentBridge.

## claude-code-openai-wrapper: a mesma família de solução

O fluxo é FastAPI → conversão de mensagens em prompt → `ClaudeCodeOptions` → `query` do SDK Claude Code → mensagens convertidas em SSE ou JSON. A autenticação pode usar o ambiente do SDK ou o login do CLI. Não é o caminho direto de modelo que diferencia CLIProxyAPI.

Na revisão clonada, o modelo de mensagens aceita apenas `system`, `user` e `assistant`. O histórico vira texto com rótulos `Human` e `Assistant`. As opções de ferramentas controlam as ferramentas internas do Claude Code, não um contrato geral de `tools`/`tool_calls` do cliente. Parâmetros como amostragem e `max_tokens` são ignorados; na resposta não streaming, `usage` é calculado com estimativa por caracteres, apesar da descrição mais ampla no README.

Fontes: [execução pelo SDK](https://github.com/RichardAtCT/claude-code-openai-wrapper/blob/a6c820d9a843f73c2e09aad3b4dead1544c25006/claude_cli.py#L67-L159), [conversão de mensagens](https://github.com/RichardAtCT/claude-code-openai-wrapper/blob/a6c820d9a843f73c2e09aad3b4dead1544c25006/message_adapter.py), [tipos e parâmetros](https://github.com/RichardAtCT/claude-code-openai-wrapper/blob/a6c820d9a843f73c2e09aad3b4dead1544c25006/models.py), [uso estimado](https://github.com/RichardAtCT/claude-code-openai-wrapper/blob/a6c820d9a843f73c2e09aad3b4dead1544c25006/main.py#L616-L632).

Uma execução isolada da função original `messages_to_prompt`, extraída por AST sem carregar o servidor, confirmou a perda de uma entrada com papel `tool`; o schema HTTP já não aceita esse papel. **Não encontrei vantagem arquitetural para substituir o AgentBridge por esse wrapper.** No escopo examinado, nosso projeto já oferece mais agentes, ferramentas do cliente, formatos de entrada e controle de execução.

## gpt4free: reprodução de fluxos web

O adaptador `OpenaiChat` recebe credenciais/sessão, monta cabeçalhos e cookies, prepara a conversa e seus IDs, realiza pedidos preparatórios e processa requisitos do serviço antes de enviar a conversa. O caminho autenticado usa uma sessão HTTP com perfil de navegador; o caminho anônimo examinado usa outra superfície web. Os eventos são convertidos para o formato comum do g4f e, depois, para sua API compatível.

O suporte a arquivos, estados de conversa e requisitos de navegador amplia a superfície de manutenção. No código examinado há referências explícitas a endpoints antigos retirados e à mudança para o fluxo web móvel no acesso anônimo. Isso é evidência de custo de compatibilidade; não é medição da frequência de falhas. Fonte: [OpenaiChat](https://github.com/xtekky/gpt4free/blob/de296be3a760e5cbc973c8e06c21054f5756f37b/g4f/Provider/needs_auth/OpenaiChat.py#L548-L842).

**Não recomendo esse fluxo web como caminho principal do AgentBridge.** Pode interessar como integração opcional para uma funcionalidade específica ausente dos CLIs, depois de validar essa necessidade. Não há base nesta análise para afirmar que seria mais rápido: pedidos preparatórios e navegador podem aumentar o trabalho por chamada. Outros adaptadores do gpt4free usam mecanismos diferentes; esta conclusão se restringe à superfície web estudada.

## Qual é mais vantajoso?

| Necessidade | Caminho mais adequado nesta análise | Motivo |
|---|---|---|
| Editar repositórios com agente, permissões e sessões | AgentBridge via CLI/app-server | Reaproveita a execução do agente instalado e os controles do projeto |
| Aplicação que administra seu próprio ciclo de ferramentas | Backend direto estruturado | Preserva schemas, papéis, IDs e deltas; evita emulação textual |
| Chat simples usando login existente | Ambos são viáveis | CLI simplifica manutenção remota; direto pode reduzir custo local por pedido |
| Streaming de argumentos de ferramentas | Tradutores CLIProxyAPI/copilot-api | Possuem estado e eventos próprios para deltas de ferramentas |
| Todos os parâmetros de uma API comercial | Depende do modelo, serviço e autenticação | O caminho direto Codex estudado também remove parâmetros |
| Menor responsabilidade por mudanças de autenticação/protocolo remoto | AgentBridge via CLI | O programa do provedor administra essa parte; continuamos sujeitos a mudanças no CLI |
| Funcionalidades particulares do chat web | Adaptador web específico, se necessário | É uma integração distinta; não substitui o ambiente de execução de agentes |
| Menor latência e maior vazão reais | Ainda não determinado | É preciso medir a mesma carga em condições comparáveis |

A conclusão é por finalidade, não por uma pontuação geral: **nosso caminho é mais vantajoso para agentes; o caminho direto é mais vantajoso como base para uma API de modelos fiel.** O wrapper Python não representa um avanço nesse segundo objetivo. O gpt4free amplia integrações, mas traz uma dependência da superfície web que não atende à necessidade principal demonstrada.

## Como ambos podem coexistir no AgentBridge

### Primeiro: protocolo de modelos separado da execução de agentes

Adicionar um contrato de backend de modelos ao lado de `AgentAdapter`, preservando mensagens e blocos estruturados, ferramentas, IDs, eventos parciais, métricas de uso e parâmetros suportados. Fazer a seleção de caminho antes de `chatTurns`/`buildPrompt` e antes de `runTools`.

O novo contrato deve declarar capacidades por destino/modelo: protocolos, amostragem, limites, imagens, ferramentas nativas, streaming de ferramentas, reasoning e continuidade. Não anunciar capacidades só porque a URL aceita um protocolo. Manter uma classificação explícita do que foi preservado, convertido, emulado ou ignorado.

Os caminhos propostos são:

```text
Pedido HTTP do cliente
  → resolução explícita do destino e de suas capacidades
    → execução de agente: prompt → CLI/app-server → eventos do agente
    → modelo direto: mensagens/ferramentas → HTTP/SSE/WS → eventos do modelo
  → resposta no protocolo do cliente
```

O caminho de modelo não ganha execução local de ferramentas automaticamente. A aplicação cliente executa as ferramentas que recebeu. Para usá-lo em um agente que edita arquivos, é preciso um harness real, como o Claude/pi já suportado pelo projeto, ou um ciclo de agente implementado e validado separadamente.

### Depois: sidecar como primeira integração direta

Uma primeira implementação pode encaminhar pedidos estruturados para um CLIProxyAPI local, mantendo nesse processo a autenticação e a compatibilidade remota. O AgentBridge continuaria oferecendo roteamento e a experiência unificada. Isso evita internalizar imediatamente toda a complexidade dos executores externos.

O `endpoint add` atual já pode conectar esse servidor para chat básico; **não equivale a integrar todas as capacidades do sidecar**. Sem o novo caminho, a redução do histórico a prompt e a emulação de ferramentas continuam ocorrendo antes de chegar a ele. Para preservar recursos, encaminhar o protocolo nativo quando coincidir ou traduzi-lo em nível de mensagens/eventos quando diferir.

OAuth direto dentro do AgentBridge pode ser uma etapa posterior, se houver benefício medido que justifique assumir refresh, armazenamento e coordenação de credenciais, cabeçalhos, sessões remotas e mudanças de protocolo. Não compartilhar arquivos de refresh token entre processos independentes sem definir um responsável pela renovação.

### Regras de roteamento e observabilidade

- Manter os destinos atuais e exigir uma escolha explícita do caminho direto, por configuração ou por identidade distinta de backend. “CLI”, “modelo direto” e “web” devem ser identificáveis nos diagnósticos.
- Não trocar silenciosamente um pedido de agente por uma chamada de modelo: a semântica de ferramentas, permissões e sessão muda.
- Um fallback entre caminhos precisa renegociar capacidades. Após emitir conteúdo ou iniciar ações com efeito externo, não repetir automaticamente o pedido inteiro como se nada tivesse ocorrido.
- Não migrar IDs de sessão entre CLI e API remota. Continuidade exige histórico portátil e tratamento explícito dos blocos que não podem ser transportados.
- Integrar a identidade de conta ao controle de quota para não contabilizar CLI e sidecar como duas cotas independentes quando usam a mesma conta. Endpoints genéricos ainda não recebem automaticamente toda a medição dos provedores integrados.
- Preservar métricas reais do backend e distinguir estimativas. A existência de transporte HTTP, por si só, não garante métricas completas.

### Ordem sugerida

1. Formalizar capacidades e preservar o pedido estruturado no modo de modelos.
2. Implementar encaminhamento de Chat Completions para backend compatível, com texto, histórico e ferramentas nativas, incluindo deltas e cancelamento.
3. Validar um sidecar CLIProxyAPI opcional, sem modificar os destinos existentes de agentes.
4. Acrescentar tradução Messages/Responses conforme a necessidade real dos clientes.
5. Medir custo e latência; considerar OAuth interno somente após esse resultado.

Para comparação de desempenho, usar a mesma conta, modelo, esforço e conversa; separar primeira chamada de processo/conexão já aquecida. Medir tempo até primeiro evento, primeiro texto útil e primeira chamada de ferramenta, duração total, recursos locais, concorrência, uso de tokens, cache, falhas e cancelamento. Incluir Codex CLI, Codex app-server aquecido e backend direto. Esta análise não produziu esses números.

As licenças declaradas nos clones foram MIT em CLIProxyAPI e copilot-api e GPLv3 em gpt4free. Não encontrei arquivo de licença no checkout do wrapper Python. A proposta usa esses projetos como referências e integração por processo; não inclui transposição de código deles para o AgentBridge.

## Evidências, conclusões e caminhos

| Evidência | Observação reproduzível | Conclusão associada |
|---|---|---|
| E-01 | `chatTurns`, `buildPrompt`, `runTools` e fixture do AgentBridge | F-01: o proxy HTTP atual opera pelo contrato de prompt e não preserva ferramentas nativas nos endpoints |
| E-02 | Executor Codex, tradutores e módulos OAuth do CLIProxyAPI no commit fixado | F-02: existe um caminho direto estruturado, com maior responsabilidade de compatibilidade |
| E-03 | Tradutor Responses → Codex remove limites e amostragem | F-03: acesso direto não resolve todos os parâmetros da API comercial |
| E-04 | Funções originais de tradução do copilot-api executadas offline | F-04: schemas, histórico de ferramentas e deltas parciais podem ser preservados sem emulação por prompt |
| E-05 | `query`, schema de mensagens, conversor de prompt e cálculo de uso do wrapper | F-05: é um wrapper de agente mais restrito no escopo examinado |
| E-06 | Preparação de conversa e sessão HTTP no OpenaiChat do gpt4free | F-06: o fluxo web é uma terceira integração, com estados e compatibilidade próprios |
| E-07 | Compilação fresca e 45 testes locais do AgentBridge passando | F-07: os comportamentos selecionados de proxy e daemon foram verificados sem chamadas de inferência |

F-01 e F-04 têm evidência estática e dinâmica local. F-02, F-03, F-05 e F-06 descrevem o código no snapshot examinado; não validam aceitação pelos serviços remotos. F-07 se restringe às três suítes selecionadas.

P-01, caminho de execução atual: handler → `chatTurns`/`buildPrompt` → `runAgent`/`runTools` → `AgentAdapter` → CLI ou endpoint reduzido → resposta compatível. Evidência E-01; conclusão F-01.

P-02, caminho direto observado: handler → tradutor estruturado → credencial de serviço → pedido HTTP/SSE/WS → tradutor de eventos. Evidências E-02/E-04; conclusões F-02/F-04. O algoritmo de tradução difere da execução de um agente completo.

## Verificações e reprodução

Foi criada uma compilação do TypeScript em pasta temporária e foram copiadas para esse ambiente as suítes `proxy-features.test.mjs`, `proxy-tools.test.mjs` e `codex-phase2.test.mjs`. Resultado: **45 testes, 45 passaram, nenhuma falha ou teste ignorado**. Nenhuma dessas execuções precisou de um modelo remoto.

Uma execução inicial com configuração persistente apresentou uma falha na expectativa de sessão nova. Com `AGENTBRIDGE_HOME` temporário, a suíte passou; a compilação fresca em ambiente igualmente isolado também passou. Esse resultado foi tratado como dependência de estado do teste, sem alteração do produto.

O [probe preservado](research/proxy-comparison-probe.mjs) usa Node 24+, lê as funções de tradução do checkout copilot-api, remove anotações TypeScript e executa fixtures. Também inicia um upstream de protocolo em loopback e o proxy real do AgentBridge. Não mede desempenho e não autentica provedores. [Resultados preservados](research/proxy-comparison-results.json).

Para repetir o probe, em um checkout do AgentBridge com as dependências de desenvolvimento disponíveis:

```bash
research_dir=$(mktemp -d /var/tmp/agentbridge-proxy-comparison.XXXXXX)
git clone --depth 1 https://github.com/ericc-ch/copilot-api.git "$research_dir/copilot-api"
git -C "$research_dir/copilot-api" fetch --depth 1 origin 0ea08febdd7e3e055b03dd298bf57e669500b5c1
git -C "$research_dir/copilot-api" checkout --detach 0ea08febdd7e3e055b03dd298bf57e669500b5c1
node_modules/.bin/tsc --outDir "$research_dir/dist"
AGENTBRIDGE_HOME="$research_dir/home" node docs/research/proxy-comparison-probe.mjs "$research_dir/copilot-api" "$research_dir/dist"
rm -rf -- "$research_dir"
```

Para refazer a exploração, clonar os demais URLs da tabela, fixar seus SHAs e executar `codegraph init --yes .` em cada clone. `codegraph node -p . --file caminho --offset linha --limit quantidade` permite conferir os arquivos citados. Os clones, índices, compilações e configurações temporárias desta investigação foram removidos após preservar o relatório e os resultados.
