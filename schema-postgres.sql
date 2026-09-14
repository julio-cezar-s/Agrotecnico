-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  AgroTécnico — Schema do Banco de Dados (PostgreSQL / produção)   ║
-- ║                                                                    ║
-- ║  Tradução direta de schema.sql (SQLite/MVP) para PostgreSQL.      ║
-- ║  Executado automaticamente por db.js no boot do driver Postgres,  ║
-- ║  do mesmo jeito que schema.sql é executado pelo driver SQLite.    ║
-- ║                                                                    ║
-- ║  Diferenças em relação ao schema.sql original:                    ║
-- ║   - INTEGER PRIMARY KEY AUTOINCREMENT → GENERATED ALWAYS AS        ║
-- ║     IDENTITY (padrão moderno do Postgres, substitui SERIAL)       ║
-- ║   - INTEGER 0/1 com CHECK — mantido IDÊNTICO ao schema.sql        ║
-- ║     (não usa BOOLEAN nativo: testado contra Postgres real e o     ║
-- ║     driver rejeita o cast implícito 0/1→boolean que as queries    ║
-- ║     de db.js fazem; manter INTEGER elimina esse descompasso sem   ║
-- ║     precisar reescrever cada INSERT/UPDATE por tipo de coluna)    ║
-- ║   - TEXT com datetime('now') → TIMESTAMPTZ com NOW()              ║
-- ║   - IF NOT EXISTS mantido — reexecução segura, igual ao SQLite    ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ══════════════════════════════════════════════════════════════════
-- PRODUTORES
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS produtores (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome              TEXT        NOT NULL,
  identificador     TEXT        NOT NULL UNIQUE,
  tipo_ident        TEXT        NOT NULL CHECK (tipo_ident IN ('email','tel')),
  senha_hash        TEXT        NOT NULL,
  aceita_novidades  INTEGER     NOT NULL DEFAULT 0 CHECK (aceita_novidades IN (0,1)),
  ativo             INTEGER     NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_produtores_ident ON produtores(identificador);

-- Sessões de produtor logado (cookie HttpOnly agro_prod_sess) — espelha
-- tecnico_sessoes. Adicionada para substituir a sessão "apenas localStorage"
-- do MVP original por autenticação real de servidor.
CREATE TABLE IF NOT EXISTS produtor_sessoes (
  token        TEXT PRIMARY KEY,
  produtor_id  BIGINT NOT NULL REFERENCES produtores(id) ON DELETE CASCADE,
  ip_hash      TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_produtor_sessoes_produtor ON produtor_sessoes(produtor_id);

-- ══════════════════════════════════════════════════════════════════
-- TÉCNICOS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tecnicos (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id             TEXT UNIQUE,
  nome                  TEXT NOT NULL,
  whatsapp              TEXT NOT NULL,
  email                 TEXT,
  cpf_hash              TEXT NOT NULL,
  senha_hash            TEXT,
  upload_token          TEXT,

  cidade                TEXT NOT NULL,
  uf                    TEXT NOT NULL CHECK (length(uf) = 2),
  lat                   DOUBLE PRECISION,
  lng                   DOUBLE PRECISION,

  formacao              TEXT,
  conselho              TEXT CHECK (conselho IN ('CREA','CRMV','CFTA')),
  num_conselho          TEXT,
  uf_conselho           TEXT CHECK (uf_conselho IS NULL OR length(uf_conselho) = 2),
  registro_completo     TEXT,

  bio                   TEXT,
  experiencia           TEXT,
  especialidades        TEXT NOT NULL DEFAULT '[]',
  servicos              TEXT NOT NULL DEFAULT '[]',
  raio_km               INTEGER DEFAULT 100,
  servico               TEXT,

  doc_path              TEXT,
  doc_original_name     TEXT,
  doc_mime              TEXT,
  doc_enviado_em        TIMESTAMPTZ,

  status                TEXT NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente','ativo','suspenso','recusado')),
  ativo                 INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0,1)),
  validado_em           TIMESTAMPTZ,
  validado_por          TEXT,
  suspensao_auto        INTEGER NOT NULL DEFAULT 0 CHECK (suspensao_auto IN (0,1)),
  suspensao_data        TIMESTAMPTZ,

  premium               INTEGER NOT NULL DEFAULT 0 CHECK (premium IN (0,1)),
  premium_desde         TIMESTAMPTZ,
  premium_expira_em     TIMESTAMPTZ,               -- renovada a cada pagamento aprovado; Premium efetivo = premium=1 AND premium_expira_em > agora
  premium_pagamento_id  TEXT,

  media_avaliacoes      REAL NOT NULL DEFAULT 0,
  total_avaliacoes      INTEGER NOT NULL DEFAULT 0,
  visualizacoes         INTEGER NOT NULL DEFAULT 0,
  cliques_whatsapp      INTEGER NOT NULL DEFAULT 0,
  cliques_telefone      INTEGER NOT NULL DEFAULT 0,
  cliques_email         INTEGER NOT NULL DEFAULT 0,

  criado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Área do Técnico — perfil estendido
  foto_path             TEXT,
  telefone              TEXT,
  endereco              TEXT,
  cep                   TEXT,
  instagram             TEXT,
  facebook              TEXT,
  linkedin              TEXT,
  site_pessoal          TEXT,

  -- Configurações
  visivel               INTEGER NOT NULL DEFAULT 1 CHECK (visivel IN (0,1)),
  notif_email           INTEGER NOT NULL DEFAULT 1 CHECK (notif_email IN (0,1)),
  notif_whatsapp        INTEGER NOT NULL DEFAULT 1 CHECK (notif_whatsapp IN (0,1)),

  -- Exclusão de conta (soft-delete)
  excluido              INTEGER NOT NULL DEFAULT 0 CHECK (excluido IN (0,1)),
  excluido_em           TIMESTAMPTZ,

  -- Métricas adicionais
  impressoes_busca      INTEGER NOT NULL DEFAULT 0,
  ultimo_acesso         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tecnicos_uf        ON tecnicos(uf);
CREATE INDEX IF NOT EXISTS idx_tecnicos_status    ON tecnicos(status);
CREATE INDEX IF NOT EXISTS idx_tecnicos_premium   ON tecnicos(premium);
CREATE INDEX IF NOT EXISTS idx_tecnicos_public_id ON tecnicos(public_id);
CREATE INDEX IF NOT EXISTS idx_tecnicos_whatsapp  ON tecnicos(whatsapp);
CREATE INDEX IF NOT EXISTS idx_tecnicos_email     ON tecnicos(email);
-- Impede cadastro duplicado do mesmo profissional. NULL nunca conflita
-- com NULL (padrão SQL), então múltiplos técnicos sem e-mail continuam
-- permitidos — só bloqueia e-mail/CPF repetido entre cadastros.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tecnicos_email_unico    ON tecnicos(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tecnicos_cpf_hash_unico ON tecnicos(cpf_hash);

CREATE TABLE IF NOT EXISTS tecnico_sessoes (
  token       TEXT PRIMARY KEY,
  tecnico_id  BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tecnico_sessoes_tecnico ON tecnico_sessoes(tecnico_id);

-- Histórico básico de login — aba Segurança da Área do Técnico.
CREATE TABLE IF NOT EXISTS tecnico_login_historico (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tecnico_id  BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  sucesso     INTEGER NOT NULL DEFAULT 1 CHECK (sucesso IN (0,1)),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tecnico_login_hist_tecnico ON tecnico_login_historico(tecnico_id, criado_em);

-- Métricas diárias por técnico — evolução mensal real.
CREATE TABLE IF NOT EXISTS tecnico_metricas_diarias (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tecnico_id        BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  data              DATE NOT NULL,
  visualizacoes     INTEGER NOT NULL DEFAULT 0,
  cliques_whatsapp  INTEGER NOT NULL DEFAULT 0,
  cliques_telefone  INTEGER NOT NULL DEFAULT 0,
  impressoes_busca  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tecnico_id, data)
);
CREATE INDEX IF NOT EXISTS idx_tecnico_metricas_tecnico_data ON tecnico_metricas_diarias(tecnico_id, data);

-- ══════════════════════════════════════════════════════════════════
-- FAVORITOS (depende de produtores E tecnicos — só pode vir depois dos dois)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS produtor_favoritos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produtor_id  BIGINT NOT NULL REFERENCES produtores(id) ON DELETE CASCADE,
  tecnico_id   BIGINT NOT NULL REFERENCES tecnicos(id)   ON DELETE CASCADE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(produtor_id, tecnico_id)
);

-- ══════════════════════════════════════════════════════════════════
-- PAGAMENTOS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pagamentos (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pagamento_id_mp      TEXT NOT NULL UNIQUE,
  identificador        TEXT NOT NULL,
  tecnico_id           BIGINT REFERENCES tecnicos(id) ON DELETE SET NULL,
  plano                TEXT NOT NULL CHECK (plano IN ('premium_mensal','classificado_extra')),
  valor                REAL NOT NULL,
  metodo               TEXT NOT NULL DEFAULT 'pix',
  status               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','in_process')),
  desbloqueio_token    TEXT,
  idempotencia_ok      INTEGER NOT NULL DEFAULT 0 CHECK (idempotencia_ok IN (0,1)),
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aprovado_em          TIMESTAMPTZ,
  webhook_recebido_em  TIMESTAMPTZ,
  expira_em            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_ident  ON pagamentos(identificador);
CREATE INDEX IF NOT EXISTS idx_pagamentos_mp_id  ON pagamentos(pagamento_id_mp);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos(status);

-- ══════════════════════════════════════════════════════════════════
-- AVALIAÇÕES
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS avaliacoes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tecnico_id   BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  autor_nome   TEXT NOT NULL,
  texto        TEXT NOT NULL,
  nota         INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  ip_hash      TEXT NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_tecnico ON avaliacoes(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_tecnico_ip_data ON avaliacoes(tecnico_id, ip_hash, criado_em);

-- ══════════════════════════════════════════════════════════════════
-- DENÚNCIAS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS denuncias (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tecnico_id     BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  tecnico_nome   TEXT,
  motivo         TEXT NOT NULL CHECK (motivo IN (
                    'falso_profissional','dados_falsos','profissional_inadequado',
                    'numero_incorreto','golpe_fraude','conteudo_ofensivo','outro'
                  )),
  descricao      TEXT,
  status         TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','arquivada')),
  resolucao      TEXT CHECK (resolucao IS NULL OR resolucao IN ('ignorada','suspenso')),
  resolvido_em   TIMESTAMPTZ,
  resolvido_por  TEXT,
  ip_hash        TEXT NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_denuncias_tecnico ON denuncias(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_denuncias_status   ON denuncias(status);
CREATE INDEX IF NOT EXISTS idx_denuncias_tecnico_motivo_status ON denuncias(tecnico_id, motivo, status);

-- ══════════════════════════════════════════════════════════════════
-- DEMANDAS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS demandas (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produtor_nome     TEXT NOT NULL,
  cultura           TEXT NOT NULL,
  descricao         TEXT NOT NULL,
  cidade            TEXT NOT NULL,
  uf                TEXT CHECK (uf IS NULL OR length(uf) = 2),
  canal             TEXT NOT NULL CHECK (canal IN ('wpp','email','ambos')),
  contato_enc       TEXT NOT NULL,
  contato_iv        TEXT NOT NULL,
  optin_novidades   INTEGER NOT NULL DEFAULT 0 CHECK (optin_novidades IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','encerrada')),
  ip_hash           TEXT NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demandas_status ON demandas(status);
CREATE INDEX IF NOT EXISTS idx_demandas_uf     ON demandas(uf);
CREATE INDEX IF NOT EXISTS idx_demandas_expira ON demandas(expira_em);

CREATE TABLE IF NOT EXISTS demanda_desbloqueios (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  demanda_id  BIGINT NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  tecnico_id  BIGINT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(demanda_id, tecnico_id)
);

-- ══════════════════════════════════════════════════════════════════
-- CLASSIFICADOS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS classificados (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identificador  TEXT NOT NULL,
  empresa        TEXT NOT NULL,
  titulo         TEXT NOT NULL,
  descricao      TEXT NOT NULL,
  wpp            TEXT NOT NULL,
  icone          TEXT NOT NULL DEFAULT '🏪',
  pago           INTEGER NOT NULL DEFAULT 0 CHECK (pago IN (0,1)),
  pagamento_id   TEXT,
  status         TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado')),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em      TIMESTAMPTZ NOT NULL,
  edit_token     TEXT                   -- prova de posse pra edição futura do anúncio, sem exigir login
);
CREATE INDEX IF NOT EXISTS idx_classificados_ident  ON classificados(identificador);
CREATE INDEX IF NOT EXISTS idx_classificados_status ON classificados(status);
-- Garante no banco, de forma atômica, que só existe 1 classificado grátis
-- (pago=0) por identificador — fecha a janela de corrida entre a
-- contagem e a inserção que a aplicação sozinha não consegue fechar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classificados_gratis_unico
  ON classificados(identificador) WHERE pago = 0;

-- ══════════════════════════════════════════════════════════════════
-- CONFIGURAÇÕES
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS configuracoes (
  chave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO configuracoes (chave, valor)
  VALUES ('preco_premium', '49.90')
  ON CONFLICT (chave) DO NOTHING;
INSERT INTO configuracoes (chave, valor)
  VALUES ('preco_classificado', '29.90')
  ON CONFLICT (chave) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- AVISOS GLOBAIS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS avisos (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  texto      TEXT NOT NULL,
  ativo      INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avisos_ativo ON avisos(ativo);

-- ══════════════════════════════════════════════════════════════════
-- SESSÕES ADMIN
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_sessoes (
  token      TEXT PRIMARY KEY,
  ip_hash    TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em  TIMESTAMPTZ NOT NULL
);

-- ══════════════════════════════════════════════════════════════════
-- PEDIDOS DE TÉCNICO
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pedidos_tecnico (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome           TEXT NOT NULL,
  whatsapp       TEXT NOT NULL,
  necessidade    TEXT NOT NULL,
  cidade         TEXT,
  especialidade  TEXT,
  atendido       INTEGER NOT NULL DEFAULT 0 CHECK (atendido IN (0,1)),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_tecnico_atendido ON pedidos_tecnico(atendido);
