-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  AgroTécnico — Schema do Banco de Dados (SQLite / better-sqlite3) ║
-- ║                                                                    ║
-- ║  Este schema é executado automaticamente por db.js na primeira    ║
-- ║  inicialização (db.exec(schema)). Todas as tabelas usam           ║
-- ║  IF NOT EXISTS para permitir reexecução segura.                   ║
-- ║                                                                    ║
-- ║  Convenções:                                                       ║
-- ║   - id INTEGER PRIMARY KEY AUTOINCREMENT como chave interna        ║
-- ║   - public_id TEXT UNIQUE como identificador estável para URLs     ║
-- ║   - Datas em TEXT no formato ISO 8601 (datetime('now'))            ║
-- ║   - Dados sensíveis (IP, CPF) armazenados como hash (ip_hash,      ║
-- ║     cpf_hash), nunca em texto puro                                 ║
-- ║   - Dados de contato de demandas ficam criptografados              ║
-- ║     (contato_enc + contato_iv) — decisão de design de db.js        ║
-- ╚══════════════════════════════════════════════════════════════════╝

PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════════════════════════════════
-- PRODUTORES
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS produtores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nome              TEXT    NOT NULL,
  identificador     TEXT    NOT NULL UNIQUE,   -- e-mail ou whatsapp, sempre minúsculo/trim
  tipo_ident        TEXT    NOT NULL CHECK (tipo_ident IN ('email','tel')),
  senha_hash        TEXT    NOT NULL,
  aceita_novidades  INTEGER NOT NULL DEFAULT 0 CHECK (aceita_novidades IN (0,1)),
  ativo             INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now')),
  atualizado_em     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_produtores_ident ON produtores(identificador);

