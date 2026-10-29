# Depoimentos de alunos: configuração e operação

Este guia explica **o que você precisa configurar uma única vez** para o sistema de depoimentos funcionar de verdade (envio pelo link público, moderação e exibição na landing page).

> Enquanto isso **não** for configurado, o site continua funcionando normalmente: a seção de depoimentos mostra só o convite discreto, o formulário avisa que o envio ainda não está disponível e o painel mostra um aviso. Nada finge sucesso.

## Como funciona (visão geral)

O site é estático (GitHub Pages), então não tem servidor próprio. Para guardar depoimentos com segurança foi usado o **Supabase** (banco PostgreSQL + login + armazenamento de fotos + função de servidor). Plano gratuito atende bem.

| Peça | Onde fica | Para que serve |
|---|---|---|
| Landing page | `index.html` | Mostra os depoimentos aprovados/publicados |
| Link para alunos | `/enviar-depoimento/` | Formulário público (celular e computador) |
| Painel | `/admin/depoimentos/` | Moderação (somente administradores) |
| Banco, regras de acesso, bucket privado de fotos | `supabase/migrations/20261029000000_depoimentos.sql` | Tabelas, permissões (RLS), histórico, regras |
| Curso/evento e novos textos de consentimento (v2) | `supabase/migrations/20261029120000_curso_evento.sql` | Colunas do curso/evento, regras e histórico (rode depois da primeira) |
| Função de servidor | `supabase/functions/testimonials/` | Recebe envios (valida tudo, confere a foto de verdade, limita abusos) e entrega a lista pública |
| Configuração pública do site | `assets/js/site-config.js` | URL do projeto + chave pública |

Fluxo: aluno envia → registro **pendente** (nunca público) → administração edita/aprova → publica → (opcional) destaca. Só `aprovado` **e** `publicado` aparece no site; os **5 destaques** são escolhidos entre os publicados, na ordem que a administração definir.

## Passo a passo (cerca de 20 minutos)

### 1. Criar o projeto no Supabase
1. Crie uma conta em <https://supabase.com> e um **novo projeto** (região *South America (São Paulo)*). Anote a senha do banco.
2. Em **Project Settings → API** copie: **Project URL** (ex.: `https://abcdxyz.supabase.co`) e a chave **anon / publishable** (pública). **Nunca** use a `service_role`/`secret` no site.

### 2. Criar o banco, as regras de acesso e o bucket de fotos
1. No Supabase abra **SQL Editor → New query**.
2. Cole **todo** o conteúdo de `supabase/migrations/20261029000000_depoimentos.sql` e clique em **Run**. (Pode ser executado de novo sem problemas.)
3. Abra uma nova consulta, cole **todo** o conteúdo de `supabase/migrations/20261029120000_curso_evento.sql` e clique em **Run** (curso/evento e textos de consentimento v2). Em uma instalação nova rode as duas, nesta ordem.

Isso cria as tabelas, o histórico, as regras de integridade, o bucket **privado** `testimonial-photos` (5 MB, só JPEG/PNG/WebP) e as permissões.

### 3. Criar a conta de administrador (acesso protegido por login real)
1. **Authentication → Sign In / Providers → Email**: deixe o e-mail/senha habilitado e **desative “Allow new users to sign up”** (impede que estranhos criem contas).
2. **Authentication → Users → Add user → Create new user**: informe e-mail e uma **senha longa e única**, marque *Auto Confirm User*.
3. Copie o **User UID** do usuário criado e, no **SQL Editor**, execute:
   ```sql
   insert into public.admin_users (user_id) values ('COLE-O-UID-AQUI');
   ```
   Só quem estiver nessa tabela consegue ler/editar/excluir; outras contas, mesmo logadas, não veem nada (isso é imposto pelo banco, não pela tela).
4. Recomendado: em **Authentication → Attack Protection** ative a proteção contra bots (CAPTCHA) e use gerenciador de senhas.

