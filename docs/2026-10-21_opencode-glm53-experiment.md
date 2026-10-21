# OpenCode com GLM-5.3-Flash Free

**O GLM acertou as três leituras reais testadas, inclusive passando pela API do AgentBridge com o adaptador v2 experimental.** O caminho atual do produto continuou bloqueado pela verificação local de autenticação, e os caminhos sem ferramentas receberam recusas. A direção continua sendo integrar corretamente o OpenCode v2 e preservar seu ambiente nativo de agente.

Os **R$ 170,81 mencionados no experimento anterior são valores fictícios dos pedidos do arquivo**, não uma cobrança de uso de modelos. A soma em centavos é apenas um resultado verificável da tarefa. Os tempos abaixo medem execução; não são custos monetários.

## Condições

Executado em 21/10/2026 com OpenCode v2.1.1 e seleção explícita de `opencode/glm-5.3-flash-free`, variante padrão, sem fallback. As mensagens do agente principal foram verificadas para confirmar o modelo. Nenhum login, credencial nova, instalação ou alteração no código de produção.

Os testes usaram servidores privados locais e arquivos temporários. Cada conjunto recebeu um lote aleatório, cujo valor não estava no prompt. A ferramenta `read` precisou ler o arquivo para que o modelo retornasse o lote correto, quatro pedidos pagos e a soma 17.081 em centavos. Os números são dados sintéticos.

Foram reutilizados os scripts do experimento Flint, parametrizados para receber o modelo. O coletor identifica o agente principal `build` e distingue mensagens internas de resumo. Não foi utilizado um acesso direto ao provedor remoto: o próprio OpenCode fez as requisições ao modelo.

## Resultados

| Cenário | Tempo observado | Resultado |
|---|---:|---|
| Resposta exata, `read` disponível, primeira repetição | 5,80 s | `PONTE_OK`, sem executar ferramenta |
| Resposta exata, `read` disponível, segunda repetição | 2,59 s | `PONTE_OK`, sem executar ferramenta |
| Leitura real, servidor mantido aberto | 13,61 s | Leu, calculou e retornou JSON puro correto |
| Leitura real, servidor novo | 22,55 s | Leu, calculou e retornou JSON puro correto |
| Leitura real pela API AgentBridge, adaptador v2 experimental | 21,27 s | Leu, calculou e retornou JSON puro correto |
| Resposta exata, todas as ferramentas negadas, duas repetições | 4,03 s e 5,49 s até falha | `provider.auth`, HTTP 403 |
| Geração v2 sem sessão, duas repetições | 0,78 s e 0,19 s até falha | HTTP 503 local com mensagem de restrição do plano gratuito |
| AgentBridge atual, resposta exata | 0,03 s até falha | HTTP 401 local `agent_not_logged_in` |

Todos os cinco cenários com `read` disponível produziram a resposta pedida. Nas três tarefas de arquivo, houve evidência da leitura concluída contendo o marcador aleatório correto e conformidade com JSON puro. No protótipo integrado ao AgentBridge, o OpenCode fez duas leituras do arquivo antes da resposta final.

O servidor novo iniciou em aproximadamente 0,21 s. A diferença entre 13,61 e 22,55 s não pode ser atribuída integralmente à inicialização do processo. Há somente uma medição de cada caminho de arquivo, e a carga do provedor não foi controlada.

## Comparação com Flint

| Tarefa | Flint 40B Free, amostra anterior | GLM-5.3-Flash Free, esta amostra |
|---|---|---|
| Leitura pelo protótipo AgentBridge v2 | Correta, 44,23 s | Correta, 21,27 s |
| Leitura posterior em servidor mantido aberto | Correta, 40,02 s | Correta, 13,61 s |
| Leitura posterior em servidor novo | Timeout de 60 s | Correta, 22,55 s |
| Formato das leituras | Houve JSON cercado por Markdown na primeira leitura | JSON puro nas três leituras |

O GLM teve resultados melhores **nestas execuções**. Isso não é benchmark estatístico, nem prova superioridade geral: as rodadas ocorreram em momentos diferentes, com lotes diferentes e carga remota desconhecida. No protótipo GLM foi acrescentado um timeout interno explícito; ele não foi atingido em nenhuma das duas execuções integradas bem-sucedidas.

## Evidência → achado → ação

| Evidência | Achado | Ação |
|---|---|---|
| GLM e Flint funcionaram com o cliente v2, mas o adaptador atual bloqueou localmente | A compatibilidade do AgentBridge é um problema independente da escolha entre esses modelos | Priorizar detecção de versão, protocolo v2 e autenticação por capacidade/provedor |
| GLM concluiu a leitura também através do protótipo AgentBridge | A integração v2 é viável para esse modelo e tarefa | Evoluir o adaptador com permissões, erros, sessões e eventos corretamente tratados |
| Duas respostas exatas corretas com `read` disponível; duas recusas sem ferramentas | A associação observada no Flint também apareceu no GLM | Não atribuir a recusa exclusivamente ao Flint; não anunciar o caminho sem ferramentas como validado |
| Geração sem sessão retornou mensagem de restrição mesmo sendo chamada pelo OpenCode | O contrato de geração testado não foi aceito pelo plano gratuito | Preservar o uso suportado do harness e investigar a restrição, sem mascarar o cliente ou contorná-la |
| Três leituras corretas e tempos menores que a amostra Flint | GLM é um candidato melhor para continuar esta bateria específica | Prosseguir os testes de robustez com GLM, sem promovê-lo a padrão universal com essa amostra |

## Limites e verificações

O protótipo v2 é injetado somente no processo de teste, armazena eventos até o término e ainda não valida streaming, concorrência, retomada ou ferramentas do cliente no modo API. Este experimento não corrige o adaptador de produção nem conclui que um transporte remoto direto seria melhor para OpenCode.

Os resultados negativos foram mantidos. Os scripts da bateria e do probe terminaram com código 1 por incluírem caminhos recusados; o teste integrado de leitura terminou com código 0. Os arquivos originais permaneceram idênticos e os diretórios temporários foram removidos. Não foram gravados tokens, cabeçalhos de autenticação ou fluxos brutos nos resultados.

## Artefatos e reprodução

- [Resultados da bateria nativa](research/opencode-glm53-followup-results.json).
- [Resultado integrado ao AgentBridge](research/opencode-glm53-agent-prototype-results.json).
- [Diagnóstico do adaptador atual e da geração v2](research/opencode-glm53-probe-results.json).
- [Relatório Flint](2026-10-21_opencode-flint-experiment.md) e [direção consolidada](2026-10-21_proxy-direction-and-findings.md).

Os mesmos scripts continuam aceitando Flint por padrão. Para selecionar explicitamente GLM:

```sh
experiment_dir=$(mktemp -d /var/tmp/agentbridge-glm-build.XXXXXX)
node_modules/.bin/tsc --outDir "$experiment_dir/dist"
node scripts/research/compare-opencode-v2-capabilities-live.mjs /var/tmp/glm-native-results.json opencode/glm-5.3-flash-free
node scripts/research/test-opencode-v2-agent-prototype.mjs "$experiment_dir/dist" /var/tmp/glm-agentbridge-results.json opencode/glm-5.3-flash-free
node scripts/research/probe-opencode-model-live.mjs "$experiment_dir/dist" /var/tmp/glm-probe-results.json opencode/glm-5.3-flash-free
rm -rf -- "$experiment_dir"
```
