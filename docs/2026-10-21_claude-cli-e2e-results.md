# Teste real do Claude Code pelo AgentBridge

Base: `24c74de`, Claude Code `2.1.307`, modelo solicitado `haiku`. Todos os prompts de inferência foram curtos. Login existente reutilizado; nenhuma credencial foi copiada e nenhum login novo foi iniciado.

Foi usada a CLI do checkout (`node dist/cli/main.js`), porque o `ab` do PATH aponta para a instalação global. O proxy recebeu token aleatório, `--agent-root` temporário e `AGENTBRIDGE_HOME` separado. O limite de processos do proxy foi `AGENTBRIDGE_MAX_PROCS=1`; o fanout usou outro processo com limite 2.

| Verificação real | Resultado |
|---|---|
| POST sem token | HTTP 401, sem inferência |
| `claude/haiku`, sem streaming | HTTP 200, resposta solicitada |
| `claude/haiku`, streaming | SSE com conteúdo, término `stop` e `[DONE]` |
| `x-ab-session` | Mesma sessão nas duas chamadas; a segunda recuperou um marcador aleatório presente apenas na primeira |
| Limite de processos | Requisição sobreposta a uma execução Claude real recebeu HTTP 429, `rate_limited`, `Retry-After: 2` |
| `agent/claude/haiku`, sandbox padrão | Leu marcador de arquivo e criou arquivo pelo harness; original intacto, diff contendo o valor esperado; sandbox removido por DELETE |
| `agent/claude/haiku`, `x-ab-sandbox: none` | Leu marcador e escreveu no diretório original; header `x-agentbridge-sandbox: none`, sem run de sandbox |
| `ask claude --model haiku --session ephemeral` | Exit 0, `ASK_OK` |
| `fanout` com dois `claude:haiku` | Duas respostas `FANOUT_OK`, ambas bem-sucedidas |
| `doctor --live --no-models` | Inferência Claude/PONG passou; ressalva do ambiente abaixo |
| `sessions prune --proxy --older-than 1s --json` | Após desligar o servidor e envelhecer a sessão: entrada e transcript real removidos; busca adicional não encontrou `.jsonl` no projeto dessa sessão |
| Processos | Monitoramento de descendentes com `ps`, seguido de nova inspeção após encerramento: nenhum processo rastreado sobrevivente |

## Ocorrências e repetição isolada

O primeiro doctor terminou com exit 1 porque o Ollama local estava acessível, mas sem modelo padrão/disponível. O teste Claude do mesmo diagnóstico passou em 2,34 s. Isso é uma falha de configuração de outro provedor, não uma falha do Claude. Para verificar somente Claude sem chamadas aos demais harnesses, o segundo doctor usou PATH/HOME temporários, `CLAUDE_CONFIG_DIR` apontando para o login existente, `ANTHROPIC_MODEL=haiku` e `OLLAMA_HOST=127.0.0.1:1`. O endpoint fora do ensaio foi marcado como skip; Claude passou em 2,76 s e o comando terminou com exit 0.

Durante o primeiro prune, uma recompilação concorrente do checkout deixou `dist` transitoriamente inconsistente (`createLineSplitter` indisponível durante o carregamento). A repetição posterior removeu o transcript. Para eliminar a interferência, foi criado um worktree temporário do HEAD: nele resposta normal, continuidade/streaming, 429, doctor e prune passaram novamente. Nenhum arquivo dos trabalhos concorrentes foi alterado por este teste.

Primeira execução: zero sobreviventes dentre 22 descendentes rastreados. Repetição isolada: zero sobreviventes dentre cinco descendentes rastreados. As verificações se referem aos processos desses ensaios; processos anteriores da máquina foram preservados.

Não foi encontrado defeito reproduzível de produção nesses fluxos; nenhuma correção de código foi necessária. Esses testes confirmam os cenários descritos, não estabilidade prolongada ou isolamento geral contra prompts adversariais.

`npm run build && npm test` no worktree isolado do HEAD terminou com exit 0: 470 testes, 456 passaram, 14 pulados, nenhuma falha, em aproximadamente 87 s de testes. Não inclui as alterações não commitadas que outros agentes fizeram simultaneamente no checkout principal.

## Artefatos da execução

- Script temporário: `/tmp/agentbridge-claude-live-24c74de.mjs`.
- Primeiro relatório: `/tmp/ab-claude-live-7iJiEp/report.json`.
- Relatório isolado: `/tmp/ab-claude-live-Aq2VtR/report.json`.
- Log da suíte completa isolada: `/tmp/agentbridge-claude-isolated-tests.log`.

Nenhum commit ou push foi feito.