-- Sessões de produtor logado (cookie HttpOnly agro_prod_sess) — espelha
-- tecnico_sessoes. Adicionada para substituir a sessão "apenas localStorage"
-- do MVP original por autenticação real de servidor.
CREATE TABLE IF NOT EXISTS produtor_sessoes (
  token        TEXT    PRIMARY KEY,
  produtor_id  INTEGER NOT NULL REFERENCES produtores(id) ON DELETE CASCADE,
  ip_hash      TEXT,
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now')),
  expira_em    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_produtor_sessoes_produtor ON produtor_sessoes(produtor_id);

-- ══════════════════════════════════════════════════════════════════
-- TÉCNICOS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tecnicos (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id             TEXT    UNIQUE,          -- ex: tc-beatriz-noronha (slug estável para URLs)
  nome                  TEXT    NOT NULL,
  whatsapp              TEXT    NOT NULL,         -- apenas dígitos, sem máscara
  email                 TEXT,
  cpf_hash              TEXT    NOT NULL,         -- nunca armazenar CPF em texto puro
  senha_hash            TEXT,                     -- null até o primeiro acesso (POST /tecnico/senha)
  upload_token          TEXT,                     -- prova de posse pós-cadastro (documento + 1ª senha)

  cidade                TEXT    NOT NULL,
  uf                    TEXT    NOT NULL CHECK (length(uf) = 2),
  lat                   REAL,
  lng                   REAL,

  formacao              TEXT,
  conselho              TEXT    CHECK (conselho IN ('CREA','CRMV','CFTA')),
  num_conselho          TEXT,
  uf_conselho           TEXT    CHECK (uf_conselho IS NULL OR length(uf_conselho) = 2),
  registro_completo     TEXT,                     -- ex: "CREA-RO 98765" (cache de exibição)

  bio                   TEXT,
  experiencia           TEXT,
  especialidades        TEXT    NOT NULL DEFAULT '[]',  -- array JSON serializado
  servicos              TEXT    NOT NULL DEFAULT '[]',  -- array JSON serializado
  raio_km               INTEGER DEFAULT 100,
  servico               TEXT,                     -- serviço principal + preço de referência (texto livre)

  -- Documento comprobatório
  doc_path              TEXT,                     -- key do objeto no bucket privado R2_BUCKET_DOCUMENTOS
  doc_original_name     TEXT,
  doc_mime              TEXT,
  doc_enviado_em        TEXT,

  -- Validação / status
  status                TEXT    NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente','ativo','suspenso','recusado')),
  ativo                 INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0,1)),
  validado_em            TEXT,
  validado_por           TEXT,
  suspensao_auto        INTEGER NOT NULL DEFAULT 0 CHECK (suspensao_auto IN (0,1)),
  suspensao_data        TEXT,

  -- Premium
  premium                INTEGER NOT NULL DEFAULT 0 CHECK (premium IN (0,1)),
  premium_desde          TEXT,
  premium_expira_em      TEXT,                     -- renovada a cada pagamento aprovado; Premium efetivo = premium=1 AND premium_expira_em > agora
  premium_pagamento_id   TEXT,

  -- Métricas
  media_avaliacoes       REAL    NOT NULL DEFAULT 0,
  total_avaliacoes       INTEGER NOT NULL DEFAULT 0,
  visualizacoes          INTEGER NOT NULL DEFAULT 0,
  cliques_whatsapp       INTEGER NOT NULL DEFAULT 0,
  cliques_telefone       INTEGER NOT NULL DEFAULT 0,
  cliques_email          INTEGER NOT NULL DEFAULT 0,

  criado_em              TEXT    NOT NULL DEFAULT (datetime('now')),
  atualizado_em          TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Área do Técnico — perfil estendido
  foto_path              TEXT,                     -- key do objeto no bucket R2_BUCKET_AVATARS (ver lib/storage-r2.js)
  telefone               TEXT,                     -- telefone fixo/alternativo, distinto do whatsapp
  endereco               TEXT,
  cep                    TEXT,
  instagram              TEXT,
  facebook               TEXT,
  linkedin               TEXT,
  site_pessoal           TEXT,

  -- Configurações
  visivel                INTEGER NOT NULL DEFAULT 1 CHECK (visivel IN (0,1)),   -- liga/desliga exibição pública (distinto de ativo/status, que são controlados pelo admin)
  notif_email            INTEGER NOT NULL DEFAULT 1 CHECK (notif_email IN (0,1)),
  notif_whatsapp         INTEGER NOT NULL DEFAULT 1 CHECK (notif_whatsapp IN (0,1)),

  -- Exclusão de conta (soft-delete — mesma política descrita na Política de Privacidade: remove do ar imediatamente, exclusão definitiva depois)
  excluido               INTEGER NOT NULL DEFAULT 0 CHECK (excluido IN (0,1)),
  excluido_em            TEXT,

  -- Métricas adicionais
  impressoes_busca       INTEGER NOT NULL DEFAULT 0,  -- quantas vezes apareceu em resultados de busca
  ultimo_acesso          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tecnicos_uf        ON tecnicos(uf);
