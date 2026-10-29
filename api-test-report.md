# Relatório de Testes da API — Distributed Wagering Processor

**Data:** 29/10/2026
**Revisão identificada:** `c7143e6`; o worktree contém alterações locais, incluindo este relatório.
**Escopo:** requisitos da API do `README.md`, seções 2, 5–13, controllers, DTOs, serviço, domínio, filtro de exceções, health checks, métricas, migration, testes e stack de teste.
**Regra de evidência:** “inspecionado” significa análise estática; “teste existente” significa que há um teste escrito; “executado” significa que o runner reportou resultado; “comprovado” exige resultado observado no ambiente relevante. Não atribuí status APROVADO a nenhum cenário HTTP sem requisição HTTP executada.

## 1. Resumo executivo

**Situação geral:** a API e seus serviços relacionados estão implementados em código e compilam, mas a execução ponta a ponta foi bloqueada pela ausência de Docker. Nenhum endpoint foi iniciado ou chamado nesta auditoria. A implementação estática não substitui resposta HTTP observada.

| Indicador | Resultado |
|---|---:|
| Cenários HTTP solicitados (W01–W06, Q01–Q04, T01–T06, I01–I08, R01–R05, H01–H04) | 33 |
| APROVADOS / REPROVADOS / BLOQUEADOS / NÃO IMPLEMENTADOS | 0 / 0 / **33** / 0 |
| Type-check (`npm run build`) | Passou |
| Script `lint` (`npm run lint`) | Passou; executa `tsc --noEmit`, não há linter separado configurado |
| Testes unitários | 22 passaram, 0 falharam |
| Testes de integração | 0 passaram, 11 ignorados |
| Testes de concorrência | 0 passaram, 5 ignorados |
| Inicialização HTTP, migration, health checks e resposta real dos endpoints | **BLOQUEADOS / NÃO VERIFICADOS** |

O Compose foi tentado com o projeto isolado `jungle-api-audit-20261029`, usando o arquivo sem volumes persistentes `docker-compose.test.yml`. O processo falhou antes de criar containers: `/bin/bash: docker: command not found`. Não foi feita conexão com banco ou serviço externo, nem houve alteração de dados de desenvolvimento/produção.

A API também não foi inicializada apontando para a configuração padrão: `src/app.module.ts` usa `DATABASE_URL` ou, na ausência dela, conecta a `localhost:5432/wagering`, que não é um destino seguro para esta auditoria. Sem o stack descartável e sem confirmação de um database de teste, iniciar a aplicação poderia tocar dados fora do escopo isolado.

**Conclusão sobre o README §9:** não é possível declarar conformidade da API HTTP. A existência de controllers e testes de serviço não comprova contratos, códigos HTTP, corpo de resposta, persistência nem integração real. Os testes unitários aprovados comprovam apenas comportamentos de domínio/hash exercitados em memória.

### Riscos principais identificados por inspeção

- Não foi encontrada suíte de testes HTTP/e2e em `test/`; os testes presentes são de domínio ou usam diretamente `WageringService`.
- O código contém caminhos de resposta para sucesso, rejeição, pendência, conflito e falha transitória, mas nenhum desses códigos foi observado por uma chamada HTTP.
- As garantias financeiras e idempotentes dependem de PostgreSQL; as suites que poderiam testá-las foram ignoradas por ausência de `TEST_DATABASE_URL`.
- Autenticação não está implementada, decisão permitida e documentada no README §2 e em `ARCHITECTURE.md`; o código define `ProviderIdentityPort`, mas não há autorização de wallet em runtime para validar.
- Não houve defeito de produção reproduzido nesta sessão. Nenhuma correção foi feita com base apenas em suspeita estática.

## 2. Ambiente e evidências

### Versões/dependências observadas

| Componente | Versão/evidência |
|---|---|
| Node.js | `v24.11.0` |
| npm | `11.6.1` |
| Bun utilizado nos testes | `1.2.5`, via `npm exec --yes --package=bun@1.2.5` |
| TypeScript | `5.7.3` (`npm ls`) |
| NestJS common | `11.2.8` |
| MikroORM core/PostgreSQL | `6.6.17` |
| Banco/mensageria de teste | Docker/PostgreSQL/LocalStack não iniciados |

