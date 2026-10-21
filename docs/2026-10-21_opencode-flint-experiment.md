# OpenCode v2 e Flint 40B Free: achados e direção

## Decisão

**Para OpenCode, priorizar suporte correto ao protocolo v2 e à execução nativa de agentes. Não promover um caminho de geração sem ferramentas a padrão com base no experimento Codex.** O Flint conseguiu ler um arquivo e calcular uma resposta, mas houve recusas do provedor, timeout e diferenças de formato. A amostra não sustenta uma recomendação de desempenho ou estabilidade.

O próximo passo de produção é um adaptador compatível com a versão instalada, com validação das permissões, identificação do agente principal, erros e término da tarefa. Reutilização do servidor é candidata, mas a medição não demonstrou que inicialização seja o principal gargalo. Ferramentas do cliente no modo API ainda precisam de teste específico após resolver essa compatibilidade.

## Escopo

Data: 21/10/2026. OpenCode instalado: `v2.1.1`. Modelo solicitado e explicitamente selecionado: `opencode/flint-40b-free`, variante padrão. Foram usadas apenas a instalação e a configuração existentes; nenhum login, credencial nova, instalação ou alteração de produção.

Os servidores de teste foram processos locais privados. A comunicação HTTP foi com o OpenCode, que fez a comunicação com o provedor; não houve acesso direto ao endpoint remoto nem tentativa de contornar a restrição do plano gratuito. Não foram executados comandos de reinício ou reconfiguração do serviço existente. Duas verificações nativas preliminares usaram `run`, com servidor privado e com o serviço existente; suas sessões experimentais foram removidas.

O catálogo local anunciava o Flint como ativo, habilitado e com suporte a ferramentas. Isso foi tratado como metadado de disponibilidade, não como prova de que uma inferência funcionaria.

## Evidências e ações

| Evidência | Achado | Ação proposta |
|---|---|---|
| AgentBridge atual retornou HTTP 401 `agent_not_logged_in` em aproximadamente 39 ms; o arquivo `auth.json` esperado não existe | A validação local bloqueia antes de consultar o provedor, embora uma sessão v2 com Flint tenha conseguido inferir | Detectar autenticação/disponibilidade por versão e provedor; não exigir universalmente esse arquivo |
| `opencode models --verbose` é recusado pela CLI instalada | Descoberta de variantes atual depende de uma interface que não existe nessa versão | Usar descoberta de modelos compatível com v2 |
| `/global/health`, `/config/providers` e `/session` retornaram HTML; o servidor v2 respondeu pelo namespace `/api` | O adaptador atual utiliza o contrato antigo; HTTP 200 não basta como confirmação de saúde | Implementar detecção de versão, contrato v2 e validação de conteúdo nas respostas |
| Duas gerações sem sessão retornaram HTTP 503 local, com mensagem de restrição do plano gratuito; sessões sem ferramentas também tiveram `provider.auth` HTTP 403 ou timeout | O caminho sem ferramentas não foi validado para esse modelo | Não anunciá-lo como API genérica funcional; investigar o uso suportado pelo OpenCode |
| Sessão com `read` leu um marcador aleatório desconhecido pelo prompt e somou corretamente os pedidos | Flint conseguiu executar uma tarefa real pelo ambiente nativo OpenCode | Preservar esse caminho de agente e integrar seu protocolo corretamente |
| Resposta inicial de arquivo veio dentro de bloco Markdown; outra execução retornou JSON puro | Correção de conteúdo e cumprimento do formato são critérios diferentes | Validar ambos, sem descartar um acerto semântico nem anunciar conformidade estrita quando houve cercas Markdown |

