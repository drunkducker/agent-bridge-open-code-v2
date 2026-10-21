# Tarefa real: ler um arquivo e calcular pedidos pagos

Executado em 21/10/2026 com a sessão Codex existente, modelo `gpt-6.1-sol`, esforço `low`. Nenhum login novo ou alteração de produção.

## Tarefa e evidência

Foi criado um repositório Git temporário contendo `pedidos.json` com sete pedidos. O pedido ao modelo fornecia apenas o nome do arquivo e a tarefa: ler com ferramenta, selecionar status exatamente `pago`, contar e somar `valor_centavos`, retornar JSON com o identificador do lote.

O conteúdo do arquivo não foi colocado no prompt. Cada rodada usou um identificador aleatório de lote, conhecido pelo modelo somente após a leitura. Resultado esperado: **4 pedidos pagos, 17.081 centavos (R$ 170,81)** e o identificador correto. Os agentes leram uma cópia do arquivo em worktree; a ferramenta do cliente leu o arquivo original no disco.

## Resultado da rodada com diagnóstico

| Caminho | Tempo total | Resultado | Quem executou a leitura |
|---|---:|---|---|
| AgentBridge modo agent, CLI | 8,05 s | Correto | Codex executou `cat pedidos.json` |
| AgentBridge modo agent, app-server | 7,29 s | Correto | Codex executou `cat pedidos.json` |
| AgentBridge modo API, ferramenta com escolha automática | 6,32 s | Não leu; respondeu `FILE_ACCESS_UNAVAILABLE` | Ninguém |
| AgentBridge modo API, ferramenta explicitamente exigida | 11,64 s | Correto | Script executou `ler_arquivo`, após pedido do modelo |
| Direto mínimo, ferramenta com escolha automática | 3,93 s | Correto | Script executou `ler_arquivo`, após pedido do modelo |
| Direto mínimo sem nenhuma ferramenta, controle | 1,55 s | Informou `FILE_ACCESS_UNAVAILABLE`, como esperado | Ninguém |

Os tempos de ferramenta do cliente incluem solicitar a leitura, executar `readFile` real e enviar o resultado ao modelo para a resposta final. No modo agente, a requisição ao AgentBridge engloba o ciclo de ferramentas administrado pelo Codex. Não é uma comparação de uma única inferência isolada. Há uma medição por cenário nesta rodada; o app-server não apresentou uma vantagem de velocidade grande nesta tarefa.

## O que isso mostra

**AgentBridge em modo agent já resolve uma tarefa local completa.** Recebe a tarefa, deixa o Codex executar a ferramenta e retorna o resultado. O protótipo direto sozinho não faz isso: ele precisa de ferramentas fornecidas e de um executor. Com essa infraestrutura, também resolve a tarefa e foi mais rápido nesta medição.

**O modo API atual teve uma falha concreta de escolha automática neste cenário.** Aconteceu nas duas rodadas. Forçar `tool_choice` para `ler_arquivo` resolveu na rodada diagnóstica. Há instruções conflitantes: a emulação diz que ferramentas estão disponíveis, enquanto [common.ts](../src/server/common.ts) acrescenta `Do NOT use any tools, read files, run commands or browse` ao final das instruções no modo API. Isso é uma possível explicação, apoiada no código, mas não foi feito um teste isolado removendo essa instrução para provar causalidade. A exigência explícita é uma variação adicional do teste; não foi aplicada ao cenário direto com escolha automática.

**O app-server executou a ferramenta, mas o adaptador não a normalizou.** O evento bruto `item/completed` tinha `type: commandExecution`, `aggregatedOutput` e `exitCode`; [codex-daemon.ts](../src/adapters/codex-daemon.ts) verifica `command_execution`, `aggregated_output` e `exit_code`. O script passou a observar também o evento bruto e confirmou o marcador aleatório no resultado do `cat`. Nenhuma correção foi aplicada ao produto.

Isso reforça a opção de coexistência: preservar o agente local completo e considerar um transporte direto para clientes que já possuem um executor de ferramentas. A tarefa não demonstra que o direto substituiria sozinho o ambiente de agente.

## Rodadas, verificações e arquivos

- A primeira rodada teve cinco cenários. O resultado do app-server foi numericamente correto, mas a verificação de leitura foi um falso negativo porque o coletor acompanhava somente eventos normalizados. Esses dados foram preservados.
- Na segunda rodada, o coletor acrescentou observação do evento bruto e foi incluído o caso com ferramenta exigida. O cenário original de escolha automática continuou igual e voltou a falhar.
- O script encerrou com código 1 porque a escolha automática do modo API não cumpriu a tarefa. Esse resultado está registrado, não foi convertido em sucesso.
- O arquivo original permaneceu idêntico; SHA-256 e verificações estão no JSON. Os diretórios temporários e o build foram removidos após a análise.
- Nenhum token, cabeçalho de autenticação ou fluxo bruto foi salvo nos resultados.

Artefatos: [script executável](../scripts/research/compare-file-task-live.mjs), [primeira rodada](research/file-task-live-results.json), [rodada com diagnóstico](research/file-task-live-diagnostic-results.json).

Para reproduzir, compile o projeto em um diretório temporário e execute:

```sh
node scripts/research/compare-file-task-live.mjs /caminho/absoluto/do/dist /caminho/dos/resultados.json
```

O script usa a sessão Codex existente, cria sua própria fixture e remove o workspace ao finalizar. A reexecução pode produzir outros tempos e escolhas de ferramenta.
