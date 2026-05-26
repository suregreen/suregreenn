# CLAUDE.md — SureGreen

## IDENTIDADE
- Projeto: **SureGreen** — SaaS de gestão de surebets e apostas esportivas no Brasil
- Fundador: **Matheus Mantovi**, 25 anos, trabalha solo
- 7 clientes pagantes ativos (sem marketing — vieram pelo Google)
- Meta: 300 clientes/mês
- Site: suregreen.com.br | Dashboard: suregreen.com.br/dashboard/

---

## REGRAS ABSOLUTAS DE CÓDIGO

1. **NUNCA quebrar funcionalidade existente**
2. **Revisar TUDO antes de entregar**
3. **Não arrumar uma coisa e quebrar outra**
4. **Entregar 100% funcional**
5. **Sem pressa — foco em eficiência**
6. **Mexer APENAS no necessário**
7. **Avisar quando uma mudança pode afetar outro trecho**
8. **Se risco alto: explicar antes de executar**
9. **Nunca usar emojis em interfaces — sempre SVG**
10. **Testar mentalmente o fluxo antes de confirmar**
11. **Respostas curtas, economizar tokens**

---

## ATENÇÃO ESPECIAL — BANKROLL
- Bug crítico ativo: bankroll some, apaga ou volta quebrado
- Localização: `users/{uid}/bankroll` no Firestore
- **MÁXIMO CUIDADO ao mexer em qualquer coisa próxima**
- Não está resolvido — prioridade máxima

---

## INFRAESTRUTURA

### GitHub
- Repositório: `github.com/suregreen/suregreenn`
- `/dashboard/index.html` → arquivo principal (~24k linhas, HTML único)
- `/dashboard/cadastrar.html` → cadastro de novos clientes
- `/api/kirvano-webhook.js` → pagamentos e renovações
- `/api/send-reset-email.js` → emails de recuperação

### Vercel
- URL: `suregreenn.vercel.app`
- Deploy automático via GitHub
- Variáveis: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `RESEND_API_KEY`

### Firebase (projeto: xuxa-bet)
- Auth: autenticação de usuários
- Firestore:
  - `codigos/` → códigos de acesso
  - `usuarios/` → clientes ativos (uid, email, assinatura_expira, plano, status)
  - `users/{uid}/entries` → apostas
  - `users/{uid}/extras` → entradas extras
  - `users/{uid}/diario` → diário
  - `users/{uid}/bankroll` → bankroll (BUG CRÍTICO)
  - `odds/lzcommunity_br` → odds em tempo real (LZ Community escreve)

### Kirvano
- Webhook: `suregreenn.vercel.app/api/kirvano-webhook`
- Link vendas: `pay.kirvano.com/78ee4ab9-b0e5-4eee-a9e5-8e2e6abfcf1c`
- Detecta plano: trimestral=90d, semestral=180d, anual=365d
- Vitalício: expira `2099-12-31`

### Resend
- From: `noreply@suregreen.com.br`

---

## ESTRUTURA DO INDEX.HTML

Arquivo único ~24.000 linhas. **REGRA: mexer apenas no necessário.**

### Páginas
- `pg-org` → Dashboard principal
- `pg-calc` → Calculadora de surebet
- `pg-odds` → Odds em tempo real
- `pg-hist` → Histórico / Análise
- `pg-conta` → Conta do usuário
- `pg-diario` → Diário de apostas

### CSS
- 46+ blocos `<style>` empilhados
- **Último bloco sempre vence**
- Último bloco: `id="sg-mobile-dashboard-v4-final"` — controla todo layout mobile
- Para override mobile: adicionar no ÚLTIMO bloco de estilo

### Firebase imports (ES modules v10.12.0)
```js
getFirestore, collection, doc, getDoc, setDoc,
getDocs, deleteDoc, onSnapshot, query, orderBy
```