Fontes locais: [resultados iniciais](research/opencode-flint-live-results.json), [repetições](research/opencode-flint-followup-results.json), [compatibilidade](research/opencode-v2-compatibility-results.json). Contrato conferido também na [API v2 oficial](https://opencode.ai/v2/docs/api) e no [OpenAPI publicado](https://opencode.ai/v2/openapi.json).

## Tarefa real de arquivo

Foi criado `pedidos.json` em diretório temporário com pedidos pagos, pendentes e cancelados. O conteúdo não foi incluído no prompt. Cada rodada usou um identificador aleatório de lote. A tarefa exigia ler com `read`, copiar o lote, contar apenas os pagos e somar os valores em centavos. Resultado esperado: **4 pedidos pagos e 17.081 centavos, R$ 170,81**.

| Caminho observado | Tempo | Resultado |
|---|---:|---|
| Sessão v2, primeira leitura | 16,13 s | `read` comprovado, lote e cálculo corretos; JSON cercado por Markdown |
| Sessão v2 em servidor mantido aberto, leitura posterior | 40,02 s | `read` comprovado, lote e cálculo corretos, JSON puro |
| Sessão v2 em servidor novo, leitura posterior | 60,43 s até encerramento | Timeout; não houve evidência de leitura coletada |
| API do AgentBridge com adaptador v2 experimental, modo agent | 44,23 s | Leitura comprovada, lote e cálculo corretos, JSON puro |

O primeiro coletor exigia `JSON.parse` direto, por isso a primeira leitura aparece com `correct: false` no JSON original. O relatório preserva esse resultado estrito e registra separadamente que a leitura e o cálculo foram corretos. O coletor posterior passou a registrar `strictJson`, `semanticCorrect` e `diskReadObserved` individualmente.

Os arquivos originais permaneceram idênticos, com hashes nos resultados. A prova de leitura foi o evento `read` concluído contendo o lote aleatório correto. Timeouts não provam que o modelo seja incapaz de ler arquivos.

### Prova de integração pelo AgentBridge

O [resultado do protótipo](research/opencode-flint-agent-prototype-results.json) foi obtido por POST ao `/v1/chat/completions` do AgentBridge, com modelo `agent/opencode/opencode/flint-40b-free`. O servidor AgentBridge criou seu ambiente de trabalho e chamou um adaptador v2 mínimo injetado somente naquele processo. O OpenCode executou duas leituras do arquivo; todas as mensagens do agente principal registraram o modelo Flint solicitado, sem substituição. A resposta final cumpriu o formato JSON puro e o resultado esperado, e o arquivo original permaneceu inalterado.

O coletor dessa execução já distinguia o agente principal `build`. Os eventos foram armazenados até terminar a sessão e depois convertidos para eventos AgentBridge. Portanto, o acerto comprova a viabilidade de integração, mas não a fidelidade de streaming ou a prontidão desse código para produção. O tempo inclui inicialização e limpeza do experimento; não deve ser comparado como inferência isolada aos outros cenários.

## Resposta simples e disponibilidade de ferramentas

As repetições alternaram o mesmo pedido de responder `PONTE_OK`, sem executar ferramentas, em sessões novas no mesmo servidor:

| Sessão | Resultado |
|---|---|
| `read` disponível, primeira repetição | Respondeu exatamente `PONTE_OK`, sem executar ferramenta, em 25,15 s |
| Todas as ferramentas negadas, primeira repetição | `provider.auth`, status 403 |
| Todas as ferramentas negadas, segunda repetição | Timeout de 60 s |
| `read` disponível, segunda repetição | O coletor recebeu uma mensagem de resumo em vez da resposta exata |

A mensagem do provedor dizia que o plano gratuito só pode ser utilizado dentro do OpenCode. Isso ocorreu mesmo usando o servidor OpenCode. Há associação observada entre o caminho sem ferramentas e as recusas, mas o teste não isola o motivo remoto nem prova uma regra universal do serviço.

A segunda repetição com `read` mostrou também uma limitação do protótipo: o coletor inicial escolhia a última mensagem `assistant`, sem distinguir o agente principal dos agentes internos de compaction/resumo. O helper foi ajustado para selecionar `agent: build` e registrar os agentes observados. A amostra anterior foi preservada; não deve ser usada isoladamente para atribuir ao Flint um erro de compreensão da tarefa.

As duas execuções preliminares de `opencode run`, uma privada e uma no serviço existente, terminaram com `compaction.unavailable` e não produziram a resposta pedida. Esse erro da camada de execução não deve ser confundido com um teste de qualidade de resposta do modelo.

## O que ainda não foi validado

- Ferramentas do cliente com escolha automática/obrigatória através de uma integração v2 completa. O caminho atual foi bloqueado antes da inferência; o protótipo de geração sem ferramentas foi recusado.
- Streaming de ferramentas, retomada de sessões, concorrência, cancelamento com confirmação e recuperação após falha em uma implementação de produção.
- Desempenho estável: cada cenário de arquivo teve uma medição, com variação grande. Não é comparação controlada com o Codex, pois são modelos e condições diferentes.
- A inicialização dos servidores privados ficou aproximadamente entre 0,22 e 0,24 s nas rodadas registradas. Isso não explica por si só esperas de dezenas de segundos.

Os executáveis de teste retornam código diferente de zero quando há respostas incorretas, formato inválido ou falha. Os resultados negativos foram mantidos.

## Artefatos reproduzíveis

- [Cliente mínimo v2](../scripts/research/opencode-v2-minimal.mjs): servidor privado, geração, sessões, leitura de mensagens e limpeza; não é um adaptador de produção.
- [Comparativo inicial](../scripts/research/compare-opencode-live.mjs): recebe um build TypeScript novo e o caminho do JSON de saída.
- [Repetições de capacidades](../scripts/research/compare-opencode-v2-capabilities-live.mjs): recebe o caminho do JSON de saída e cria seu próprio arquivo temporário.
- [Protótipo integrado ao AgentBridge](../scripts/research/test-opencode-v2-agent-prototype.mjs): injeta um adaptador experimental no processo de teste; não registra alterações no produto.

Os diretórios temporários do experimento e o build foram removidos após preservar os resultados. As sessões criadas pelo cliente v2 recebem pedidos de interrupção e exclusão na limpeza. Nenhum fluxo bruto ou credencial foi salvo nos artefatos.

Exemplos, a partir da raiz do projeto:

```sh
experiment_dir=$(mktemp -d /var/tmp/agentbridge-opencode-build.XXXXXX)
node_modules/.bin/tsc --outDir "$experiment_dir/dist"
node scripts/research/compare-opencode-live.mjs "$experiment_dir/dist" /var/tmp/opencode-initial-results.json
node scripts/research/compare-opencode-v2-capabilities-live.mjs /var/tmp/opencode-followup-results.json
node scripts/research/test-opencode-v2-agent-prototype.mjs "$experiment_dir/dist" /var/tmp/opencode-prototype-results.json
rm -rf -- "$experiment_dir"
```

As chamadas usam o modelo remoto e podem receber novas recusas ou outros tempos. A geração direta experimental do OpenCode não aceita schemas de ferramentas nesse contrato; emulação no protótipo não equivaleria a suporte nativo completo a ferramentas do cliente.