CREATE INDEX IF NOT EXISTS idx_tecnicos_status     ON tecnicos(status);
CREATE INDEX IF NOT EXISTS idx_tecnicos_premium    ON tecnicos(premium);
CREATE INDEX IF NOT EXISTS idx_tecnicos_public_id  ON tecnicos(public_id);
CREATE INDEX IF NOT EXISTS idx_tecnicos_whatsapp   ON tecnicos(whatsapp);
CREATE INDEX IF NOT EXISTS idx_tecnicos_email      ON tecnicos(email);
-- Impede cadastro duplicado do mesmo profissional. NULL nunca conflita
-- com NULL (padrão SQL), então múltiplos técnicos sem e-mail continuam
-- permitidos — só bloqueia e-mail/CPF repetido entre cadastros.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tecnicos_email_unico    ON tecnicos(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tecnicos_cpf_hash_unico ON tecnicos(cpf_hash);

-- Sessões de técnico logado (cookie HttpOnly agro_tec_sess)
CREATE TABLE IF NOT EXISTS tecnico_sessoes (
  token       TEXT    PRIMARY KEY,
  tecnico_id  INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now')),
  expira_em   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tecnico_sessoes_tecnico ON tecnico_sessoes(tecnico_id);

-- Histórico básico de login — usado na aba Segurança da Área do Técnico
-- ("visualizar último acesso" / "registrar histórico básico de login").
CREATE TABLE IF NOT EXISTS tecnico_login_historico (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tecnico_id  INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  sucesso     INTEGER NOT NULL DEFAULT 1 CHECK (sucesso IN (0,1)),
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tecnico_login_hist_tecnico ON tecnico_login_historico(tecnico_id, criado_em);

-- Métricas diárias por técnico — permite calcular "evolução mensal" real
-- a partir de eventos com data, em vez de apenas contadores cumulativos.
CREATE TABLE IF NOT EXISTS tecnico_metricas_diarias (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tecnico_id        INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  data              TEXT    NOT NULL,   -- 'YYYY-MM-DD'
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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  produtor_id  INTEGER NOT NULL REFERENCES produtores(id) ON DELETE CASCADE,
  tecnico_id   INTEGER NOT NULL REFERENCES tecnicos(id)   ON DELETE CASCADE,
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(produtor_id, tecnico_id)
);

-- ══════════════════════════════════════════════════════════════════
-- PAGAMENTOS (Premium + Classificados)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pagamentos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pagamento_id_mp      TEXT    NOT NULL UNIQUE,  -- ID retornado pelo Mercado Pago
  identificador        TEXT    NOT NULL,          -- e-mail/whatsapp do pagador
  tecnico_id           INTEGER REFERENCES tecnicos(id) ON DELETE SET NULL,
  plano                TEXT    NOT NULL CHECK (plano IN ('premium_mensal','classificado_extra')),
  valor                REAL    NOT NULL,
  metodo               TEXT    NOT NULL DEFAULT 'pix',
  status               TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','in_process')),
  desbloqueio_token    TEXT,                      -- prova de posse — usado no mural de demandas
  idempotencia_ok      INTEGER NOT NULL DEFAULT 0 CHECK (idempotencia_ok IN (0,1)),
  criado_em            TEXT    NOT NULL DEFAULT (datetime('now')),
  aprovado_em          TEXT,
  webhook_recebido_em  TEXT,
  expira_em            TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_ident   ON pagamentos(identificador);
CREATE INDEX IF NOT EXISTS idx_pagamentos_mp_id   ON pagamentos(pagamento_id_mp);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status  ON pagamentos(status);

-- ══════════════════════════════════════════════════════════════════
-- AVALIAÇÕES
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS avaliacoes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tecnico_id   INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  autor_nome   TEXT    NOT NULL,
  texto        TEXT    NOT NULL,
  nota         INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  ip_hash      TEXT    NOT NULL,
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_tecnico ON avaliacoes(tecnico_id);
-- Usada para checar "já avaliou hoje" (tecnico_id + ip_hash + data)
CREATE INDEX IF NOT EXISTS idx_avaliacoes_tecnico_ip_data
  ON avaliacoes(tecnico_id, ip_hash, criado_em);

-- ══════════════════════════════════════════════════════════════════
-- DENÚNCIAS
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS denuncias (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tecnico_id     INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  tecnico_nome   TEXT,
  motivo         TEXT    NOT NULL CHECK (motivo IN (
                    'falso_profissional','dados_falsos','profissional_inadequado',
                    'numero_incorreto','golpe_fraude','conteudo_ofensivo','outro'
                  )),
  descricao      TEXT,
  status         TEXT    NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','arquivada')),
  resolucao      TEXT    CHECK (resolucao IS NULL OR resolucao IN ('ignorada','suspenso')),
  resolvido_em   TEXT,
  resolvido_por  TEXT,
  ip_hash        TEXT    NOT NULL,
  criado_em      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_denuncias_tecnico ON denuncias(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_denuncias_status   ON denuncias(status);
-- Usada para checar "já denunciou hoje" e contar falso_profissional pendentes
CREATE INDEX IF NOT EXISTS idx_denuncias_tecnico_motivo_status
  ON denuncias(tecnico_id, motivo, status);

-- ══════════════════════════════════════════════════════════════════
-- DEMANDAS (Mural de Oportunidades)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS demandas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  produtor_nome     TEXT    NOT NULL,
  cultura           TEXT    NOT NULL,
  descricao         TEXT    NOT NULL,
  cidade            TEXT    NOT NULL,
  uf                TEXT    CHECK (uf IS NULL OR length(uf) = 2),
  canal             TEXT    NOT NULL CHECK (canal IN ('wpp','email','ambos')),
  contato_enc       TEXT    NOT NULL,   -- payload de contato criptografado (AES-GCM)
  contato_iv        TEXT    NOT NULL,   -- IV usado na criptografia
  optin_novidades   INTEGER NOT NULL DEFAULT 0 CHECK (optin_novidades IN (0,1)),
  status            TEXT    NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','encerrada')),
  ip_hash           TEXT    NOT NULL,
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now')),
  expira_em         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demandas_status   ON demandas(status);
CREATE INDEX IF NOT EXISTS idx_demandas_uf       ON demandas(uf);
CREATE INDEX IF NOT EXISTS idx_demandas_expira   ON demandas(expira_em);

-- Registro de quais técnicos Premium já desbloquearam o contato de qual demanda
CREATE TABLE IF NOT EXISTS demanda_desbloqueios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  demanda_id  INTEGER NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  tecnico_id  INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  ip_hash     TEXT    NOT NULL,
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(demanda_id, tecnico_id)
);

-- ══════════════════════════════════════════════════════════════════
-- CLASSIFICADOS (Parceiros / Anúncios de Insumos)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS classificados (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identificador  TEXT    NOT NULL,      -- whatsapp limpo do anunciante (chave de contagem)
  empresa        TEXT    NOT NULL,
  titulo         TEXT    NOT NULL,
  descricao      TEXT    NOT NULL,
  wpp            TEXT    NOT NULL,
  icone          TEXT    NOT NULL DEFAULT '🏪',
  pago           INTEGER NOT NULL DEFAULT 0 CHECK (pago IN (0,1)),
  pagamento_id   TEXT,
  status         TEXT    NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado')),
  criado_em      TEXT    NOT NULL DEFAULT (datetime('now')),
  expira_em      TEXT    NOT NULL,
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
-- CONFIGURAÇÕES (chave/valor genérico — preços, flags, etc.)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS configuracoes (
  chave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  atualizado_em  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preços padrão — inseridos apenas se ainda não existirem
INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('preco_premium', '49.90');
INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('preco_classificado', '29.90');

-- ══════════════════════════════════════════════════════════════════
-- AVISOS GLOBAIS (barra no topo do site)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS avisos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  texto      TEXT    NOT NULL,
  ativo      INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avisos_ativo ON avisos(ativo);

-- ══════════════════════════════════════════════════════════════════
-- SESSÕES ADMIN (cookie HttpOnly agro_admin_sess)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_sessoes (
  token      TEXT PRIMARY KEY,
  ip_hash    TEXT,
  criado_em  TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em  TEXT NOT NULL
);

-- ══════════════════════════════════════════════════════════════════
-- PEDIDOS DE TÉCNICO (produtor pede aviso quando houver técnico na região)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pedidos_tecnico (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT    NOT NULL,
  whatsapp       TEXT    NOT NULL,
  necessidade    TEXT    NOT NULL,
  cidade         TEXT,
  especialidade  TEXT,
  atendido       INTEGER NOT NULL DEFAULT 0 CHECK (atendido IN (0,1)),
  criado_em      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pedidos_tecnico_atendido ON pedidos_tecnico(atendido);