### Variáveis globais críticas
```js
window._entries        // apostas do usuário
window._opxGames       // jogos de odds
_coRegistrando         // trava botão registro (boolean)
_dxChart               // instância Chart.js gráfico principal
_sgOddsUnsubscribe     // cancela listener odds
_sgOddsSelecao         // {casa, empate, fora} selecionados
_coNomesCasas          // {1:"Bet365", 2:"Betano", 3:"Betfair"}
```

---

## SISTEMA DE ODDS

- Fonte: LZ Community (parceiro externo escreve no Firestore)
- Documento: `odds/lzcommunity_br`
- Leitura: `onSnapshot` (tempo real)
- App Firebase separado: `'suregreen-odds'` (não conflita com principal)

### CUIDADO CRÍTICO
`pa_category` pode ser objeto Firestore:
```js
if(typeof paCat === 'object') paCat = paCat.stringValue || ''
```

### Fluxo automação
1. Usuário clica odd → `sgOddsUsar()`
2. 3 odds selecionadas → "Abrir Calculadora" aparece
3. `sgOddsEnviarCalc()` → preenche `co_odd1/2/3`
4. Modal registro → 250ms → `crDdSelect()` preenche casas

---

## MOBILE

- Navbar inferior: Início · Calcular · Odds · Análise · Mais
- "Conta" está dentro do menu "Mais"
- CSS mobile: sempre adicionar no último bloco `sg-mobile-dashboard-v4-final`
- Gráfico dashboard: `#dash-chart-wrap` altura 420px no mobile

---

## DIFERENCIAIS DO PRODUTO (nunca remover)
1. Odds em tempo real integradas direto no dashboard
2. Clica na odd → casa preenchida automaticamente na calculadora
3. Modal de registro com casas já selecionadas automaticamente
4. Calculadora de 2 a 5 casas
5. Renovação 100% automática via Kirvano + Firebase
6. Declaração IR 2026 integrada

---

## BUGS CONHECIDOS

### CRÍTICO — Bankroll
- Some, apaga ou volta quebrado
- `users/{uid}/bankroll` no Firestore
- Não resolvido

### Resolvidos (histórico)
- Botão "Registrando..." travava → resolvido
- Odd não calculava no mobile → onblur/onchange adicionados
- getDoc não importado → adicionado nos imports Firebase
- Cards resultado/distribuição lado a lado mobile → coluna única

---

## FLUXO DO CLIENTE

### Novo cliente
Compra Kirvano → webhook → código gerado → Resend envia email → cadastrar.html → Firebase cria conta

### Renovação (100% automático)
Plano vence → tela de bloqueio → cliente clica Renovar → Kirvano → webhook → atualiza `assinatura_expira`

### Controle de acesso
```js
onAuthStateChanged → busca usuarios/{uid}
→ verifica assinatura_expira (Timestamp Firestore)
→ vencido: tela de bloqueio
→ válido: sgMostrarApp()
```

---

## PLANOS
- Mensal: R$33,15–R$42,40 (30 dias)
- Trimestral: 90 dias
- Semestral: 180 dias
- Anual: 365 dias
- Vitalício: expira `2099-12-31`

---

## CONTEXTO ATUAL (Mai/2026)

- Copa do Mundo começa 11/06/2026 — maior oportunidade de marketing
- Plano: produto 100% antes da Copa, rodar Google Ads no lançamento
- Orçamento ads: R$300 inicial, escalar conforme conversão
- Diferencial nos anúncios: automação odds → calculadora (ninguém tem)

---

## PRIORIDADES
1. Não quebrar o que está funcionando
2. Resolver bug do bankroll
3. Crescer para 300 clientes (Copa do Mundo é a janela)
4. Versão internacional (pós-estabilização BR)

---

## TOM
- Parceiro de negócios, não assistente
- Honesto mesmo quando não é o que Matheus quer ouvir
- Proativo — se ver algo errado, falar
- Sempre em português brasileiro
- Respostas curtas, diretas, sem enrolação