### Comandos executados e resultados

| Comando | Resultado real | Escopo da evidência |
|---|---|---|
| `docker compose -p jungle-api-audit-20261029 -f docker-compose.test.yml up -d --wait` | Falhou imediatamente: `docker: command not found`, exit 127 | Tentativa de stack isolado; nenhum container foi iniciado |
| `npm run build` | Exit 0; `tsc --noEmit` | Verificação de tipos/compilação, não execução da API |
| `npm run lint` | Exit 0; `tsc --noEmit` | O script é alias de type-check; não há ferramenta lint separada neste script |
| `npm exec --yes --package=bun@1.2.5 -- bun test test/unit` | 22 pass, 0 fail; 79 assertions; 6 arquivos | Testes unitários realmente executados |
| `npm exec --yes --package=bun@1.2.5 -- bun test test/integration` | 0 pass, 11 skip, 0 fail | 11 testes não executados; logs pediram PostgreSQL/LocalStack |
| `npm exec --yes --package=bun@1.2.5 -- bun test test/concurrency` | 0 pass, 5 skip, 0 fail | 5 testes não executados; log pediu `TEST_DATABASE_URL` |
| `npm exec --yes --package=bun@1.2.5 -- bun --version` | `1.2.5` | Versão do Bun utilizada |
| `npm ls --depth=0 typescript @nestjs/common @mikro-orm/core @mikro-orm/postgresql` | TypeScript 5.7.3, NestJS 11.2.8, MikroORM 6.6.17 | Dependências instaladas observadas |

O stack definido em `docker-compose.test.yml` usa portas 55432 e 14566, database `wagering_test` e não declara volumes. O guard em `test/helpers/postgres.ts` rejeita host não local e database sem sufixo de teste. Essas proteções foram inspecionadas; a migration e os serviços não puderam ser executados.

### Autenticação

O README §2 permite omitir autenticação, diz que não vale pontos e requer documentar a decisão/ponto de extensão. `ARCHITECTURE.md` documenta a ausência e `src/application/provider-identity.ts` fornece a interface de extensão. Não há credenciais de teste porque nenhum endpoint exige auth guard na implementação encontrada. Não alterei nem desativei autenticação; as chamadas HTTP de saúde também não foram executadas.

## 3. Matriz de endpoints

**Resultado** abaixo se refere a execução HTTP real. “Inspeção” resume o código, não é uma resposta observada. Não há testes HTTP/e2e encontrados em `test/`.

| Endpoint | Cenários | Testes executados | Resultado HTTP | Inspeção estática | Pendências |
|---|---|---|---|---|---|
| `POST /wallets` | W01–W06 | Nenhum HTTP; testes de serviço em integração foram ignorados | **BLOQUEADO** | Controller delega a `createWallet`; serviço cria wallet e, para saldo positivo, OPENING/ledger/outbox no callback transacional | Executar sucesso, zero, validação, duplicata, moedas e rollback contra PostgreSQL |
| `GET /wallets/:walletId` | Q01 | Nenhum | **BLOQUEADO** | `ParseUUIDPipe`; serviço retorna wallet ou controller mapeia ausência para 404 | Chamar endpoint com existente, ausente e UUID inválido |
| `GET /wallets/:walletId/ledger` | Q02 | Nenhum | **BLOQUEADO** | Cursor keyset baseado em `(created_at,id)`, filtro por wallet, limite 1–100 | Verificar páginas, mesmo timestamp, novos inserts, cursor inválido e limites no servidor/DB |
| `GET /wagering/transactions/:transactionId` | Q03 | Nenhum | **BLOQUEADO** | UUID parseado; ausência mapeada para 404 | Validar corpo/status de transação persistida e IDs inválidos |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Q04 | Nenhum | **BLOQUEADO** | Consulta filtra provider + external ID; rota não aplica UUID ao provider ou external ID | Testar isolamento entre providers, URL encoding e inexistência |
| `POST /wagering/transactions` | T01–T06, I01–I08 | Unitários de hash/domínio passaram; integração de serviço e concorrência ignoradas | **BLOQUEADO** | Header exigido; serviço usa payload hash e DB; controller define 200/202/422; filtro trata erros | Requisições HTTP, persistência, replay, concorrência, reinício e status reais |
| `POST /wagering/transactions/queue` | Cobertura complementar | Nenhum HTTP; SQS indisponível | **BLOQUEADO** | Header validado; resposta declarada 202; mensagem vai à fila | Verificar publicação, contrato, retries e idempotência após consumo |
| `POST /wallets/:walletId/reconciliation` | R01–R05 | Nenhum; testes que precisam de DB foram ignorados | **BLOQUEADO** | Serviço agrega ledger e saldo em uma query; controller loga/incrementa métrica para divergência | Exercitar saldo consistente/divergente, concorrência e métricas persistidas/observadas |
| `GET /health/live` | H01, H03, H04 | Nenhum HTTP | **BLOQUEADO** | Controller retorna `{status:"live"}` sem consulta a dependências | Confirmar status 200 e ausência de dados sensíveis no runtime |
| `GET /health/ready` | H02–H04 | Nenhum HTTP; dependências indisponíveis | **BLOQUEADO** | Verifica PostgreSQL e SQS; retorna 200 se ambas e 503 caso contrário; corpo inclui booleanos | Testar sucesso e falha de cada dependência, comparar live/ready e inspecionar corpo real |
| `GET /metrics` | Fora da lista numerada, listado no README | Nenhum HTTP | **BLOQUEADO** | Consulta métricas duráveis e counters por processo | Verificar formato e disponibilidade com DB ligado/desligado |

