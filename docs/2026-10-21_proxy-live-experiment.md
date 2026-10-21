# Experimento real: AgentBridge e transporte direto inspirado no CLIProxyAPI

**Conclusão: os três caminhos resolveram as tarefas. O direto foi mais rápido nesta amostra e preservou streaming nativo de argumentos de ferramentas. Vale considerar esse transporte dentro do AgentBridge, mantendo a execução por CLI para tarefas de agente.**

Executado em 21/10/2026, com inferência real e a sessão Codex que já existia na máquina. Nenhum login novo, renovação de token, instalação do CLIProxyAPI ou alteração no código de produção. O protótipo leu a credencial existente somente em memória. A autenticação continua necessária; não foi criado outro fluxo de autenticação.

## O que foi comparado

Mesmo modelo `gpt-6.1-sol`, esforço `low`, tarefas e schemas fornecidos pelo cliente iguais, chamadas sequenciais:

1. **AgentBridge atual:** HTTP Chat Completions → montagem de prompt → `codex exec --json` → SSE compatível.
2. **AgentBridge com app-server:** mesma interface e montagem de prompt, mas adaptador injetado pelo script seleciona o transporte `app-server` que já existe no projeto. Um mesmo processo pode atender várias chamadas. Esta seleção é experimental; não foi acrescentada configuração pública ao proxy.
3. **Direto mínimo:** script traduz mensagens e ferramentas para Responses, faz POST a `https://chatgpt.com/backend-api/codex/responses` com a sessão existente e interpreta SSE. Não passa pelo CLI nem pelo servidor AgentBridge; demonstra um transporte que poderia ser incorporado nele.

O terceiro caminho é uma reimplementação pequena do subconjunto estudado no [executor Codex](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/runtime/executor/codex_executor_request.go) e no [tradutor Chat Completions → Codex](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/translator/codex/openai/chat-completions/codex_openai_request.go). Não é um benchmark do programa CLIProxyAPI completo, nem uma implementação de todos os recursos dele.

## Resultados medidos

Tempos de conclusão da requisição, em segundos, arredondados. A resposta curta teve três repetições por caminho, alternando a ordem. A consulta de estoque teve uma execução por caminho, com duas chamadas ao modelo.

| Medida | AgentBridge atual | AgentBridge app-server | Direto mínimo |
|---|---:|---:|---:|
| Resposta curta, mediana de 3 | 5,31 s | 3,25 s | 1,53 s |
| Resposta curta, intervalo observado | 4,92–5,56 s | 3,16–3,60 s | 1,32–1,55 s |
| Modelo pedir consulta ao estoque | 5,80 s | 3,38 s | 1,58 s |
| Modelo responder após resultado | 4,85 s | 3,83 s | 1,27 s |
| Soma das duas chamadas de estoque | 10,66 s | 7,21 s | 2,85 s |
| Primeiros argumentos da ferramenta | 5,80 s | 3,38 s | 1,30 s |
| Eventos de argumentos nativos recebidos | — | — | 10 |
| Verificações de resultado corretas | 5/5 | 5/5 | 5/5 |

Os tempos do estoque somam somente as requisições ao modelo. Não incluem latência de um sistema real de estoque. O teste usou uma função local determinística com quantidade 17.

### Exemplo concreto: consultar estoque

Pedido: “Consulte o estoque do SKU CANECA-AZUL com consultar_estoque”. O schema exigia um argumento `sku` textual. Em todos os caminhos:

1. O modelo pediu `consultar_estoque({"sku":"CANECA-AZUL"})` corretamente.
2. O script verificou nome e argumento antes de devolver `{"sku":"CANECA-AZUL","quantidade":17}`.
3. O modelo respondeu exatamente `Estoque: 17 unidades.`.

**O que muda na prática:** hoje o caminho Codex do proxy instrui o modelo por texto sobre as ferramentas e reconstrói `tool_calls`. O cliente recebeu dois chunks dessa reconstrução, ambos no final da chamada. No direto, a ferramenta é um campo próprio do protocolo; chegaram dez eventos de argumentos, começando aproximadamente 282 ms antes de terminar a requisição. O app-server melhorou a latência, mas manteve a reconstrução por prompt para ferramentas do cliente.

