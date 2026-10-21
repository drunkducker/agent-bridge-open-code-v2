# Direção do proxy e achados dos experimentos

## Decisão

Manter os modos **API** e **agent** no AgentBridge. Melhorar os transportes e o contrato de ferramentas dentro desses modos, reaproveitando as configurações e sessões existentes, sem instalar CLIProxyAPI ou criar novos fluxos de login.

- **Modo agent:** preservar o ambiente de execução do harness, que executa ferramentas e administra a tarefa local.
- **Modo API:** preservar mensagens, schemas, chamadas e resultados de ferramentas como dados estruturados quando a integração permitir. Nesse modo, a aplicação cliente executa suas próprias ferramentas.
- **Emulação por texto:** alternativa de compatibilidade, não a primeira opção quando há protocolo estruturado validado.
- Selecionar recursos pelas capacidades do adaptador, evitando pressupor que todos os harnesses suportam o mesmo transporte.

## Evidências já medidas no Codex

Modelo `gpt-6.1-sol`, esforço `low`, inferência real, sessão existente:

| Cenário | CLI atual | App-server | Direto mínimo |
|---|---:|---:|---:|
| Resposta curta, mediana de três | 5,31 s | 3,25 s | 1,53 s |
| Duas chamadas de consulta de estoque | 10,66 s | 7,21 s | 2,85 s |
| Ler arquivo e calcular pedidos pagos | 8,05 s, modo agent | 7,29 s, modo agent | 3,93 s, ferramenta executada pelo cliente |

Os cenários não equivalem a uma inferência isolada: ferramentas do cliente envolvem ida e volta ao modelo; o agente administra seu próprio ciclo internamente. Amostras pequenas, sem conclusão estatística ou teste de estabilidade prolongada.

Fontes e dados: [comparativo real](2026-10-21_proxy-live-experiment.md), [tarefa de arquivo](2026-10-21_file-task-experiment.md), [análise de arquitetura](2026-10-21_proxy-architecture-comparison-report.md).

## Achados que exigem ação

| Evidência | Achado | Ação proposta |
|---|---|---|
| O modo API Codex não escolheu a ferramenta de leitura nas duas rodadas; exigindo-a, concluiu corretamente | Falha reproduzida nesse cenário; instruções disponíveis entram em conflito com a proibição genérica de ferramentas | Distinguir ferramentas internas do harness das ferramentas fornecidas pelo cliente; validar causalidade e adicionar regressão antes de corrigir |
| App-server executou `cat`, mas o coletor normalizado não recebeu a ferramenta; evento bruto trouxe `commandExecution` | Adaptador espera nomes antigos em snake_case | Normalizar os formatos observados e validar saída, argumentos e código de término |
| Direto recebeu dez deltas de argumentos; caminhos emulados emitiram a chamada reconstruída ao final | A emulação perde a progressividade nativa das ferramentas | Preservar eventos estruturados quando houver suporte |
| Direto sem ferramentas informou corretamente que não acessava o arquivo | Transporte de modelo não fornece sozinho um ambiente de agente | Manter a execução do harness para tarefas locais completas |

Correções pontuais aplicadas após os experimentos:

- O modo API distingue ferramentas internas do harness das ferramentas fornecidas pelo cliente. Mantém a proibição de acesso local e permite solicitar as ferramentas do cliente. A regressão valida as instruções entregues ao adaptador; ainda não estabelece melhora na escolha automática do modelo por nova inferência real.
- O app-server normaliza `commandExecution`/`fileChange` e os nomes antigos, incluindo saída e código de término do comando.
- OpenCode não exige mais `auth.json` como condição para executar: a autenticação fica a cargo do próprio harness/provedor. Antes de resolver variantes ou iniciar o servidor, verifica a versão e recusa v2 ou superior com erro explícito de incompatibilidade, sem sugerir novo login. Isso é uma correção de diagnóstico; **o adaptador de produção ainda não suporta v2**. A migração completa de sessões, permissões, streaming, cancelamento e seleção de mensagens requer trabalho separado; o protótipo experimental não foi promovido.

Há testes de regressão para essas três correções. Os demais itens continuam sendo propostas.

## Ordem de implementação recomendada

1. Corrigir e testar os problemas funcionais observados: instruções de ferramentas e normalização do app-server.
2. Validar o app-server do Codex como candidato a transporte preferencial para agentes, mantendo `exec` como alternativa.
3. Incorporar um transporte direto Codex experimental para o modo API, preservando mensagens e ferramentas estruturadas; promover somente após validação operacional.
4. Declarar capacidades por adaptador: transporte persistente, ferramentas do cliente, streaming de argumentos, sessões, cancelamento e permissões. Não anunciar recursos sem validação.
5. Aplicar a bateria aos demais harnesses e aos modelos/provedores relevantes. Reaproveitar a arquitetura e os testes; decidir o transporte por integração.

Não trocar automaticamente para execução de agente ao falhar uma chamada API. Não repetir uma operação que já executou ferramenta com efeitos sem controle explícito de repetição.

## Critérios para escolher o padrão

Antes de promover um caminho: resposta simples, leitura real com marcador desconhecido no prompt, ferramenta automática e obrigatória, retorno de resultado, histórico, streaming, cancelamento, timeout, concorrência, isolamento de sessões e recuperação após falha. Medir correção primeiro, depois latência e custo operacional. Sessão expirada deve produzir erro claro; não iniciar login novo automaticamente.

## O que vale para outros harnesses

As medições do Codex não são resultados dos demais. Claude já usa uma ponte MCP para ferramentas do cliente; OpenCode usa servidor HTTP local; Pi e Antigravity têm seus próprios eventos e controles. Endpoints HTTP também precisam preservar o protocolo: usar HTTP não garante fidelidade.

Para OpenCode e Pi, registrar também o provedor e o modelo. Uma propriedade de um modelo não deve ser atribuída ao harness inteiro.

O [experimento OpenCode v2.1.1 com Flint 40B Free](2026-10-21_opencode-flint-experiment.md) foi realizado. O adaptador atual bloqueou por exigir um `auth.json` ausente; as rotas esperadas e a descoberta de variantes também diferem da versão instalada. Um adaptador v2 experimental injetado no AgentBridge concluiu leitura real e cálculo corretamente, em 44,23 s, com JSON puro e o modelo solicitado.

**Decisão específica para OpenCode:** priorizar compatibilidade v2, autenticação por capacidade/provedor e interpretação correta das mensagens do agente principal. Preservar a execução nativa de ferramentas. O caminho sem ferramentas foi recusado ou falhou; ferramentas do cliente ainda não foram validadas numa integração v2 completa. Não promover o protótipo a produção nem concluir vantagem de velocidade: houve variação grande, e iniciar o servidor local custou apenas cerca de 0,22–0,24 s nas medições de inicialização separadas.

A [repetição com GLM-5.3-Flash Free](2026-10-21_opencode-glm53-experiment.md) confirmou as três leituras reais, todas com JSON puro, incluindo a passagem pelo protótipo AgentBridge em 21,27 s. A amostra teve resultados melhores que a do Flint, mas repetiu os bloqueios do adaptador atual e do caminho sem ferramentas. Continuar a bateria com GLM é razoável; a prioridade de compatibilidade v2 permanece. Os valores monetários dos arquivos são dados fictícios da tarefa, não custos de uso dos modelos.