## 4. Resultados detalhados

Todos os cenários a seguir receberam **BLOQUEADO** porque não houve aplicação HTTP em execução nem PostgreSQL/LocalStack. Isso não significa que o código foi provado incorreto; significa que o comportamento de API não foi observado. Testes de domínio relacionados são citados sem promovê-los a testes HTTP aprovados.

### 4.1 Criação de wallet — W01–W06

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| W01 | Criar saldo positivo; resposta com id/player/balance/version; OPENING e um CREDIT atômicos | Nenhuma chamada HTTP/consulta SQL. Inspeção: `WageringService.createWallet` possui as gravações no mesmo `database.transaction` | `test/integration/wagering.test.ts` contém persistência/ledger; ignorado | **BLOQUEADO** | Nenhum defeito reproduzido; executar contra DB descartável |
| W02 | Saldo zero sem crédito indevido | Nenhuma chamada/consulta. Inspeção: OPENING é criado apenas se `initial.isPositive()` | Sem cenário HTTP; testes de wallet são unitários, não persistência | **BLOQUEADO** | Confirmar wallet sem OPENING/ledger por query real |
| W03 | Rejeitar campos/formato/escala/moeda inválidos sem efeitos parciais | Nenhum HTTP; unit tests de Money passaram, sem provar DTO/filter | `test/unit/money.test.ts` executado; não cobre endpoint | **BLOQUEADO** | Testar todos os casos via HTTP e contar registros antes/depois |
| W04 | Duplicata do mesmo player/moeda retorna conflito e não duplica abertura | Nenhuma chamada nem query. Inspeção: unique `(player_id,currency)` e controller trata 23505 | `test/integration/migrations.test.ts` testa constraints, ignorado; não há HTTP test | **BLOQUEADO** | Validar 409, corpo e persistência com duas chamadas |
| W05 | Mesmo player em moedas distintas é permitido se moeda válida | Nenhuma chamada. Inspeção: unicidade composta; Money aceita moedas da lista ISO suportada | Nenhum teste HTTP/integrado executado | **BLOQUEADO** | Confirmar duas moedas distintas no DB |
| W06 | Falha após escrita provoca rollback de wallet/OPENING/ledger | Falha controlada não executada. Helper `FaultInjectingDatabase` existe para serviço de wagering, não identificada cobertura equivalente da criação de wallet | Sem teste correspondente executado; teste de atomicidade de wager foi ignorado | **BLOQUEADO** | Adicionar/rodar fault injection da criação e verificar zero registros após rollback |