Em texto simples, `codex exec` emitiu a resposta curta em um delta, enquanto app-server e direto emitiram quatro. Isso é o comportamento observado nestas respostas, não uma garantia universal sobre todo streaming de texto.

## Qual caminho é melhor para nós

**Para um chat, integração com editor ou aplicação que fornece as próprias ferramentas:** o direto é promissor. Nesta amostra foi aproximadamente 3,5 vezes mais rápido na mediana da resposta curta e 3,7 vezes no ciclo de estoque. Ferramentas e histórico mantêm campos próprios, sem depender de interpretar um bloco de texto produzido pelo modelo. A amostra confirmou funcionamento e streaming, mas não mede superioridade de confiabilidade em larga escala.

**Para “abra meu projeto, leia arquivos, altere código e execute testes”:** o CLI fornece o ambiente de agente que o protótipo direto não implementa. O modelo direto pode pedir ferramentas, mas alguém precisa executá-las, aplicar permissões e gerir o ciclo. O teste de estoque deixa isso visível: quem executa a consulta é o script, não o endpoint remoto.

**Para melhorar o atual com menos trabalho:** avaliar expor a seleção de app-server no proxy. Ele já existe no adaptador e reduziu a mediana para 3,25 s neste experimento. Esse caminho continua delegando protocolo remoto e autenticação ao CLI instalado. Não preserva sozinho o contrato nativo das ferramentas do cliente, porque a montagem de prompt continua antes dele.

**Recomendação:** ambos podem coexistir dentro do AgentBridge. Os dois modos atuais, API e agent, expressam a finalidade e as permissões; o transporte direto seria outra escolha de backend, não necessariamente um terceiro modo de utilização. Modo API poderia escolher entre CLI/app-server e backend direto; modo agent continuaria usando o ambiente de execução de agentes. Isso é uma proposta arquitetural, não uma funcionalidade entregue por este experimento.

O custo do direto é assumir compatibilidade com o endpoint remoto, erros de protocolo e ciclo de vida da credencial. O protótipo não renova tokens e não trata a infraestrutura completa de um proxy. Não há evidência neste teste sobre preços, aumento de quota, qualidade em tarefas complexas ou estabilidade a longo prazo.

## Limites e verificação

- 15 requisições no comparativo, todas com resultado esperado; uma chamada direta preliminar adicional confirmou conectividade.
- Comparação dos caminhos completos, não isolamento do custo de criação de processos. Instruções, contexto adicional carregado pelo CLI, transporte de rede e emulação de ferramentas também podem explicar diferenças.
- Execução sequencial, sem teste de concorrência, cancelamento, contexto longo, expiração da sessão ou outros provedores.
- O resultado de estoque foi fixture local; as inferências que solicitaram e interpretaram a ferramenta foram reais.
- Build TypeScript novo, sem reutilizar `dist` antigo; três testes locais do parser SSE e do histórico estruturado passaram.
- Configuração e sessões do proxy isoladas em diretório temporário. Tokens, cabeçalhos de autenticação e fluxos brutos não foram salvos nos resultados. Código-fonte de produção permaneceu inalterado. Build e diretórios temporários do experimento removidos ao final.

Artefatos: [resultados JSON](research/proxy-live-results.json), [transporte direto mínimo](../scripts/research/codex-direct-minimal.mjs), [comparativo executável](../scripts/research/compare-proxy-live.mjs), [testes locais](../scripts/research/codex-direct-minimal.test.mjs).

Para reproduzir, a partir da raiz do projeto, com uma sessão Codex já válida:

```sh
node --test scripts/research/codex-direct-minimal.test.mjs
experiment_dir=$(mktemp -d /var/tmp/agentbridge-proxy-compare.XXXXXX)
node_modules/.bin/tsc --outDir "$experiment_dir/dist"
node scripts/research/compare-proxy-live.mjs "$experiment_dir/dist" docs/research/proxy-live-results.json
rm -rf -- "$experiment_dir"
```

O comparativo faz chamadas reais e sobrescreve o JSON indicado. O código de saída é diferente de zero se houver erro ou resultado inesperado.
