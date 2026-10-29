# Relatório de Auditoria — Distributed Wagering Processor

**Data:** 29/10/2026
**Revisão identificada:** `c7143e6` (há alterações locais; não representa necessariamente o conteúdo integral desse commit).
**Escopo:** README oficial completo, arquitetura, implementação TypeScript, migration, testes, Compose, Dockerfile, scripts e resultados disponíveis nesta sessão.
**Metodologia:** comparei os requisitos com os caminhos de execução, examinei constraints e queries, e distingui código presente, teste existente, teste executado e comportamento comprovado. A pontuação é uma estimativa técnica, não uma nota oficial da banca.

**Limitações do ambiente:** Node `v24.11.0` e npm `11.6.1` disponíveis; Bun 1.2.5 executado via `npm exec`. `docker` e `psql` não estão instalados. Não foi possível subir PostgreSQL/LocalStack, aplicar migration, inicializar a API em container, nem executar integração ou concorrência contra os serviços reais.

## 1. Resumo executivo

O projeto apresenta implementação significativa: dinheiro em `bigint`, locking por wallet, idempotência armazenada no PostgreSQL, gravação transacional de saldo/ledger/outbox, inbox persistente e testes reais de integração/concorrência preparados no repositório. Isso é evidência de implementação, não de funcionamento demonstrado contra PostgreSQL/SQS.

| Indicador | Resultado desta auditoria |
|---|---|
| Estimativa técnica | **55/100**, sujeita à validação dos serviços reais |
| Checklist essencial resumido | **1 de 10 grupos ATENDIDO (10%)**; os grupos são: dinheiro, constraints/ledger, concorrência, idempotência, regras financeiras, mensageria, API, modelagem, observabilidade e operação/documentação. Os outros 9 são PARCIAIS ou NÃO VERIFICADOS por dependerem de comprovação ainda indisponível |
| Critérios complementares | Autenticação tem ponto de extensão e decisão documentada; teste de carga, OpenTelemetry e partidas dobradas não foram identificados. São opcionais |
| Falhas eliminatórias comprovadas | **Nenhuma confirmada** pela evidência obtida |
| Riscos eliminatórios não descartados | Concorrência financeira, idempotência concorrente, atomicidade efetiva e entrega SQS, pois testes de infra foram ignorados |
| Compilação | `npm run build` passou |
| Testes executados | 22 passaram, 0 falharam |
| Testes ignorados | 16, todos dependentes de PostgreSQL e/ou LocalStack |
| Inicialização / health check real | NÃO VERIFICADO |
| Regras de negócio | Implementação estática cobre caminhos importantes; execução persistida de reversões, referências pendentes e invariantes do ledger NÃO VERIFICADA |

O percentual do checklist é uma contagem de grupos, não uma nota nem uma medida de linhas implementadas. “ATENDIDO” exige evidência suficiente do comportamento; quando a implementação existe mas o teste real foi ignorado, o grupo permanece parcial. A nota e as falhas eliminatórias são avaliadas separadamente: uma pontuação razoável não descarta risco de desclassificação.

### Vocabulário de evidências

- **Implementação encontrada:** há código/configuração identificável para o requisito.
- **Teste existente:** há um caso de teste escrito no repositório; isso não significa que foi executado.
- **Teste executado:** o runner realmente executou o caso e reportou resultado.
- **Comportamento comprovado:** a execução observou o comportamento exigido no ambiente relevante. Um teste unitário não comprova integração/concorrência no PostgreSQL.

## 2. Avaliação dos critérios essenciais

### 2.1 Stack e configuração

| Requisito | Evidência | Teste existente / executado / comportamento comprovado | Status |
|---|---|---|---|
| Bun 1.x como runtime, package manager e test runner | Scripts Bun em `package.json`; imagem `oven/bun:1.2.5` em `Dockerfile` | Testes executados via `npm exec --yes --package=bun@1.2.5 -- bun test`; runtime da API em container não executado | PARCIALMENTE ATENDIDO |
| TypeScript estrito | `tsconfig.json` define `strict: true`; `npm run build` executa `tsc --noEmit` | Build executado e passou | ATENDIDO para type-check |
| NestJS | `src/main.ts`, `src/app.module.ts`, controllers e providers | Build passou; bootstrap HTTP real não executado | PARCIALMENTE ATENDIDO |
| PostgreSQL | `@mikro-orm/postgresql`, `pg`, database adapter e SQL explícito | Testes PostgreSQL existentes, mas ignorados sem `TEST_DATABASE_URL` | PARCIALMENTE ATENDIDO |
| SQS com LocalStack/MiniStack | `src/infrastructure/messaging/sqs.ts`, Compose e scripts `scripts/localstack-*.sh` | Integração SQS existente, ignorada sem `SQS_ENDPOINT` e banco | PARCIALMENTE ATENDIDO |
| Docker Compose | `docker-compose.yml` e `docker-compose.test.yml` | YAML parseado; Docker não disponível, portanto sem `compose up` ou health checks | PARCIALMENTE ATENDIDO |
| Migration versionada/reversível | `src/migrations/001_initial.ts`; `down` recusa apagar dados financeiros | Testes de migration existentes, ignorados; não foi possível aplicar/reverter em PostgreSQL | NÃO VERIFICADO |
| ORM permitido | MikroORM (`@mikro-orm/core`, `@mikro-orm/postgresql`, migrations) | Importações e configuração verificadas; build passou | ATENDIDO quanto à escolha |