### 4.2 Consultas — Q01–Q04

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| Q01 | Wallet válida retorna dados; ausente 404; UUID inválido 400; isolamento | Nenhuma requisição. Inspeção: ParseUUIDPipe e NotFoundException; DB não foi consultado | Nenhum teste HTTP encontrado | **BLOQUEADO** | Executar chamadas e conferir resposta/DB |
| Q02 | Ledger vazio e paginado; cursor válido/inválido; limites; páginas sem perda/duplicação | Nenhuma requisição. Inspeção: cursor keyset `(created_at,id)`, limite default 50 e faixa 1–100 | Nenhum teste de controller/paginação executado | **BLOQUEADO** | Testar no DB; a página por keyset não fornece snapshot fixo diante de inserções, sem semântica HTTP observada |
| Q03 | Busca por UUID interno; ausente/UUID inválido; status persistido | Nenhuma chamada. Inspeção: UUID pipe, leitura por id e 404 se inexistente | Nenhum teste HTTP encontrado | **BLOQUEADO** | Exercitar rota com transação persistida |
| Q04 | Busca provider/external ID; isolamento provider; URL encoding; não encontrado | Nenhuma chamada. Inspeção: query usa ambos os campos; parâmetros externos são strings | Nenhum teste HTTP encontrado | **BLOQUEADO** | Testar providers diferentes, caracteres reservados e not-found |

**Cursor (inspeção, não comportamento comprovado):** a implementação consulta keyset por `(created_at,id)` e restringe por `wallet_id`; não é offset disfarçado. O valor codificado não é assinado, mas não permite trocar o `wallet_id` da query. Inserções novas com chave posterior à posição podem não aparecer na sequência já paginada; não há contrato de snapshot documentado.

### 4.3 Submissão — T01–T06

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| T01 | BET reduz saldo, gera um DEBIT e resposta coincide com DB | Nenhuma chamada HTTP/SQL. Unitário de wallet debit passou | Testes de integração de wagering ignorados; não são HTTP tests | **BLOQUEADO** | Validar resposta e ledger real |
| T02 | BET/WIN/LOSS/REFUND/ROLLBACK com direção, valor, referência e rejeições corretas | Nenhum fluxo persistido executado nesta auditoria | `test/integration/wagering.test.ts` inclui modalidades; ignorado | **BLOQUEADO** | Rodar integração e consultas independentes ao ledger |
| T03 | BET acima do saldo rejeitado, sem débito e com failureCode estável | Nenhuma resposta observada | Unitário prova `Wallet.debit` recusar overdraw; integração ignorada | **BLOQUEADO** | Testar HTTP status/body e ausência de ledger |
| T04 | DTO inválido é distinto de rejeição de negócio, sem persistência parcial | Nenhuma requisição. Inspeção: ValidationPipe whitelist/forbid; filtro global | Sem HTTP test executado | **BLOQUEADO** | Fazer matriz de payload inválido por HTTP |
| T05 | Player diferente do owner é rejeitado sem saldo/ledger | Nenhuma chamada/consulta | Integração “wallet identity mismatch” existe, ignorada | **BLOQUEADO** | Executar e consultar estado persistido |
| T06 | Transaction/wallet/ledger/inbox/outbox são atômicos; evento só após commit | Nenhuma transação/queue executada. Inspeção: DB transaction grava outbox e publisher separado | Testes de falha/integração ignorados | **BLOQUEADO** | Rodar fault injection e LocalStack, verificando rollback e publicação |