### 4. Publicar a função de servidor
Precisa do [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase` ou Scoop no Windows). Na pasta do projeto:
```bash
supabase login
supabase link --project-ref SEU-PROJECT-REF        # é o trecho "abcdxyz" da Project URL
supabase functions deploy testimonials --no-verify-jwt
supabase secrets set ALLOWED_ORIGINS=https://masterclassdocomportamento.com.br,https://www.masterclassdocomportamento.com.br IP_HASH_SALT=$(openssl rand -hex 24)
```
- `ALLOWED_ORIGINS`: o endereço (só origem, sem caminho) onde o site é publicado. Se usar domínio próprio, coloque-o (separe vários por vírgula).
- `IP_HASH_SALT`: qualquer texto aleatório longo (no PowerShell use qualquer sequência longa). Serve para anonimizar o IP no limite de envios.
- A chave `service_role` é injetada **automaticamente** na função; ela nunca vai para o navegador nem para este repositório.
- Opcional, CAPTCHA no formulário (Cloudflare Turnstile, gratuito): crie o widget, rode `supabase secrets set TURNSTILE_SECRET_KEY=...` e coloque a *site key* em `turnstileSiteKey` no passo 5.

### 5. Conectar o site
Edite `assets/js/site-config.js`:
```js
window.SITE_CONFIG = {
  supabaseUrl: 'https://SEU-PROJETO.supabase.co',
  supabaseAnonKey: 'SUA-CHAVE-ANON-PUBLICA',
  turnstileSiteKey: ''           // opcional
};
```
Publique o site (commit + push para o GitHub Pages).

### 6. Conferir
- Abra `https://masterclassdocomportamento.com.br/enviar-depoimento/`, envie um depoimento de teste (com e sem foto).
- Abra `.../admin/depoimentos/`, entre com a conta do passo 3, aprove, publique e destaque.
- Recarregue a landing page: o depoimento deve aparecer.
- Depois **exclua** os depoimentos de teste pelo painel.

## Atualização: curso ou evento (versão v2 do formulário)

O formulário agora pergunta **"Qual curso ou evento você realizou?"** (Masterclass, A.T. na Prática, Weekend Pass, Imersão em Gerenciamento de Crise, Outro, Mais de um) e usa os novos textos de confirmação e de autorização de publicação (versão `v2-2026-10`). Se o seu Supabase já tinha a primeira versão funcionando, faça **nesta ordem**:

1. **Banco:** no SQL Editor do Supabase, rode `supabase/migrations/20261029120000_curso_evento.sql` (uma vez; pode repetir sem problema). Ela **não apaga nem altera** depoimentos existentes: eles ficam com o curso "não informado" e continuam com o texto de consentimento que aceitaram (v1).
2. **Função de servidor:** na pasta do projeto, rode `npx supabase functions deploy testimonials --no-verify-jwt` (a nova função recusa envios sem curso e só aceita o texto novo).
3. **Site:** publique os arquivos (commit + push).

Entre o passo 2 e o 3 (alguns minutos), o formulário antigo ainda no ar será recusado com a mensagem "A página está desatualizada. Recarregue e tente novamente." Para evitar isso, faça os passos 2 e 3 em seguida. **Não publique o site antes dos passos 1 e 2**, ou os envios falharão.

Como o curso/evento funciona:
- **Obrigatório** no formulário e também no servidor e no banco (envios novos sem curso são recusados). "Outro curso ou evento" e "Mais de um curso ou evento" exigem o campo complementar.
- **No site**, cada depoimento mostra uma linha discreta, por exemplo "Participante do Weekend Pass". "Outro" mostra "Participante de: <nome informado>" (após a aprovação do depoimento). "Mais de um" mostra "Participante de múltiplas formações", a menos que você marque **"Autorizo exibir publicamente os nomes informados"** no painel.
- **Depoimentos antigos** (sem curso informado) não exibem nenhum curso no site e aparecem no painel como "Curso ou evento não informado". O sistema nunca atribui um curso por conta própria.
- **No painel**, a lista e o depoimento mostram o curso. Você pode corrigir a opção (ou o nome) antes de publicar; o que o participante informou originalmente fica guardado em "Dados privados" e a correção entra no histórico. Isso nunca altera o texto do relato.
## Links para compartilhar
- **Alunos (WhatsApp):** `https://masterclassdocomportamento.com.br/enviar-depoimento/`
- **Painel (só administradores):** `https://masterclassdocomportamento.com.br/admin/depoimentos/` (não é indexado nem aparece no site)

(O site usa o domínio próprio definido no arquivo `CNAME`. Se também usar o endereço `github.io`, inclua-o em `ALLOWED_ORIGINS`.)

## Uso diário do painel
- **Filtros:** Pendentes, Aprovados, Publicados, Em destaque, Recusados, Todos.
- **Estados:** *Recebido (pendente)* → *Aprovado* → *Publicado* → *Em destaque*. Aprovar não publica; ocultar tira do site sem apagar; recusar/voltar a pendente também tira do site.
- **Edição:** corrija só ortografia/digitação. Se a mudança for grande (o banco compara com a última versão confirmada), o depoimento **sai do ar automaticamente** e fica “Aguardando confirmação do autor”: fale com o autor (o contato opcional que ele informou aparece em “Dados privados”) e use **Registrar confirmação do autor** descrevendo como confirmou; só então dá para publicar. Também há a caixa “Marcar como exige confirmação” para mudanças de sentido que o sistema não perceba (ex.: incluir “não”). O texto original enviado fica sempre visível.
- **Destaques:** em um depoimento publicado, clique **Destacar na página**; reordene com ↑ ↓ ou remova no quadro “Destaques da página”. Máximo de 5. Se nenhum destaque estiver escolhido, a landing mostra os publicados mais recentes até você escolher.
- **Foto:** substituir (use só recorte/versão da mesma foto enviada), remover, ou remover registrando revogação do uso de imagem.
- **Excluir:** apaga depoimento e foto de forma definitiva (confirmação em duas etapas). O histórico guarda só *que* algo foi feito, nunca o texto.
- **Pedido de retirada (LGPD):** abra o depoimento, **Ocultar** (imediato) ou **Excluir**.
- O painel sai sozinho após 30 min sem uso.

## Segurança e privacidade (resumo)
- Visitantes **não leem nem gravam** nada direto no banco; só a função de servidor, que valida tamanhos, links/HTML, consentimentos, tipo real e dimensões da foto, campo-isca e tempo mínimo de preenchimento, e limita envios por IP anonimizado (4/hora, 10/dia).
- Fotos em bucket **privado**; o público só vê por endereço temporário (1 h) e apenas de depoimentos publicados com autorização da foto. O navegador reduz a foto e remove metadados (EXIF/GPS).
- Consentimentos (texto, foto separada, versão do texto, data) ficam gravados no registro. Textos oficiais em `consent_texts`. Textos atuais: versão `v2-2026-10` (a `v1-2026-10` permanece registrada para os depoimentos antigos e nunca deve ser editada). Para mudar o texto: crie **nova versão** na tabela (nova migração), atualize `CONSENT_VERSION` em `supabase/functions/testimonials/validate.ts`, `data-consent-version` e o texto em `enviar-depoimento/index.html` (o teste automático verifica que HTML e banco são idênticos).
- Conteúdo é sempre inserido como **texto** (sem `innerHTML`) e as páginas têm CSP restritiva.
- A página do formulário e o painel **não carregam** Google Ads/Tag.

## Medição (analytics)
Eventos enviados pelo Google Tag **já existente** (sem criar outra tag): `clique_checkout_hotmart` (com `cta_local`), `viu_depoimentos` e `abriu_todos_depoimentos`. Nenhum texto ou dado pessoal é enviado. **Clique não é compra:** a compra segue sendo medida pela integração atual da Hotmart/Google. O envio de depoimentos é contado só no próprio banco (tabela `testimonials`).

## Vídeo de apresentação
Está em `index.html`, dentro de `#video-box`, atributo `data-video-id` (código de 11 caracteres do YouTube). O player só é carregado ao clicar. Se o código ficar vazio aparece “Vídeo em breve” sem quebrar a página.

## Pontos de atenção
- **Plano gratuito do Supabase pausa o projeto após ~1 semana sem uso.** Se isso acontecer, entre no painel do Supabase e clique em *Restore*; para uso contínuo considere o plano Pro. Faça backup/exportação periódica dos dados.
- A detecção de “mudança substancial” é uma **heurística** (similaridade e tamanho do texto); a marcação manual cobre o restante. A responsabilidade final da edição é da administração.
- Fotos de iPhone em HEIC precisam ser JPEG (o navegador do iPhone costuma converter sozinho ao escolher da galeria).
- Os arquivos `supabase/`, `docs/` e `tests/` ficam públicos junto com o site se forem enviados ao GitHub Pages (não contêm segredos). Se preferir, mantenha-os fora do repositório publicado.

## Testes automatizados
```bash
cd tests
npm install
npx playwright install chromium
npm test
```
Cobrem: regras do banco (RLS, triggers, RPCs) em Postgres real, validação do servidor e de imagens, e ponta a ponta em Chromium com emulação de celulares (landing, formulário com foto, painel, destaques, segurança, XSS, persistência após reinício). O servidor de teste (`tests/helpers/server.mjs`) **emula** a API do Supabase localmente; ele **não** substitui testar uma vez no seu projeto real (passo 6).