### 2.2 Restrições invioláveis — README §5

| ID | Requisito | Evidência no código/schema | Teste existente / executado / comportamento comprovado | Status |
|---|---|---|---|---|
| R1 | Não usar `number`, `float` ou `double` para dinheiro | `src/domain/money.ts`: unidades menores em `bigint`; `numeric(18,2)` no banco. Conversões para `Number` encontradas são para contagem, tentativas ou limites, não para quantias monetárias | `test/unit/money.test.ts` executado: aritmética exata, escala e precisão passaram | ATENDIDO |
| R2 | Não usar cache em memória como garantia de idempotência | Unicidades por provider/key e provider/external ID na migration; transação consulta registro persistido | Teste concorrente de 50 submissões existe, porém ignorado | PARCIALMENTE ATENDIDO |
| R3 | Não confiar apenas em SQS FIFO | Restrições únicas e Inbox PostgreSQL dão deduplicação no banco | Testes multi-instância existem, ignorados | PARCIALMENTE ATENDIDO |
| R4 | Não publicar eventos antes do commit | `WageringService` insere outbox pelo executor da transação; `OutboxPublisher` reclama depois e publica fora dela | Teste de publisher/LocalStack existe, ignorado; ordem foi verificada estaticamente, não em execução real | PARCIALMENTE ATENDIDO |
| R5 | Não sobrescrever/excluir ledger | Triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` na migration; constraint de aritmética por entrada | Teste direto das constraints existe, ignorado | PARCIALMENTE ATENDIDO |
| R6 | Sem lock global compartilhado por todas as wallets | SQL bloqueia somente a wallet alvo com `FOR UPDATE`; documentado em `ARCHITECTURE.md` | Teste de wallets distintas em paralelo existe, ignorado | PARCIALMENTE ATENDIDO |
| R7 | Sem `read → calculate → update` desprotegido | Leitura da wallet ocorre com `FOR UPDATE` dentro da transação; rejeição por saldo insuficiente no domínio | Corrida 80/100 existe, ignorada | PARCIALMENTE ATENDIDO |
| R8 | Correto com múltiplas instâncias | Garantias dependem de locks/constraints no PostgreSQL, não de memória local; publishers usam `SKIP LOCKED` | Cenários multi-pool e multi-processo existem, mas não foram executados | PARCIALMENTE ATENDIDO |
| R9 | Garantias de unicidade, imutabilidade e não-negatividade no schema | `UNIQUE`, `CHECK`, FKs compostas e triggers na migration. A FK da referência (`reference_transaction_id`) é simples; correspondência de provider/player/wallet/currency/round é aplicada pela aplicação, não integralmente imposta pelo banco | Migration/SQL direto têm testes existentes, ignorados | PARCIALMENTE ATENDIDO |

**Observação R9:** o schema protege saldos não negativos e impede alteração normal do ledger, mas a validade semântica de referências entre transações ainda depende do caminho de aplicação. Não se deve tratar a validação de código como constraint relacional equivalente.

### 2.3 Modelagem de domínio — README §6

| Requisito | Evidência | Evidência de teste e limite | Status |
|---|---|---|---|
| `Money` preciso, imutável, string decimal e independente do ORM | `src/domain/money.ts`, `bigint`, parser estrito e ISO currency registry | Testes unitários de precisão, escala, entradas inválidas e moedas executados | ATENDIDO |
| Factories e reidratação sem transição de estado | `Wallet.open/rehydrate`, `WagerTransaction.create/rehydrate`, Inbox/Outbox factories | Testes unitários de domínio executados; não cobrem todos os estados persistidos | PARCIALMENTE ATENDIDO |
| Wallet Aggregate Root, saldo e versão | `src/domain/wallet.ts`; abertura em versão 1; alteração incrementa versão; débito não permite saldo insuficiente | Testes unitários de wallet executados | ATENDIDO para invariantes unitárias; concorrência não provada |
| Transições e estados terminais de WagerTransaction | `src/domain/wager-transaction.ts` e `InvalidTransactionStateError` | Testes de transição básica executados; nem todos os estados/caminhos de serviço são provados | PARCIALMENTE ATENDIDO |
| `OPENING` interno | Rejeição no serviço, controller e validador de envelope SQS; criação interna em `createWallet` | Teste unitário confirma rejeição de operação OPENING no domínio; HTTP/SQS não inicializados | PARCIALMENTE ATENDIDO |
| Ledger imutável e balanceado | `src/domain/ledger-entry.ts`; constraints/triggers em `src/migrations/001_initial.ts` | Unitário do equilíbrio passou; trigger real não executado | PARCIALMENTE ATENDIDO |
| Inbox persistente | Tabela com PK `(consumer_name, message_id)`; hash, recebimento e processamento dentro da transação do caso de uso | Redelivery test existe, ignorado | PARCIALMENTE ATENDIDO |
| Outbox com retry e lease | Tabela possui tentativas, próxima tentativa, claim e DLQ; publisher utiliza lease/`SKIP LOCKED` | Teste unitário de shutdown passou; integração SQS ignorada | PARCIALMENTE ATENDIDO |
| Eventos estáveis/versionáveis | `src/domain/events.ts` define envelope, eventos concretos e versionamento | Testes de integração não executados; não foi comprovada compatibilidade de consumidores | PARCIALMENTE ATENDIDO |

### 2.4 API HTTP — README §9

Controladores em `src/presentation/controllers.ts`; DTOs em `src/presentation/dto.ts`; filtro global em `src/presentation/exception-filter.ts`.

| Verificação | Evidência e avaliação | Status |
|---|---|---|
| Criar wallet e registrar `OPENING` quando saldo positivo | Wallet, transação, ledger e eventos são gravados no mesmo callback transacional em `WageringService.createWallet`; não executado contra DB | PARCIALMENTE ATENDIDO |
| Consulta de wallet/transações/provedor | Rotas GET presentes nos controllers | IMPLEMENTAÇÃO ENCONTRADA; HTTP real NÃO VERIFICADO |
| Ledger paginado com cursor | Cursor base64url, ordenação `(created_at, id)`, limite máximo 100 e validação | Código presente; paginação contra PostgreSQL NÃO VERIFICADA |
| Reconciliação | Consulta combina wallet e ledger em uma instrução SQL; mismatch logado e contabilizado | Código e query inspecionados; mismatch não exercitado em banco |
| Liveness/readiness | `src/presentation/health.ts` expõe rotas separadas; readiness consulta dependências | NÃO VERIFICADO em runtime |
| DTOs e contrato inválido | `ValidationPipe` com whitelist/forbid; class-validator valida strings, enum e formato de moeda | Build passou; requests HTTP não executados |
| `Idempotency-Key` obrigatória e hash canônico | Controller exige header; `canonicalPayloadHash` em `src/application/payload-hash.ts` | Teste de canonicalização executado; integração de replay não |
| Replay preserva resultado salvo | `response_balance` persistido e `toResult` lê o snapshot do registro, não o saldo corrente | Evidência estática; teste de replay existe mas foi ignorado |
| Conflito de payload divergente | Hash comparado no resultado já persistido; conflito mapeado para 409 | Teste unitário do hash passou; teste concorrente divergente em PostgreSQL foi ignorado |
| Mapeamento de erros | Filtro diferencia inválido, conflito, insuficiência, rollback e dependência transitória; pendência responde 202 | Código inspecionado; códigos HTTP não testados com servidor ativo |

### 2.5 Inbox, SQS, Outbox e workers — README §§10–11

| Requisito | Implementação encontrada | Teste existente / executado / comportamento comprovado | Status |
|---|---|---|---|
| Filas FIFO e DLQ | `scripts/localstack-init.sh`, Compose e URLs de fila em `SqsMessaging` | Configuração estática; criação real não executada | PARCIALMENTE ATENDIDO |
| Mesmo caso de uso HTTP/SQS | `SqsTransactionConsumer` chama `WageringService.submit` | Código inspecionado | ATENDIDO estaticamente |
| Inbox por consumer/messageId | `INSERT ... ON CONFLICT`, tabela com PK composta e hash | Teste redelivery existe, ignorado | PARCIALMENTE ATENDIDO |
| ACK após commit | `submit` é aguardado antes de `acknowledge`; inbox é marcado dentro da transação | Teste SQS existe, ignorado | PARCIALMENTE ATENDIDO |
| Erros de negócio/transitórios/permanentes | Erros de domínio/contrato vão a ACK/DLQ conforme classe; transitórios recebem nova visibilidade; limite recebe DLQ | Sem execução real no broker | PARCIALMENTE ATENDIDO |
| Crash antes do ACK | Inbox/financeiro/outbox atômicos; mensagem pode redeliver | Teste com processo consumidor existe, ignorado | NÃO VERIFICADO |
| SIGTERM e drain de trabalho | Shutdown aborta long poll e espera `active`; publisher foi ajustado para acordar o loop. O teste unitário de publisher/shutdown passou | Shutdown SQS/ack real não testado; ausência de limite explícito de drain deve ser validada com broker | PARCIALMENTE ATENDIDO |
| Publishers concorrentes | Claim com `FOR UPDATE SKIP LOCKED`, lease de 60s e publicação após claim | Teste de dois publishers existe, ignorado | PARCIALMENTE ATENDIDO |
| Retry/limite/DLQ da outbox | Backoff, limite de 20 e `dead_lettered_at` mantêm evento para revisão operacional | Não há teste real de falha/recuperação executado | PARCIALMENTE ATENDIDO |
| Publicação duplicada segura | Event ID é usado como `MessageDeduplicationId`; documentação orienta dedup downstream | FIFO dedup tem janela limitada; consumidor downstream não está no escopo/código | PARCIALMENTE ATENDIDO |
| Referências fora de ordem | `PENDING_REFERENCE`, tentativas/backoff e worker agendado | Teste de integração existe, ignorado | PARCIALMENTE ATENDIDO |

**Limite importante:** a deduplicação SQS FIFO não prova idempotência indefinida do consumidor de eventos. O design documenta que consumidores downstream devem usar `eventId`; não há consumidor downstream para verificar.

### 2.6 Avaliação das Regras de Negócio

| Regra | Implementação encontrada | Teste/evidência | Status e impacto |
|---|---|---|---|
| BET debita uma vez e rejeita saldo insuficiente | `processNewTransaction`, `Wallet.debit`, ledger DEBIT; wallet row lock | Unitário de débito insuficiente passou; prova financeira em PostgreSQL ignorada | PARCIAL — risco financeiro permanece até execução real |
| WIN credita e valida BET opcional | `processNewTransaction` verifica referência processada e tipo BET; valida round/wallet/etc. | Cenário de integração existe, ignorado | PARCIAL |
| LOSS não altera saldo nem cria ledger | Caminho sem direção/ledger e transação marcada processada | Integração existe, ignorada; unitário não prova persistência | PARCIAL |
| REFUND credita BET processada uma única vez | `applyExisting`, valida valor, referência e índice único parcial | Integração e concorrência existem, ignoradas | PARCIAL |
| ROLLBACK inverte operação permitida | `applyExisting` determina direção inversa; permite BET/WIN/REFUND | Testes de reversões existem, ignorados | PARCIAL |
| Reversões exigem referência e igualdade de valor | Factory/serviço validam exigência; `applyExisting` compara Money | Unitário de exigência de referência passou; integração de valor não executada | PARCIAL |
| Referência deve ser mesmo provider/player/wallet/moeda/round | `validateReference` compara os campos | Cenário de identidade e referências existe, ignorado | PARCIAL |
| Sem reversão duplicada do mesmo tipo | Consulta de duplicata, locking por wallet e índice único parcial | Teste concurrente de refund existe, ignorado | PARCIAL — índice/concorrência real não executados |
| REJECTED não movimenta saldo/ledger | `reject` atualiza somente transação e outbox; caminho financeiro transacional | Teste de atomicidade existe, ignorado | PARCIAL |
| Replay de transação terminal retorna snapshot persistido | `findExistingResult` e `toResult` usam saldo salvo | Teste de replay existe, ignorado | PARCIAL |
| Referência inexistente fica pendente e depois é tentada | `markPendingReference`, `processPendingReferences`, `retryPending` | Integração de referência fora de ordem existe, ignorada | PARCIAL |
| Reversão sem saldo usa código distinto | `ROLLBACK_WOULD_OVERDRAW` distinto de `INSUFFICIENT_FUNDS` | Unitário de domínio insuficiente executado; caminho persistido ignorado | PARCIAL |
| Limite de referência | 12 tentativas, backoff exponencial até 300s, rejeição `REFERENCE_NOT_FOUND` | Código e `ARCHITECTURE.md`; teste de esgotamento não executado | PARCIAL |
| Referência terminal não processada | Rejeição `REFERENCE_NOT_PROCESSED` | Código inspecionado; comportamento runtime não executado | PARCIAL |
| Wallet inicial e OPENING atômicos | `createWallet` insere wallet, OPENING, ledger e eventos no mesmo callback | Teste de integração existe, ignorado | PARCIAL |

**Códigos observados:** `INSUFFICIENT_FUNDS`, `ROLLBACK_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `INVALID_REFERENCE`, `REFERENCE_NOT_PROCESSED`, `DUPLICATE_REVERSAL`, `WALLET_NOT_FOUND`, `WALLET_IDENTITY_MISMATCH`, `CURRENCY_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `TRANSACTION_ID_CONFLICT` e `TRANSIENT_INFRASTRUCTURE_FAILURE`. A taxonomia aparece no código; a documentação não apresenta um catálogo operacional completo com semântica/retry por código.

### 2.7 Testes obrigatórios

| Categoria | Teste existente | Teste executado nesta auditoria | Comportamento comprovado |
|---|---|---|---|
| Money e domínio | `test/unit/money.test.ts`, `domain.test.ts` | Sim: parte da suíte unitária; todos os casos executados passaram | Aritmética exata, validações testadas e transições unitárias cobertas |
| Hash/idempotência | `test/unit/idempotency.test.ts` | Sim, passou | Hash determinístico e sensível a campo de negócio, não deduplicação concorrente persistida |
| Migration/constraints | `test/integration/migrations.test.ts` | Não; ignorado sem PostgreSQL | Nenhum comportamento do schema foi confirmado por execução |
| Atomicidade/ledger/inbox/outbox | `test/integration/wagering.test.ts` | Não; ignorado | Não comprovado em PostgreSQL |
| SQS redelivery/crash | `test/integration/sqs.test.ts` | Não; ignorado sem PostgreSQL/LocalStack | Não comprovado |
| Outbox com dois publishers | `test/integration/outbox-publisher.test.ts` | Não; ignorado | Não comprovado |
| Corrida 80 contra 100 | `test/concurrency/wagering.test.ts` | Não; ignorado sem PostgreSQL | Não comprovado |
| 50 requisições/3 pools e 3 processos | `test/concurrency/wagering.test.ts` | Não; ignorado sem PostgreSQL | Não comprovado |
| Wallets diferentes em paralelo | `test/concurrency/wagering.test.ts` | Não; ignorado | Não comprovado |
| Invariante saldo = ledger | `test/helpers/postgres.ts` é usado pelos testes de integração/concorrência | Helper existe; todos esses testes foram ignorados | Não comprovado contra dados persistidos |

Os testes de concorrência são estruturados com `Promise.all`, pools MikroORM independentes e processos filhos; portanto, **não são apenas mocks sequenciais**. Porém, como os testes não foram executados, isso demonstra existência de cenários, não aprovação nem comportamento correto.

### 2.8 Observabilidade

| Requisito | Evidência | Status |
|---|---|---|
| Logs JSON | Logs estruturados em `WageringService`, consumer, publisher, filtro e bootstrap | PARCIALMENTE ATENDIDO; não observados em runtime |
| IDs de correlação/transação/wallet/provider | Propagação em middleware e logs de submissão/SQS | PARCIALMENTE ATENDIDO; alguns erros dependem dos campos disponíveis na requisição |
| Sem payload financeiro completo em logs | Logs consultados registram identificadores e códigos/erros, não objeto de dinheiro completo | ATENDIDO por inspeção estática |
| Transações por status | Métrica lê status durável do PostgreSQL em `src/presentation/metrics.ts` | NÃO VERIFICADO em runtime |
| Duplicatas, retries, DLQ e conflitos de lock | Counters em `ProcessMetrics` e instrumentação | PARCIALMENTE ATENDIDO; parte é por processo e não foi coletada em execução |
| Outbox lag | Query do evento pendente mais antigo | NÃO VERIFICADO em runtime |
| Latência | Histograma em memória por processo | PARCIALMENTE ATENDIDO; não agregado entre instâncias automaticamente |
| Liveness/readiness | Endpoints distintos em `src/presentation/health.ts` | NÃO VERIFICADO em runtime |

### 2.9 Documentação obrigatória

`README.md` contém setup, rotas, comandos, testes, regras e avaliação. `ARCHITECTURE.md` descreve locking, idempotência, outbox, limitações, autenticação e sequências.

| Tópico | Avaliação |
|---|---|
| Setup e execução | Instruções existem; Compose/instalação não foram executados |
| ORM, dinheiro, concorrência e idempotência | Decisões estão documentadas |
| Hash | Algoritmo e campos estão descritos em `ARCHITECTURE.md` |
| Códigos de falha | Alguns exemplos e decisões existem, mas falta catálogo completo e política de retry por código |
| Retry e DLQ | Limites descritos (12 referências; 20 tentativas outbox; 5 recebimentos SQS); comportamento não executado |
| Testes reais | Comandos e proteção de banco `_test` documentados; ambiente real indisponível |
| Coerência | A documentação afirma que os testes container-backed são necessários e não devem ser considerados aprovados quando ignorados. A afirmação do README de que 90s de grace period basta para todo drain/ack ainda não foi demonstrada por teste real |

**Status global:** PARCIALMENTE ATENDIDO.

## 3. Critérios não essenciais e complementares

| Diferencial | Evidência | Avaliação |
|---|---|---|
| Autenticação | README §2 classifica como opcional; `ARCHITECTURE.md` documenta ausência e `ProviderIdentityPort`; health público | Ausência não deve ser penalizada |
| Ledger de partidas dobradas | Não identificado; README o classifica como diferencial | Ausente, sem impacto eliminatório |
| OpenTelemetry/dashboard | Não identificados | Ausentes, opcionais |
| Carga (`bun run test:load`) | Script/teste de carga não identificado em `package.json` e `test/` | Diferencial ausente, não requisito obrigatório |

## 4. Interpretações adicionais e riscos de negócio

1. **Reversão permitida por tipo:** migration permite uma reversão de cada tipo por referência. Isso acompanha a regra oficial “não pode ser revertida duas vezes pelo mesmo tipo”, mas permite, por exemplo, um REFUND e um ROLLBACK da mesma BET. `ARCHITECTURE.md` documenta essa escolha. Confirmar com a banca se a intenção era exclusividade total entre tipos.
2. **Falha permanente de infraestrutura:** o domínio possui status `FAILED`, mas os erros de infraestrutura em geral fazem rollback e são repetidos pela mensageria; não encontrei um fluxo que persista `FAILED` para a operação. O requisito lista esse estado como terminal/auditável, mas não define claramente quando a transação financeira deve recebê-lo. Clarificar antes de alterar semântica.
3. **Constraints de referência:** provider/player/wallet/currency/round são validados no serviço, mas não todos impostos por uma FK composta no banco. Escritas fora do serviço podem criar referências semanticamente inconsistentes.
4. **Entrega da outbox:** após SQS aceitar a mensagem e antes de marcar `published_at`, crash pode gerar duplicata. Isso é comportamento at-least-once documentado, não publicação prematura; a deduplicação downstream por eventId continua responsabilidade do consumidor.

## 5. Pontos de Nota da Avaliação

Estimativa conservadora baseada na implementação observada e na evidência executada. Os descontos por validação de integração não são prova de bug; refletem comportamento essencial ainda não demonstrado. Não conto o mesmo déficit duas vezes sem indicar impacto próprio.

| Área | Máximo | Estimativa | Justificativa, evidências e perdas | Prioridade para recuperar pontos |
|---|---:|---:|---|---|
| Correção financeira | 20 | **13** | `Money` usa bigint e seus testes passaram; wallet/ledger, reversões, response snapshot, constraints e reconciliação existem. Perda de 7 porque as operações persistidas, atomicidade e invariantes financeiras não foram testadas em PostgreSQL nesta execução. | Executar testes de integração, reversões, falha injetada e reconstrução do ledger em PostgreSQL real. |
| Concorrência | 20 | **8** | `FOR UPDATE` por wallet, retry de deadlock e testes reais multi-pool/processo estão implementados. Perda de 12 porque todos os testes de race foram ignorados, inclusive 80/100 e três processos. | Rodar `test:concurrency` contra stack descartável; exigir resultado, ledger e saldo final exatos. |
| Idempotência | 15 | **8** | Constraints persistentes, canonical hash e saldo-resposta persistido são evidências positivas; testes unitários do hash passaram. Perda de 7 por falta de execução de replay, payload divergente concorrente, inbox e reinício no banco real. | Executar suites de idempotência, redelivery e restart; verificar uma única linha/ledger e snapshot original. |
| Mensageria e falhas | 15 | **7** | Inbox/outbox, retry, DLQ, claims e shutdown existem; unitário de shutdown do publisher passou. Perda de 8 porque SQS/LocalStack, crash-before-ack, dois publishers e SIGTERM real não foram exercitados. | Executar LocalStack/PostgreSQL integration e ensaios de crash/retry/DLQ/SIGTERM. |
| Modelagem e arquitetura | 10 | **7** | Camadas separadas, factories, rehydrate, domain Money e decisão de locks estão presentes; build/unitários passaram. Perda de 3 por transições/FAILED pouco exercitadas, persistência raw SQL no serviço e algumas garantias sem teste integrado. | Ampliar testes de transição e documentar/decidir o uso de FAILED e limites da validação no DB. |
| Testes | 10 | **4** | Existem testes unitários e suites reais de infra/concurrency; total executado 22 passou. Perda de 6 porque 16 foram ignorados: requisito pede integrações e paralelismo real, não somente arquivos de teste. | Disponibilizar pipeline/container e registrar execução integral com zero skips esperados. |
| Observabilidade | 5 | **4** | JSON logs, métricas de status/retry/DLQ/locks/outbox lag/latência e health separados aparecem no código. Perda de 1 por ausência de execução e histogramas/counters locais por processo. | Verificar `/metrics` e health em containers e documentar agregação multi-instância. |
| Documentação | 5 | **4** | README e architecture são extensos e reconhecem limitações e testes ignorados. Perda de 1 por falta de catálogo completo de failure codes e garantias de shutdown ainda não provadas. | Documentar códigos, retries e evidências após teste completo. |
| **Total** | **100** | **55** | **Estimativa técnica; não é nota da banca.** Não inclui pontos extras por opcionais. | Completar primeiro a validação de PostgreSQL/SQS. |

## 6. Falhas Eliminatórias e Riscos Críticos

**Não encontrei evidência suficiente para afirmar que uma falha eliminatória ocorreu. Também não há evidência suficiente para declarar que todas foram descartadas.** A pontuação acima não reduz esse risco.

| Falha eliminatória oficial | Status | Evidência/cenário | Impacto e correção recomendada |
|---|---|---|---|
| `number` para dinheiro | **NÃO IDENTIFICADA** na implementação monetária inspecionada | `src/domain/money.ts` usa `bigint`; testes Money executados passaram. `Number()` em outras áreas é para contagens/versões/limites. | Sem risco observado nesse ponto. Manter revisão para não converter montantes ao adicionar código. |
| Saldo negativo por race | **NÃO VERIFICADO** | Lock por wallet e CHECK de não negatividade existem; o teste 80/100 está presente, mas foi ignorado. | Falha poderia ser desclassificatória. Rodar corrida contra PostgreSQL e verificar `20.00`, um débito e reconciliação. |
| Débito/crédito duplicado | **NÃO VERIFICADO** | Unicidades e locking existem; testes de duplicatas e refund concorrente não executados. | Rodar concorrência 50x, operações concorrentes de reversão e confirmar exatamente um lançamento. |
| Idempotência somente em memória | **NÃO IDENTIFICADA** como desenho | Restrições e Inbox persistentes na migration; replay consulta DB. Concorrência/reinício não testados. | O mecanismo não depende de cache, mas a garantia entre processos ainda requer execução. |
| Correção dependente de uma instância | **NÃO VERIFICADO** | Uso de PostgreSQL row locks/constraints e teste 3 processos existente; execução do teste ignorada. | Pode desclassificar. Rodar múltiplas instâncias independentes contra o mesmo DB. |
| Evento publicado antes do commit | **NÃO IDENTIFICADO** na ordem estática | Eventos são enfileirados no banco transacional; publisher lê depois. Teste integrado foi ignorado. | Executar crash/rollback e comprovar que nenhum evento de transação abortada chega ao SQS. |
| Ausência de ledger auditável | **NÃO IDENTIFICADA** no desenho | Tabela ledger, unicidade, equação, FKs e triggers; teste unitário de equação passou. Persistência/imutabilidade do trigger não foi exercitada. | Rodar SQL direto para UPDATE/DELETE/TRUNCATE e teste de reconciliação real. |
| Testes substituem PostgreSQL/SQS por mocks | **NÃO IDENTIFICADA** como substituição total | Há suites com MikroORM, processos e LocalStack; unitário de shutdown usa doubles, mas não substitui as suites integradas. As suites integradas foram ignoradas neste ambiente. | Não é prova de conformidade: pipeline de entrega precisa executar os testes reais, sem skips. |

## 7. Verificação de execução e evidências

| Comando/verificação | Resultado real | O que comprova / não comprova |
|---|---|---|
| `npm run build` | **Passou** (`tsc --noEmit`) | Type-check estrito da configuração atual. Não valida migrations, runtime ou módulos externos ativos. |
| `npm exec --yes --package=bun@1.2.5 -- bun test` | **22 pass, 16 skip, 0 fail**, 38 testes em 11 arquivos, 79 assertions | Unitários executados passaram. Os 16 skips são suites PostgreSQL/SQS/concurrency; não contam como aprovação. |
| `npm audit` | **0 vulnerabilidades** | Auditoria das dependências instaladas/conhecidas pelo npm; não é evidência de correção financeira. |
| Parse YAML dos dois Compose via Ruby YAML | **Passou** | Sintaxe YAML, não valida imagens, healthchecks, rede ou startup dos containers. |
| `sh -n scripts/localstack-init.sh` e `sh -n scripts/localstack-test-init.sh` | **Passou** | Sintaxe shell, não execução de `awslocal`/SQS. |
| `git diff --check` | **Passou** para conteúdo rastreado | O comando não inclui arquivos não rastreados; não usar como validação dos novos arquivos por si só. |
| `docker --version`, `psql --version` | Ambos indisponíveis (`command not found`) | Explica por que não foram rodados Compose, migration nem testes de integração/concurrency com infra. |
| Inicialização API, migration up/down, health checks | **Não executado** | Docker/DB indisponíveis; resultado NÃO VERIFICADO. |
| Teste de carga | **Não existente/identificado** | Diferencial opcional ausente. |

### Diferença explícita entre existência, execução e prova

- **Existente:** `test/concurrency/wagering.test.ts` contém corrida financeira, deduplicação em pools independentes, três processos e wallets diferentes.
- **Executado:** o runner Bun detectou os testes, mas exibiu “Skipping concurrency tests” por falta de `TEST_DATABASE_URL`; portanto, eles não foram executados.
- **Comportamento comprovado:** nenhum cenário de concorrência real foi observado nesta sessão. A implementação e o teste não bastam para afirmar que saldo negativo/lost update foi descartado.

Essa mesma regra se aplica às migrations, redelivery, outbox, retries, DLQ e crash recovery.

## 8. Plano de Correção Prioritário

### P0 — Bloqueadores e riscos eliminatórios

| Ação | Arquivos/módulos | Correção/validação | Critério objetivo |
|---|---|---|---|
| Executar corrida de saldo e idempotência multi-instância | `test/concurrency/wagering.test.ts`, PostgreSQL | Subir stack descartável e rodar `bun run test:concurrency` sem skips | 80/100 produz um processado, um rejeitado, saldo 20.00, um débito; 50 duplicatas produzem uma transação e um débito; invariantes saldo=ledger passam |
| Provar constraints e append-only do ledger | `src/migrations/001_initial.ts`, `test/integration/migrations.test.ts` | Rodar migration e SQL direto contra PostgreSQL | Unicidade, CHECK, FKs, UPDATE/DELETE/TRUNCATE inválidos são rejeitados; migration up reexecutável conforme teste |
| Provar atomicidade e publicação pós-commit | `test/integration/wagering.test.ts`, `outbox-publisher.test.ts` | Rodar casos de fault injection e LocalStack | Rollback deixa wallet/transaction/ledger/inbox/outbox sem efeitos parciais; só eventos de commits são publicados |

### P1 — Requisitos essenciais não comprovados

| Ação | Arquivos/módulos | Correção/validação | Critério objetivo |
|---|---|---|---|
| Executar replay/redelivery e restart | `test/integration/sqs.test.ts`, `wagering.test.ts` | Executar com PostgreSQL/LocalStack reais | Mesmo ID/payload retorna o mesmo transactionId e snapshot; crash pós-commit/pré-ack não duplica ledger |
| Executar REFUND/ROLLBACK concorrentes e ordem invertida | `test/integration/wagering.test.ts`, suites de concurrency | Rodar casos com duas instâncias reais | Uma reversão permitida por tipo; saldo/ledger consistentes; reversão sem fundos usa código distinto |
| Avaliar composição da FK da referência | `src/migrations/001_initial.ts`, `WageringService.validateReference` | Decidir se o banco deve impor wallet/currency na relação, além da validação de serviço; documentar a fronteira | Escrita SQL inválida não consegue associar reversal a wallet/moeda diferentes se a garantia for requerida no schema |
| Verificar limite de drain no SIGTERM | `src/infrastructure/messaging/sqs.ts`, `outbox-publisher.ts`, Compose | Simular SIGTERM com mensagens/in-flight e dependência lenta | Consumer termina dentro do grace period ou devolve visibilidade sem ACK prematuro; publisher não perde evento |

### P2 — Cobertura e robustez

| Ação | Arquivos/módulos | Correção/validação | Critério objetivo |
|---|---|---|---|
| Completar cobertura de status terminal/FAILED e códigos | `domain/wager-transaction.ts`, `domain/errors.ts`, `WageringService`, docs | Definir quando `FAILED` deve ser persistido versus rollback/retry; criar catálogo de códigos | Cada transição/código tem teste e semântica documentada, sem conversão indevida de falha transitória em rejeição |
| Validar métricas/logs em execução | `src/presentation/metrics.ts`, `process-metrics.ts`, `sqs.ts` | Scrape API e worker ativos e validar conteúdo/prometheus | Métricas esperadas presentes, IDs nos logs e sem payload financeiro completo |
| Testar setup reproduzível | `README.md`, Compose, scripts | Seguir comandos documentados do zero em ambiente Docker | Migration, API, health e testes completam sem ajuste manual e sem serviços de produção |

### P3 — Melhorias e diferenciais

| Ação | Arquivos/módulos | Critério objetivo |
|---|---|---|
| Adicionar teste de carga se houver benefício | `package.json`, nova suite opcional | `bun run test:load` reproduzível com ambiente, método, throughput, p50/p95/p99, erros, conflitos e outbox lag |
| Considerar OpenTelemetry/dashboard | infraestrutura | Tratar como opcional; não preceder validação de P0/P1 |
| Considerar ledger de partidas dobradas | domínio/schema | Diferencial somente se não comprometer correção nem aumentar risco financeiro |

**Sequência recomendada:** primeiro disponibilizar PostgreSQL/LocalStack descartáveis e executar as suites existentes; corrigir qualquer falha observada; só então atualizar status da matriz e recalcular a estimativa. Não reduzir os riscos eliminatórios por inferência a partir de build/unitários.