### 4.4 Idempotência — I01–I08

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| I01 | Header ausente retorna erro e não altera saldo | Nenhum HTTP. Inspeção: controller lança RangeError | Sem HTTP test | **BLOQUEADO** | Confirmar 400/corpo e ausência de gravações |
| I02 | Primeira chamada processa uma vez e retorna `idempotentReplay:false` | Nenhuma chamada HTTP | Integração de serviço existe, ignorada | **BLOQUEADO** | Testar status/body/DB |
| I03 | Repetição idêntica retorna snapshot original e não duplica ledger | Nenhuma chamada HTTP. Unit hash apenas prova canonical hash | `test/integration/wagering.test.ts` tem replay e saldo original, ignorado | **BLOQUEADO** | Repetir via HTTP após mudança de saldo e verificar snapshot/ledger |
| I04 | Mesma key e campos de negócio divergentes gera conflito sem novo efeito | Nenhuma chamada. Hash unitário detecta mudança de campos cobertos, mas não status HTTP nem todos os casos | `test/unit/idempotency.test.ts` executado; integração concorrente divergente ignorada | **BLOQUEADO** | Testar cada campo pela API e constraint external-ID |
| I05 | Ordem de chaves JSON não altera hash; campos de transporte não entram | Nenhuma chamada. Unit tests de hash passaram; algoritmo usa SHA-256 e objeto de negócio explícito | `test/unit/idempotency.test.ts` executado | **BLOQUEADO** para API; hash unitário aprovado | Repetir JSON reordenado no endpoint e confirmar replay |
| I06 | Dezenas simultâneas mesma chave convergem; divergentes sem duplicação | Nenhum cenário PostgreSQL/HTTP executado | Testes de 50 submissões e payload divergente existem; integração/concurrency ignoradas | **BLOQUEADO** | Rodar 50 concorrências contra app/DB isolados |
| I07 | Após reiniciar API, repetição mantém resposta e sem novo efeito | Nenhum reinício/API executado | Integração reabre ORM e testa replay, mas foi ignorada | **BLOQUEADO** | Executar restart real e comparar resposta e linhas |
| I08 | Três instâncias HTTP compartilham persistência sem duplicar efeito | Nenhuma instância iniciada | Teste de três processos de serviço existe, não são três endpoints/instâncias HTTP; ignorado | **BLOQUEADO** | Iniciar 3 API containers e disparar requisições simultâneas |

### 4.5 Reconciliação — R01–R05

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| R01 | Saldo e soma do ledger iguais; diferença zero e contagem correta | Nenhuma chamada/consulta. Inspeção: uma query agrega wallet e ledger | Integração de reconciliação existe, ignorada | **BLOQUEADO** | Rodar com histórico financeiro real |
| R02 | Divergência detectada/logada/metricada sem autocorreção | Nenhuma divergência criada. Inspeção: controller incrementa métrica e loga | Não foi executado teste de corrupção controlada | **BLOQUEADO** | Criar divergência somente no DB descartável e validar corpo/log/metric |
| R03 | Wallet ausente retorna 404 sem inventar estado | Nenhuma chamada | Nenhum teste HTTP | **BLOQUEADO** | Executar endpoint com UUID válido não existente |
| R04 | Reconstrução considera abertura, débito, crédito, refund e rollback | Nenhuma consulta real. Query soma CREDITS menos DEBITS | Helper `assertWalletLedgerInvariant` existe, suites DB ignoradas | **BLOQUEADO** | Executar helper e comparar independentemente com resposta |
| R05 | Reconciliação simultânea a transações não gera falso positivo | Nenhuma concorrência executada. `ARCHITECTURE.md` descreve leitura consistente por uma instrução SQL | Nenhum teste de corrida de reconciliação encontrado/executado | **BLOQUEADO** | Adicionar teste concorrente PostgreSQL e definir snapshot esperado |

### 4.6 Health checks — H01–H04

| ID | Objetivo / esperado | Observado | Teste correspondente | Status | Defeito/correção |
|---|---|---|---|---|---|
| H01 | Live aberto e 200 independente de PG/SQS | Nenhuma chamada. Inspeção: retorna `{status:"live"}` sem acesso a dependências | Nenhum HTTP test | **BLOQUEADO** | Testar com dependências indisponíveis |
| H02 | Ready 200 se ambos respondem; 503 se PG ou SQS falhar | Nenhuma chamada; os serviços não foram iniciados | Nenhum teste de health | **BLOQUEADO** | Testar cada dependência ligada/desligada em containers isolados |
| H03 | Live continua 200 quando ready falha | Nenhuma dependência foi interrompida | Nenhum teste de health | **BLOQUEADO** | Executar interrupção controlada de PG e SQS |
| H04 | Health não expõe segredos/stack traces | Nenhuma resposta observada. Inspeção mostra status e booleans de dependências em ready | Nenhum HTTP test | **BLOQUEADO** | Inspecionar respostas reais em estados ready/not-ready |

## 5. Matriz de códigos HTTP e erros

**Nenhum status desta tabela foi observado por HTTP.** A coluna “inspeção do código” representa o caminho estático, sujeito a validação por runtime. Forma geral do filtro: `{ statusCode, code, message, correlationId? }`; sucesso mantém os DTOs/objetos retornados pelos controllers.

| Categoria | Status previsto pela inspeção | Corpo/código encontrado | Status observado | Avaliação |
|---|---:|---|---|---|
| Payload inválido / DTO inválido / header ausente | 400 | `INVALID_REQUEST`; mensagens de validação do Nest podem ser agregadas pelo filtro | Não medido | Inspecionado, não comprovado |
| Idempotency conflict / transaction ID conflict | 409 | códigos de domínio `IDEMPOTENCY_CONFLICT` ou `TRANSACTION_ID_CONFLICT` | Não medido | Inspecionado, não comprovado |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` pelo controller | Não medido | Inspecionado, não comprovado |
| Outras unique violations | 409 | `RESOURCE_CONFLICT` no filtro global | Não medido | Inspecionado, não comprovado |
| Rejeição de negócio em POST síncrono | 422 quando o serviço retorna `REJECTED`; o filtro global mapeia `DomainError` não tratado para 400 por padrão | Resposta terminal contém `failureCode` | Não medido | Fluxos esperados são convertidos em resultado no `WageringService`; testar se todos os erros de negócio seguem caminho coerente |
| Saldo insuficiente / rollback sem saldo | 422 quando domínio lança erro; resposta de negócio pode usar failureCode | `INSUFFICIENT_FUNDS` / `ROLLBACK_WOULD_OVERDRAW` | Não medido | Inspecionado, não comprovado |
| Referência pendente | 202 | `status: PENDING_REFERENCE` e snapshot | Não medido | Inspecionado, não comprovado |
| Falha transitória de infraestrutura | 503 | `TRANSIENT_INFRASTRUCTURE_FAILURE` | Não medido | Inspecionado, não comprovado |
| Recurso não encontrado | 404 | `WALLET_NOT_FOUND` ou `TRANSACTION_NOT_FOUND` | Não medido | Inspecionado, não comprovado |
| Criação de wallet | 201 por padrão NestJS | Objeto de wallet | Não medido | Inspecionado, não comprovado |
| GET de recurso | 200 por padrão NestJS | Objeto consultado | Não medido | Inspecionado, não comprovado |
| Requisição SQS enfileirada | 202 | `{messageId,status:"ACCEPTED"}` | Não medido | Inspecionado, SQS indisponível |
| Health ready indisponível | 503 | `{status:"not_ready",dependencies:{postgres,sqs}}` | Não medido | Inspecionado, não comprovado |
| Erro inesperado | 500 | `INTERNAL_ERROR`; filtro não serializa stack trace no corpo | Não medido | Inspecionado, não comprovado |
| Autenticação/autorização | N/A no desenho atual | README permite ausência; não foi encontrado guard nos controllers inspecionados | Não medido | Não penalizar ausência; implantação requer ambiente confiável |

A distinção lógica existe no filtro/controller, mas “status previstos” não podem ser tratados como evidência de status observados. A mensagem de erro não deve ser a única fonte para retry; o consumidor deve usar status/código, que ainda precisam ser exercitados.

## 6. Idempotência e concorrência

### Inspecionado

- `POST /wagering/transactions` exige `Idempotency-Key` e passa a chave ao `WageringService`.
- Hash SHA-256 é feito sobre campos de negócio explicitamente selecionados e canonicalizados; os testes unitários verificam ordem de chaves e mudança de campo.
- PostgreSQL possui unicidades persistentes para provider+idempotency key e provider+external transaction ID.
- Resultado da transação inclui `response_balance` persistido, usado na reidratação/replay.
- Há casos escritos para replay/reinício, 50 submissões, payload divergente e três processos.

### Executado e comprovado nesta sessão

- Hash canônico: unit tests passaram.
- Idempotência persistente, replay após restart, concorrência com PostgreSQL, três processos e três instâncias HTTP: **não executados**.
- Resultado de `bun test test/concurrency`: 0 pass, 5 skip, 0 fail; o runner explicitou falta de `TEST_DATABASE_URL`.
- Portanto, não é possível declarar comprovada a garantia de não duplicar efeitos em ambiente distribuído.

## 7. Integridade financeira e reconciliação

**Invariantes observadas por teste executado:** aritmética exata de `Money`, precisão/escala, rejeição de overdraw no agregado, equilíbrio de uma entrada de ledger e consistência do hash, dentro dos testes unitários.

**Invariantes não observadas em dados persistidos:** saldo materializado igual à soma do ledger; uma única entrada de débito sob race; constraints e triggers de PostgreSQL; rollback atômico após falha; invariantes em REFUND/ROLLBACK; publicação post-commit. O helper `assertWalletLedgerInvariant` existe, mas só é chamado pelos testes que não rodaram.

Nenhuma divergência financeira foi produzida/observada; isso não significa que o endpoint foi aprovado. Nenhum saldo foi alterado nesta auditoria.

## 8. Defeitos e correções

| Severidade | Problema confirmado | Causa/evidência | Alterações | Regressão executada |
|---|---|---|---|---|
| P1 de validação/entrega | Nenhum teste HTTP e2e foi executado; execução bloqueada | Compose de teste falhou antes da inicialização por ausência de `docker`; integração real não rodou | Nenhuma alteração de produção. `api-test-report.md` documenta bloqueios; não adicionei mocks para simular serviço real | Build, lint e 22 unitários passaram; testes de integração/concurrency seguem bloqueados |

**Não foi confirmado defeito funcional em endpoint**, porque nenhum endpoint foi chamado. Não declarei correção de código sem reprodução.

## 9. Pendências e limitações

1. Instalar/disponibilizar Docker Engine e Docker Compose ou fornecer ambiente isolado equivalente aprovado.
2. Iniciar exclusivamente `docker-compose.test.yml` sob nome de projeto distinto; verificar readiness dos serviços.
3. Exportar `TEST_DATABASE_URL` seguro e endpoints SQS de teste; executar migration apenas em `wagering_test`.
4. Executar suites de integração e concorrência sem skips; registrar saídas completas.
5. Iniciar a API (pelo menos uma instância; três para I08) apontando apenas para banco/filas de teste e executar cenários HTTP.
6. Adicionar testes HTTP/e2e não-mocados para endpoints, status/body, validação e isolamento, usando a stack de teste.
7. Testar falhas de health, reconciliação divergente, criação de wallet sob fault injection, retry e shutdown.
8. Recalcular a matriz após observação efetiva. Não converter automaticamente testes escritos ou inspeção estática em aprovação.

**Bloqueio observado preciso:** o comando de Compose não foi executável porque o binário `docker` não está no PATH/disponível no ambiente. Não há `podman`, `colima` ou `psql` disponível conforme a checagem de comandos.

## 10. Conclusão

- **Todos os endpoints foram testados?** Não. Nenhum endpoint HTTP foi chamado; a execução ficou bloqueada.
- **Idempotência foi comprovada?** Não para a API/PostgreSQL. Somente canonicalização/hash em unit tests passou.
- **Status HTTP permitem retries seguros?** O mapeamento está implementado estaticamente e diferencia algumas categorias, mas não foi observado nem validado com requests.
- **Integridade financeira foi validada?** Parcialmente em domínio unitário; não foi validada em banco real nem concorrência.
- **Health checks atendem ao contrato?** O código tem rotas separadas, mas nenhum health check foi executado.
- **Há falha eliminatória comprovada?** Nenhuma foi reproduzida nesta sessão.
- **Há risco financeiro não descartado?** Sim. Corrida, duplicação, atomicidade, schema e idempotência distribuída não foram exercitados contra PostgreSQL/SQS.
- **O que falta para conformidade?** Execução ponta a ponta em stack isolado real, sem skips, incluindo migrations, API HTTP, concurrency, restart, redelivery e verificação independente do ledger.

Resultado final desta rodada: **33 cenários da matriz HTTP BLOQUEADOS, 0 aprovados, 0 reprovados**. Build e unitários passam, mas não autorizam afirmar conformidade da API ou integridade financeira distribuída.
