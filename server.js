/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          AgroTécnico — Backend Node.js / Express                ║
 * ║                                                                  ║
 * ║  ROTAS PRINCIPAIS:                                               ║
 * ║    POST /api/v1/pagamentos/criar-pix                             ║
 * ║    POST /api/v1/pagamentos/criar-pix-classificado                ║
 * ║    POST /api/v1/pagamentos/criar-cartao                          ║
 * ║    POST /api/v1/pagamentos/webhook                               ║
 * ║    GET  /api/v1/pagamentos/status/id/:paymentId                  ║
 * ║    GET  /api/v1/pagamentos/status/:identificador                 ║
 * ║    GET  /api/v1/config/precos   (público)                        ║
 * ║    POST /api/v1/config/precos   (admin)                          ║
 * ║                                                                  ║
 * ║  DEPS:  express · dotenv · helmet · cors · express-rate-limit    ║
 * ║         mercadopago · multer · crypto (nativo) · path            ║
 * ║         @aws-sdk/client-s3 (R2 — storage de avatares/documentos) ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * INSTALAÇÃO:
 *   npm install express dotenv helmet cors express-rate-limit mercadopago multer @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * ARQUIVO .env (criar na raiz do projeto):
 *   MP_ACCESS_TOKEN=APP_USR-xxxxxxxxxxxxxxxxxxxx
 *   MP_WEBHOOK_SECRET=seu_secret_do_painel_mp
 *   ADMIN_TOKEN=defina-um-valor-aleatorio-e-secreto-aqui   # opcional — só se quiser o fallback Bearer legado
 *   WEBHOOK_URL=https://seu-ngrok.ngrok.io/api/v1/pagamentos/webhook
 *   PORT=3000
 *   FRONTEND_ORIGIN=http://localhost:5500
 *   NODE_ENV=development
 *
 * USO:
 *   node server.js
 *   # Para testes com webhook local:
 *   ngrok http 3000
 *   # Registrar a URL ngrok no painel MP → Integrações → Webhooks
 */

'use strict';

// ── Dependências ───────────────────────────────────────────────────
require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const multer    = require('multer');
const cookieParser = require('cookie-parser');
const path      = require('path');

const { MercadoPagoConfig, Payment } = require('mercadopago');

// ══════════════════════════════════════════════════════════════════
// CAMADA DE BANCO DE DADOS (db.js) — SUBTÓPICO 4.1
// ─────────────────────────────────────────────────────────────────
// Substitui, rota por rota (subtópicos 4.2 a 4.6), a persistência em
// arquivos JSON (fs.readFile/writeFile) usada até aqui. db.js decide
// sozinho entre SQLite (MVP, sem DATABASE_URL) e Postgres (produção,
// com DATABASE_URL definida) — nenhuma rota precisa saber qual dos
// dois está ativo.
//
// Enquanto as rotas não forem migradas (subtópicos 4.2+), elas
// continuam lendo/escrevendo os arquivos *.json normalmente — a
// presença deste require() não altera nenhum comportamento existente
// por si só, apenas disponibiliza os repositórios para uso incremental.
// ══════════════════════════════════════════════════════════════════
const {
  db,
  hashSensivel,
  Produtores,
  Tecnicos,
  TecnicoSessoes,
  TecnicoLoginHistorico,
  TecnicoMetricas,
  ProdutorSessoes,
  Pagamentos,
  Avaliacoes,
  Denuncias,
  Demandas,
  Classificados,
  Configuracoes,
  Avisos,
  AdminSessoes,
  PedidosTecnico,
} = require('./db');

// Módulo de criptografia dos dados de contato das demandas (AES-256-GCM).
// Usado a partir do subtópico 4.5 — importado aqui para falhar cedo,
// no boot, caso CONTATO_ENC_KEY esteja ausente do .env em produção.
const cripto = require('./lib/cripto-contato');
const storageR2 = require('./lib/storage-r2');

// ══════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE AMBIENTE — endurecida (auditoria 20/07/2026, item 10)
// ─────────────────────────────────────────────────────────────────
// Antes: NODE_ENV tinha fallback silencioso para 'development' via
// destructuring, e ADMIN_SENHA/HASH_SECRET caíam em valores fixos
// conhecidos (Agro@Admin2026 / agro-hash-dev) sem nenhum aviso caso
// as variáveis reais não estivessem definidas. Isso reativava o bypass
// de pagamento por cartão e enfraquecia os cookies de sessão em
// qualquer ambiente que esquecesse de setar NODE_ENV=production —
// silenciosamente, sem erro no boot.
//
// Agora: NODE_ENV é obrigatório e precisa ser um valor reconhecido.
// Em produção, ADMIN_SENHA, HASH_SECRET, FRONTEND_ORIGIN e
// MP_WEBHOOK_SECRET também são obrigatórios — o processo recusa a
// subir em vez de operar com segredos padrão conhecidos publicamente
// (este mesmo arquivo, se vazado ou lido por qualquer pessoa).
// ══════════════════════════════════════════════════════════════════
const NODE_ENV_VALIDOS = ['production', 'development', 'test'];
const NODE_ENV = process.env.NODE_ENV;

if (!NODE_ENV || !NODE_ENV_VALIDOS.includes(NODE_ENV)) {
  console.error(
    `[ERRO FATAL] NODE_ENV ausente ou inválido (valor atual: ${JSON.stringify(NODE_ENV)}). ` +
    `Defina explicitamente NODE_ENV=production ou NODE_ENV=development no ambiente. ` +
    `Um valor ausente nunca deve cair silenciosamente em modo de desenvolvimento.`
  );
  process.exit(1);
}

const IS_PRODUCTION = NODE_ENV === 'production';

// ── Variáveis de ambiente ──────────────────────────────────────────
const {
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PORT          = 3000,
  FRONTEND_ORIGIN,
} = process.env;

if (!MP_ACCESS_TOKEN) {
  console.error('[ERRO FATAL] MP_ACCESS_TOKEN não definido no .env — encerrando.');
  process.exit(1);
}

// Em produção, nunca operar com segredos padrão nem com CORS aberto —
// cada um desses fica documentado no relatório de auditoria como risco
// médio/alto quando ausente silenciosamente. Falhar no boot é preferível
// a subir em um estado inseguro sem qualquer aviso visível.
if (IS_PRODUCTION) {
  const faltando = [];
  if (!process.env.ADMIN_SENHA)  faltando.push('ADMIN_SENHA');
  if (!process.env.HASH_SECRET)  faltando.push('HASH_SECRET');
  if (!FRONTEND_ORIGIN)          faltando.push('FRONTEND_ORIGIN');
  if (!MP_WEBHOOK_SECRET)        faltando.push('MP_WEBHOOK_SECRET');
  // R2 (storage externo de avatares/documentos) — sem essas variáveis,
  // o filesystem efêmero do Render seria usado como fallback silencioso
  // e todo upload seria perdido no próximo deploy. Falhar no boot é
  // preferível a descobrir isso quando um técnico real perder a foto.
  faltando.push(...storageR2.variaveisFaltando());

  if (faltando.length) {
    console.error(
      `[ERRO FATAL] Em produção (NODE_ENV=production) as seguintes variáveis de ambiente ` +
      `são obrigatórias e não foram definidas: ${faltando.join(', ')}. ` +
      `Configure-as no painel do Render (ou equivalente) antes de subir o serviço.`
    );
    process.exit(1);
  }
} else {
  // Fora de produção, os fallbacks de desenvolvimento continuam
  // disponíveis para não travar o ambiente local — mas de forma
  // barulhenta, para que nunca passem despercebidos.
  if (!process.env.ADMIN_SENHA) console.warn('[dev] ADMIN_SENHA não definida — usando senha padrão de desenvolvimento.');
  if (!process.env.HASH_SECRET) console.warn('[dev] HASH_SECRET não definida — usando segredo padrão de desenvolvimento.');
  if (!FRONTEND_ORIGIN)         console.warn('[dev] FRONTEND_ORIGIN não definida — CORS aberto para qualquer origem (apenas dev).');
  if (!MP_WEBHOOK_SECRET)       console.warn('[dev] MP_WEBHOOK_SECRET não definida — assinatura do webhook do Mercado Pago não será validada.');
  if (!storageR2.configurado())  console.warn(`[dev] R2 não configurado (${storageR2.variaveisFaltando().join(', ')}) — uploads de foto/documento vão falhar até configurar o .env local.`);
}

// Confirma no boot qual driver de banco está ativo e que o schema
// rodou sem erros — evita descobrir problema de conexão só quando a
// primeira rota migrada (subtópico 4.2) for chamada em produção.
//
// IMPORTANTE: db.query() é SÍNCRONO no driver SQLite (better-sqlite3),
// mas ASSÍNCRONO no driver Postgres (retorna Promise). Promise.resolve()
// normaliza os dois casos — sem isso, um `db.query(...)` sem await aqui
// faria essa checagem "passar" mesmo com o Postgres inacessível, e o
// erro real só apareceria depois como uma promise rejeitada sem handler
// (crash confuso e atrasado, não uma falha clara no boot).
{
  const driverAtivo = process.env.DATABASE_URL ? 'PostgreSQL (produção)' : 'SQLite (MVP)';
  Promise.resolve(db.query('SELECT 1 as ok'))
    .then(() => {
      console.log(`[db] Conexão validada no boot — driver: ${driverAtivo}`);
    })
    .catch(err => {
      console.error('[ERRO FATAL] Falha ao conectar/inicializar o banco de dados:', err?.message || err);
      process.exit(1);
    });
}

// CONTATO_ENC_KEY é exigida apenas a partir do subtópico 4.5 (demandas),
// mas validamos no boot para nunca descobrir a ausência dela em produção
// no meio de uma publicação de demanda real.
try {
  cripto.verificarConfiguracao();
  console.log('[cripto-contato] CONTATO_ENC_KEY validada no boot.');
} catch (err) {
  console.error(`[ERRO FATAL] ${err.message}`);
  process.exit(1);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// ══════════════════════════════════════════════════════════════
// SESSÕES ADMIN — SUBTÓPICO 4.6
// ─────────────────────────────────────────────────────────────
// O Map() em memória saiu de uso — AdminSessoes (db.js) persiste as
// sessões na tabela `admin_sessoes`, sobrevivendo a reinícios do
// processo. TTL mantido em 12h (era o valor já usado aqui; o padrão
// do repositório é 8h, mas AdminSessoes.criar() aceita um ttlMs
// explícito para não mudar esse comportamento silenciosamente).
// ══════════════════════════════════════════════════════════════
const ADMIN_SESS_TTL = 12 * 60 * 60 * 1000; // 12 horas em ms

// Credenciais do admin — NUNCA no frontend
const ADMIN_EMAIL_BACK = process.env.ADMIN_EMAIL || 'admin@agrotecnico.com.br';
const ADMIN_SENHA_HASH = crypto
  .createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev')
  .update(process.env.ADMIN_SENHA || 'Agro@Admin2026')
  .digest('hex');

/**
 * Gera hash da senha para comparação.
 */
function hashSenha(senha) {
  return crypto
    .createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev')
    .update(senha)
    .digest('hex');
}

/**
 * Middleware requireAdmin — substitui `if (auth !== Bearer ADMIN_TOKEN)`.
 * Valida cookie de sessão HttpOnly gerado pelo /api/admin/login contra
 * a tabela admin_sessoes. Mantém compatibilidade com Bearer token para
 * transição suave (ex.: scripts internos que ainda usam ADMIN_TOKEN).
 */
async function requireAdmin(req, res, next) {
  // 1. Tenta cookie HttpOnly (sistema principal)
  const cookieToken = req.cookies?.agro_admin_sess;
  if (cookieToken && await AdminSessoes.validar(cookieToken)) {
    return next();
  }

  // 2. Fallback Bearer token — só ativo se ADMIN_TOKEN estiver definido no
  //    .env (sem valor hardcoded). Desativar explicitamente com ADMIN_LEGACY_BEARER=false.
  if (ADMIN_TOKEN && process.env.ADMIN_LEGACY_BEARER !== 'false') {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader === `Bearer ${ADMIN_TOKEN}`) {
      console.warn(`[requireAdmin] Acesso via Bearer legacy — IP: ${req.ip}`);
      return next();
    }
  }

  return res.status(401).json({ erro: 'Não autorizado. Faça login em /api/admin/login.' });
}

// Nota: a limpeza de sessões expiradas não precisa mais de um
// setInterval em memória — a cláusula `expira_em > datetime('now')`
// em AdminSessoes.validar() já ignora sessões vencidas em toda
// consulta. Linhas expiradas ficam na tabela até serem sobrescritas
// (custo desprezível); se necessário, um job de limpeza periódica
// pode rodar `DELETE FROM admin_sessoes WHERE expira_em <= datetime('now')`.

// ══════════════════════════════════════════════════════════════
// SESSÕES TÉCNICO — SUBTÓPICO 4.2
// ─────────────────────────────────────────────────────────────
// Antes: Map() em memória (perdia todas as sessões a cada restart/
// deploy). Agora: persistidas na tabela tecnico_sessoes (schema.sql),
// via repositório TecnicoSessoes (db.js) — sobrevivem a reinícios do
// processo e funcionam com múltiplas instâncias atrás de um load
// balancer, algo que o Map() nunca suportaria.
// ══════════════════════════════════════════════════════════════
const TECNICO_SESS_TTL = 8 * 60 * 60 * 1000; // 8 horas em ms — mantido em sincronia com TecnicoSessoes.criar()

/**
 * Middleware requireTecnico — valida cookie de sessão HttpOnly
 * gerado pelo POST /api/v1/tecnico/login contra o banco de dados.
 * Injeta req.tecnicoSessao = { tecnicoId }.
 */
async function requireTecnico(req, res, next) {
  const cookieToken = req.cookies?.agro_tec_sess;
  if (cookieToken) {
    const sessao = await TecnicoSessoes.validar(cookieToken);
    if (sessao) {
      req.tecnicoSessao = sessao;
      return next();
    }
  }
  return res.status(401).json({ erro: 'Não autorizado. Faça login em /api/v1/tecnico/login.' });
}

// ══════════════════════════════════════════════════════════════
// SESSÕES PRODUTOR — integração backend real (substitui localStorage)
// ─────────────────────────────────────────────────────────────
// Espelha a sessão de técnico acima. Antes desta integração, o login/
// cadastro de produtor era 100% localStorage no navegador — nenhum
// dado sobrevivia à troca de aparelho/navegador, e o admin nunca via
// a base real de produtores (auditoria, Achado #1).
// ══════════════════════════════════════════════════════════════
const PRODUTOR_SESS_TTL = 8 * 60 * 60 * 1000; // 8 horas em ms — mantido em sincronia com ProdutorSessoes.criar()

/**
 * Middleware requireProdutor — valida cookie de sessão HttpOnly
 * gerado por POST /api/v1/produtor/login contra o banco de dados.
 * Injeta req.produtorSessao = { produtorId }.
 */
async function requireProdutor(req, res, next) {
  const cookieToken = req.cookies?.agro_prod_sess;
  if (cookieToken) {
    const sessao = await ProdutorSessoes.validar(cookieToken);
    if (sessao) {
      req.produtorSessao = sessao;
      return next();
    }
  }
  return res.status(401).json({ erro: 'Não autorizado. Faça login em /api/v1/produtor/login.' });
}

// ── SDK Mercado Pago ──────────────────────────────────────────────
const mpClient = new MercadoPagoConfig({
  accessToken: MP_ACCESS_TOKEN,
  options: { timeout: 10_000 },
});
const paymentApi = new Payment(mpClient);

// ── Arquivos de persistência (MVP — JSON) ─────────────────────────
// SUBTÓPICO 4.3: PREMIUMS_FILE e PRECOS_CFG_FILE saem de uso — os
// dados agora vivem nas tabelas `pagamentos`/`tecnicos` (Pagamentos,
// Tecnicos) e `configuracoes` (Configuracoes) do db.js. As constantes
// permanecem declaradas apenas para não quebrar nenhum require()
// residual, mas nada mais lê/escreve nelas a partir daqui.
const PREMIUMS_FILE   = path.join(__dirname, 'premiums.json');   // não usado mais — ver Pagamentos (db.js)
const PRECOS_CFG_FILE = path.join(__dirname, 'precos.json');     // não usado mais — ver Configuracoes (db.js)
const TECNICOS_FILE   = path.join(__dirname, 'tecnicos.json');
const DENUNCIAS_FILE  = path.join(__dirname, 'denuncias.json');
const AVALIACOES_FILE = path.join(__dirname, 'avaliacoes.json');
const DEMANDAS_FILE   = path.join(__dirname, 'demandas.json');
const AVISO_FILE      = path.join(__dirname, 'aviso.json');

// ══════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO CENTRALIZADA DE PREÇOS — SUBTÓPICO 4.3
// ─────────────────────────────────────────────────────────────────
// precosCfgLer()/precosCfgSalvar() são mantidas com a mesma assinatura
// (async, mesmos parâmetros de retorno) usada por ~10 call-sites
// espalhados pelo arquivo (webhook, criar-pix, criar-cartao,
// classificado…) — só o corpo delega para Configuracoes (db.js) em vez
// de ler/escrever precos.json. Isso evita ter que caçar e alterar cada
// call-site individualmente, com o mesmo risco de esquecer um deles.
// ══════════════════════════════════════════════════════════════════

const PRECOS_PADRAO = { premium: 49.90, classificado: 29.90 };

/**
 * @returns {Promise<{ premium: number, classificado: number }>}
 */
async function precosCfgLer() {
  try {
    return await Configuracoes.precos();
  } catch (err) {
    console.error('[precosCfgLer] Falha ao ler do banco, usando padrão:', err?.message);
    return { ...PRECOS_PADRAO };
  }
}

/**
 * Persiste os preços na tabela `configuracoes`.
 */
async function precosCfgSalvar(premium, classificado) {
  await Configuracoes.definirPrecos(premium, classificado);
}

// ══════════════════════════════════════════════════════════════════
// MULTER — Upload de documentos dos técnicos
// ══════════════════════════════════════════════════════════════════

// Armazenamento em memória — o buffer vai direto pro R2 (uploadArquivo),
// nunca é escrito no disco do Render. Substituiu o multer.diskStorage
// original, que gravava em uploads/ (filesystem efêmero — some a cada
// redeploy). Ver lib/storage-r2.js e a auditoria de storage externo.
const uploadStorage = multer.memoryStorage();

const uploadFilter = (req, file, cb) => {
  // Verifica mimetype declarado pelo cliente (primeira camada)
  const mimePermitidos = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
  if (!mimePermitidos.includes(file.mimetype)) {
    return cb(new Error('Tipo de arquivo não permitido. Use PDF, JPG ou PNG.'), false);
  }
  // Verifica extensão real do arquivo (segunda camada)
  const extPermitidas = ['.pdf', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!extPermitidas.includes(ext)) {
    return cb(new Error('Extensão de arquivo não permitida.'), false);
  }
  cb(null, true);
};

// ── Magic bytes — assinaturas binárias dos formatos permitidos ────
// Terceira camada de validação: lê os primeiros bytes do arquivo
// já salvo em disco e rejeita qualquer conteúdo que não corresponda
// ao tipo real esperado, independentemente do nome ou MIME declarado.
//
// Referências:
//   JPEG → FF D8 FF                    (primeiros 3 bytes)
//   PNG  → 89 50 4E 47 0D 0A 1A 0A    (primeiros 8 bytes)
//   PDF  → 25 50 44 46                 (%PDF, primeiros 4 bytes)
//
// Implementado com fs nativo (sem dependência externa) para manter
// compatibilidade com o projeto CommonJS ('use strict').
// Nota: validação de magic bytes substituiu o comentário original que
// apontava 'file-type' como solução futura — não é mais necessário.
// ─────────────────────────────────────────────────────────────────
const MAGIC_BYTES = [
  {
    mime:   ['image/jpeg', 'image/jpg'],
    ext:    ['.jpg', '.jpeg'],
    bytes:  Buffer.from([0xFF, 0xD8, 0xFF]),
    length: 3,
    label:  'JPEG',
  },
  {
    mime:   ['image/png'],
    ext:    ['.png'],
    bytes:  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    length: 8,
    label:  'PNG',
  },
  {
    mime:   ['application/pdf'],
    ext:    ['.pdf'],
    bytes:  Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
    length: 4,
    label:  'PDF',
  },
];

/**
 * Valida o conteúdo real de um arquivo por seus magic bytes, lendo
 * direto do buffer em memória (multer.memoryStorage) — não há mais
 * arquivo em disco nesse ponto, já que o upload vai direto pro R2.
 *
 * @param {Buffer} buffer       - Conteúdo do arquivo em memória (req.file.buffer)
 * @param {string} declaredMime - MIME declarado pelo cliente (ex: 'image/jpeg')
 * @param {string} declaredExt  - Extensão extraída do nome original (ex: '.jpg')
 * @returns {Promise<{ valido: boolean, motivo?: string }>}
 */
async function validarMagicBytes(buffer, declaredMime, declaredExt) {
  // Localiza a assinatura esperada com base no MIME e extensão declarados
  const assinatura = MAGIC_BYTES.find(
    a => a.mime.includes(declaredMime) && a.ext.includes(declaredExt)
  );

  // MIME/extensão declarados não têm assinatura mapeada — rejeita por precaução
  if (!assinatura) {
    return { valido: false, motivo: 'Tipo de arquivo não reconhecido.' };
  }

  if (!buffer || buffer.length < assinatura.length) {
    return { valido: false, motivo: 'Arquivo vazio ou incompleto.' };
  }

  const match = buffer.slice(0, assinatura.length).equals(assinatura.bytes);
  if (!match) {
    return {
      valido: false,
      motivo: `Conteúdo do arquivo não corresponde ao tipo ${assinatura.label}.`,
    };
  }

  return { valido: true };
}

const upload = multer({
  storage:    uploadStorage,
  fileFilter: uploadFilter,
  limits:     { fileSize: 5 * 1024 * 1024 }, // máx. 5 MB
});

// ── Upload de FOTO DE PERFIL — bucket próprio no R2, público ────────
// Importante: nunca reaproveitar o bucket de documentos comprobatórios
// (R2_BUCKET_DOCUMENTOS), que é deliberadamente privado (pode conter
// dados pessoais sensíveis do técnico). Avatares vivem em
// R2_BUCKET_AVATARS — o único bucket com acesso público — ver
// lib/storage-r2.js. A key final é gerada na própria rota (precisa do
// buffer completo e do id do técnico, disponíveis só ali).
const avatarStorage = multer.memoryStorage();

const avatarFilter = (req, file, cb) => {
  const mimePermitidos = ['image/jpeg', 'image/png', 'image/jpg'];
  if (!mimePermitidos.includes(file.mimetype)) {
    return cb(new Error('Use apenas JPG ou PNG para a foto de perfil.'), false);
  }
  const extPermitidas = ['.jpg', '.jpeg', '.png'];
  if (!extPermitidas.includes(path.extname(file.originalname).toLowerCase())) {
    return cb(new Error('Extensão de arquivo não permitida.'), false);
  }
  cb(null, true);
};

const uploadAvatar = multer({
  storage:    avatarStorage,
  fileFilter: avatarFilter,
  limits:     { fileSize: 2 * 1024 * 1024 }, // máx. 2 MB — foto de perfil, não documento
});

// ── App Express ───────────────────────────────────────────────────
const app = express();

// Render (e a maioria dos PaaS) coloca o app atrás de um proxy reverso
// que repassa o IP real do usuário via X-Forwarded-For. Sem isso,
// req.ip SEMPRE retorna o IP interno do proxy — quebrando o rate
// limiting e as proteções "1x por dia por IP" (avaliação, denúncia),
// já que todo mundo apareceria como o mesmo IP. `1` = confia em
// exatamente 1 hop de proxy à frente, que é o que o Render usa.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'", "https://api.mercadopago.com", "https://sdk.mercadopago.com"],
      "frame-src": ["'self'", "https://www.mercadopago.com", "https://www.mercadopago.com.br"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
    },
  },
}));
// Servir /public estaticamente (JS extraído fica em public/js/*.js).
// express.static respeita a CSP acima; nada aqui enfraquece a política.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); },
}));
// Fotos de perfil e documentos não são mais servidos por este processo —
// ambos vivem no R2 (avatares em bucket público, documentos em bucket
// privado). Ver lib/storage-r2.js. O servidor Node nunca mais grava
// nem serve arquivo de upload nenhum a partir do seu próprio disco.
app.use(cookieParser()); // necessário para ler req.cookies.agro_admin_sess

app.use(cors({
  origin:         FRONTEND_ORIGIN || '*',
  // PUT é usado pelas 7 rotas de edição de perfil da Área do Técnico
  // (/me/perfil, /me/especialidades, /me/servicos, /me/contato, /me/email,
  // /me/senha, /me/configuracoes) — faltava aqui, o que quebraria essas
  // rotas com erro de CORS em qualquer cenário onde frontend e backend
  // não estejam no mesmo domínio (mesmo funcionando hoje, quando ambos
  // são servidos pelo mesmo processo Express).
  methods:        ['GET', 'POST', 'PUT', 'DELETE'],
  // X-Upload-Token é enviado pelo frontend (inline-03.js) no upload de
  // documento do cadastro — sem isso na allow-list, o preflight bloqueia
  // a requisição antes mesmo do fallback via body ser alcançado.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'X-Request-Id', 'X-Upload-Token'],
}));

// Body raw para webhook (HMAC precisa do body intacto)
app.use('/api/v1/pagamentos/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '64kb' }));

// Rate limiting global
const limiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { erro: 'Muitas requisições. Tente novamente em alguns minutos.' },
});
app.use('/api/', limiter);

// Rate limiters individuais por rota sensível
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,   // 5 tentativas por 15 min por IP
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const limiterPix = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,   // 5 Pix por 15 min por IP
  message: { erro: 'Limite de geração de Pix atingido. Aguarde 15 minutos.' },
});
const limiterDen = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,  // 10 denúncias por hora por IP
  message: { erro: 'Limite de denúncias atingido. Aguarde 1 hora.' },
});
const limiterCad = rateLimit({
  windowMs: 60 * 60 * 1000, max: 3,   // 3 cadastros por hora por IP
  message: { erro: 'Limite de cadastros atingido. Aguarde 1 hora.' },
});
const limiterAval = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,  // 10 avaliações por hora por IP
  message: { erro: 'Limite de avaliações atingido. Aguarde 1 hora.' },
});
const limiterEditarClassificado = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,  // 20 edições por hora por IP — generoso o bastante pro dono ajustar o próprio anúncio várias vezes, ainda limita tentativa de adivinhar editToken por força bruta
  message: { erro: 'Limite de edições atingido. Aguarde 1 hora.' },
});
// Auditoria 20/07/2026, item 10, risco #6: /api/v1/tecnicos/validar-conselho
// não tinha nenhum rate limit dedicado, permitindo tentativas automatizadas
// de CPFs contra o mock de KYC (e, futuramente, contra a API real do conselho).
const limiterKyc = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,  // 10 consultas de conselho por 15 min por IP
  message: { erro: 'Muitas consultas de validação de conselho. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ══════════════════════════════════════════════════════════════════
// HELPERS DE PERSISTÊNCIA
// ══════════════════════════════════════════════════════════════════

/**
 * Mesma assinatura de sempre — (identificador, pagamentoId, tecnicoIdParam)
 * — para não exigir alteração nos ~5 call-sites (webhook, criar-cartao).
 * Por dentro, delega para Pagamentos.aprovar() + Tecnicos.ativarPremiumPorId(),
 * que cuidam de: manter o mesmo desbloqueio_token entre renovações, e
 * gravar tudo em transação por linha (SQLite) em vez de reescrever um
 * arquivo JSON inteiro a cada ativação.
 */
async function registrarPremiumMVP(identificador, pagamentoId, tecnicoIdParam = null) {
  // Resolve tecnicoId: prioridade para o parâmetro (metadata do pagamento,
  // a fonte de verdade); fallback para o técnico já vinculado ao registro
  // pendente criado em criar-pix/criar-cartao; último fallback: busca por
  // e-mail/whatsapp — cobre registros legados sem tecnicoId.
  const registroExistente = await Pagamentos.buscarPorMpId(pagamentoId);
  let tecnicoId = tecnicoIdParam || registroExistente?.tecnico_id || null;
  if (!tecnicoId) {
    const tec = await Tecnicos.buscarPorIdentificador(identificador);
    if (tec) tecnicoId = tec.id;
  }

  // Garante que exista uma linha de pagamento para aprovar (idempotente
  // via INSERT OR IGNORE) — cobre o caso raro do webhook chegar antes de
  // criarPendente ter sido chamado (ex.: retry do Mercado Pago).
  if (!registroExistente) {
    const precoAtual = await precosCfgLer();
    await Pagamentos.criarPendente({
      pagamentoIdMp: pagamentoId,
      identificador,
      tecnicoId,
      plano: 'premium_mensal',
      valor: precoAtual.premium,
    });
  }

  const { desbloqueioToken } = await Pagamentos.aprovar(pagamentoId, { tecnicoId });

  if (tecnicoId) {
    await Tecnicos.ativarPremiumPorId(tecnicoId, pagamentoId);
  } else {
    // Sem vínculo de técnico conhecido — mantém o fallback legado por
    // e-mail/whatsapp para o pagamento não ficar aprovado sem efeito.
    await Tecnicos.ativarPremium(identificador, pagamentoId);
  }

  // Auditoria 20/07/2026, item 5: o desbloqueioToken é um token sensível
  // de acesso a contato — não deve aparecer em texto puro nos logs.
  // Mantemos apenas os primeiros 8 caracteres para correlação em
  // depuração, sem expor o valor utilizável.
  const tokenMascarado = desbloqueioToken ? `${desbloqueioToken.slice(0, 8)}…` : null;
  console.log(`[MVP] Premium registrado → ${identificador} | tecnicoId: ${tecnicoId} | paymentId: ${pagamentoId} | desbloqueioToken: ${tokenMascarado}`);
}

async function verificarSePagamentoJaFoiAtivado(paymentId) {
  return await Pagamentos.jaAtivado(paymentId);
}

/**
 * Consulta o Mercado Pago e confirma que um pagamento foi de fato
 * aprovado, com o método esperado — mesmo mecanismo (paymentApi.get)
 * já usado no webhook e na rota de cartão. Usada por qualquer rota
 * que precise liberar um benefício mediante apresentação de um
 * pagamentoId, para nunca confiar nesse ID sem checagem real.
 *
 * @param {string} pagamentoId
 * @param {string} metodoEsperado - ex: 'pix'
 * @returns {Promise<{ok:true, pagamento:object} | {ok:false, motivo:string}>}
 */
async function verificarPagamentoAprovadoMP(pagamentoId, metodoEsperado = 'pix') {
  if (!pagamentoId) return { ok: false, motivo: 'pagamentoId ausente.' };

  let pagamento;
  try {
    pagamento = await paymentApi.get({ id: pagamentoId });
  } catch (err) {
    console.warn(`[verificarPagamentoAprovadoMP] Pagamento não encontrado no MP: ${pagamentoId} — ${err?.message}`);
    return { ok: false, motivo: 'Pagamento não encontrado.' };
  }

  if (pagamento.status !== 'approved') {
    return { ok: false, motivo: `Pagamento com status "${pagamento.status}", não aprovado.` };
  }

  if (pagamento.payment_method_id !== metodoEsperado) {
    return { ok: false, motivo: `Método de pagamento "${pagamento.payment_method_id}" não corresponde ao esperado.` };
  }

  return { ok: true, pagamento };
}

// ══════════════════════════════════════════════════════════════════
// ROTA — GET /api/v1/config/precos (público)
// ROTA — POST /api/v1/config/precos (admin)
// ══════════════════════════════════════════════════════════════════

app.get('/api/v1/config/precos', async (req, res) => {
  try {
    const p = await precosCfgLer();
    res.json({
      premium:          p.premium,
      classificado:     p.classificado,
      premium_fmt:      `R$ ${p.premium.toFixed(2).replace('.', ',')}`,
      classificado_fmt: `R$ ${p.classificado.toFixed(2).replace('.', ',')}`,
    });
  } catch {
    res.json({ ...PRECOS_PADRAO });
  }
});

app.post('/api/v1/config/precos', requireAdmin, async (req, res) => {

  const premium      = parseFloat(req.body?.premium);
  const classificado = parseFloat(req.body?.classificado);

  if (!premium || premium < 1 || premium > 999) {
    return res.status(400).json({ erro: 'Valor Premium inválido (R$ 1,00 a R$ 999,00).' });
  }
  if (!classificado || classificado < 1 || classificado > 999) {
    return res.status(400).json({ erro: 'Valor Classificado inválido (R$ 1,00 a R$ 999,00).' });
  }

  await precosCfgSalvar(premium, classificado);
  console.log(`[config/precos] Premium: R$ ${premium.toFixed(2)} | Classificado: R$ ${classificado.toFixed(2)}`);

  res.json({
    ok:               true,
    premium,
    classificado,
    premium_fmt:      `R$ ${premium.toFixed(2).replace('.', ',')}`,
    classificado_fmt: `R$ ${classificado.toFixed(2).replace('.', ',')}`,
  });
});

// ══════════════════════════════════════════════════════════════════
// ROTA — POST /api/v1/pagamentos/criar-pix  (Técnicos Premium)
// Valor lido dinamicamente de precosCfgLer().premium
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/pagamentos/criar-pix', limiterPix, async (req, res) => {
  try {
    const { nome, identificador, descricao, tecnicoId } = req.body;

    if (!nome || typeof nome !== 'string' || nome.trim().length < 2) {
      return res.status(400).json({ erro: 'Campo "nome" inválido.' });
    }
    if (!identificador || typeof identificador !== 'string') {
      return res.status(400).json({ erro: 'Campo "identificador" inválido.' });
    }

    // ── Valor dinâmico — nunca hardcoded ─────────────────────────
    const { premium: VALOR } = await precosCfgLer();

    const isEmail    = identificador.includes('@');
    const payerEmail = isEmail ? identificador : 'pagador@agrotecnico.com.br';

    const pagamento = await paymentApi.create({
      body: {
        transaction_amount: VALOR,
        description:        descricao || 'AgroTécnico Premium — Destaque mensal',
        payment_method_id:  'pix',
        payer: {
          email:      payerEmail,
          first_name: nome.trim().split(' ')[0],
          last_name:  nome.trim().split(' ').slice(1).join(' ') || 'Técnico',
        },
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        metadata: {
          agrotecnico_identificador: identificador,
          agrotecnico_plano:         'premium_mensal',
          agrotecnico_tecnico_id:    tecnicoId || null, // fonte de verdade do vínculo
        },
        notification_url: process.env.WEBHOOK_URL || undefined,
      },
    });

    const qr = pagamento.point_of_interaction?.transaction_data;
    console.log(`[criar-pix] id: ${pagamento.id} | valor: R$ ${VALOR} | ident: ${identificador}`);

    // Persiste como pendente assim que o Pix é gerado — antes mesmo da
    // aprovação. Dá ao webhook uma linha já existente para atualizar
    // (em vez de criar do zero) e permite consultar status mesmo antes
    // do pagamento ser confirmado.
    await Pagamentos.criarPendente({
      pagamentoIdMp: pagamento.id,
      identificador,
      tecnicoId: tecnicoId || null,
      plano: 'premium_mensal',
      valor: VALOR,
    });

    res.json({
      pagamento_id:   pagamento.id,
      status:         pagamento.status,
      qr_code:        qr?.qr_code        || null,
      qr_code_base64: qr?.qr_code_base64 || null,
      ticket_url:     qr?.ticket_url     || null,
      valor:          VALOR,
      expiracao:      pagamento.date_of_expiration,
    });

  } catch (err) {
    console.error('[criar-pix] Erro:', err?.message || err);
    res.status(err?.status || 500).json({
      erro:    'Falha ao gerar o Pix. Tente novamente.',
      detalhe: NODE_ENV === 'development' ? err?.message : undefined,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// ROTA — POST /api/v1/pagamentos/criar-pix-classificado  (Parceiros)
// Valor lido dinamicamente de precosCfgLer().classificado
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/pagamentos/criar-pix-classificado', limiterPix, async (req, res) => {
  try {
    const { nome, identificador, descricao } = req.body;

    if (!identificador || typeof identificador !== 'string') {
      return res.status(400).json({ erro: 'Identificador obrigatório.' });
    }

    // ── Valor dinâmico — nunca hardcoded ─────────────────────────
    const { classificado: VALOR } = await precosCfgLer();

    const isEmail    = identificador.includes('@');
    const payerEmail = isEmail ? identificador : 'parceiro@agrotecnico.com.br';

    const pagamento = await paymentApi.create({
      body: {
        transaction_amount: VALOR,
        description:        descricao || 'AgroTécnico — Anúncio de Classificado',
        payment_method_id:  'pix',
        payer: {
          email:      payerEmail,
          first_name: (nome || 'Parceiro').split(' ')[0],
          last_name:  (nome || '').split(' ').slice(1).join(' ') || 'AgroTécnico',
        },
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        metadata: {
          agrotecnico_identificador: identificador,
          agrotecnico_plano:         'classificado_extra',
        },
        notification_url: process.env.WEBHOOK_URL || undefined,
      },
    });

    const qr = pagamento.point_of_interaction?.transaction_data;
    console.log(`[classificado] id: ${pagamento.id} | valor: R$ ${VALOR} | ident: ${identificador}`);

    await Pagamentos.criarPendente({
      pagamentoIdMp: pagamento.id,
      identificador,
      tecnicoId: null, // classificados não têm vínculo com tecnicos.id
      plano: 'classificado_extra',
      valor: VALOR,
    });

    res.json({
      pagamento_id:   pagamento.id,
      status:         pagamento.status,
      valor:          VALOR,
      qr_code:        qr?.qr_code        || null,
      qr_code_base64: qr?.qr_code_base64 || null,
      ticket_url:     qr?.ticket_url     || null,
      expiracao:      pagamento.date_of_expiration,
    });

  } catch (err) {
    console.error('[classificado] Erro ao gerar Pix:', err?.message || err);
    res.status(500).json({
      erro:    'Falha ao gerar o Pix do anúncio.',
      detalhe: NODE_ENV === 'development' ? err?.message : undefined,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// ROTA — POST /api/v1/pagamentos/webhook
//
// Recebe notificações do Mercado Pago com 4 travas de segurança:
//   Trava A — status === 'approved'
//   Trava B — transaction_amount === precosCfgLer().premium  ← DINÂMICO
//   Trava C — payment_method_id === 'pix'
//   Trava D — metadata.agrotecnico_identificador presente
//
// REGRA DE OURO: responde 200 imediatamente; processa de forma assíncrona.
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/pagamentos/webhook', async (req, res) => {

  // Resposta imediata — MP não tolera timeout na fila de notificações
  res.status(200).send('OK');

  try {
    // ── 1. Validação HMAC-SHA256 ──────────────────────────────────
    if (MP_WEBHOOK_SECRET) {
      const xSignature  = req.headers['x-signature']  || '';
      const xRequestId  = req.headers['x-request-id'] || '';
      const queryDataId = req.query?.['data.id']       || '';
      const ts = xSignature.split(',').find(p => p.startsWith('ts='))?.replace('ts=', '') || '';
      const manifesto   = `id:${queryDataId};request-id:${xRequestId};ts:${ts}`;
      const hashRecebido = xSignature.split(',').find(p => p.startsWith('v1='))?.replace('v1=', '');

      if (hashRecebido) {
        const hashCalculado = crypto
          .createHmac('sha256', MP_WEBHOOK_SECRET)
          .update(manifesto)
          .digest('hex');
        try {
          if (!crypto.timingSafeEqual(
            Buffer.from(hashCalculado, 'hex'),
            Buffer.from(hashRecebido,  'hex')
          )) {
            console.warn('[webhook] ⚠ Assinatura HMAC inválida — ignorada');
            return;
          }
        } catch {
          console.warn('[webhook] ⚠ Erro na comparação de assinatura — ignorada');
          return;
        }
      }
    }

    // ── 2. Parse e filtragem do evento ────────────────────────────
    let evento = {};
    try {
      evento = JSON.parse(req.body.toString());
    } catch {
      console.warn('[webhook] Body não é JSON válido — ignorado');
      return;
    }

    const tipoEvento = evento.action || evento.type || req.query.type || '';
    if (!tipoEvento.includes('payment')) {
      console.log(`[webhook] Tipo ignorado: "${tipoEvento}"`);
      return;
    }

    const paymentId = evento.data?.id || evento.id || req.query['data.id'] || null;
    if (!paymentId) {
      console.log('[webhook] Ping de teste sem paymentId — ignorado');
      return;
    }

    console.log(`[webhook] Evento: "${tipoEvento}" | paymentId: ${paymentId}`);

    // ── 3. Consulta obrigatória à API do MP (anti-fraude) ─────────
    const pagamento = await paymentApi.get({ id: paymentId });
    console.log(`[webhook] MP retornou — status: ${pagamento.status} | valor: ${pagamento.transaction_amount} | método: ${pagamento.payment_method_id}`);

    // ── TRAVA A: STATUS ──────────────────────────────────────────
    if (pagamento.status !== 'approved') {
      console.log(`[webhook] Trava A: status "${pagamento.status}" ≠ "approved" — ignorado`);
      return;
    }

    // ── TRAVA B: VALOR DINÂMICO ──────────────────────────────────
    // Aceita premium OU classificado — lê ambos do arquivo de configuração
    const precos         = await precosCfgLer();
    const valorRecebido  = Number(pagamento.transaction_amount);
    const planoMetadata  = pagamento.metadata?.agrotecnico_plano || '';
    const valorEsperado  = planoMetadata === 'classificado_extra'
      ? precos.classificado
      : precos.premium;

    if (Math.abs(valorRecebido - valorEsperado) > 0.001) {
      console.error(
        `[webhook] 🚨 FRAUDE — Trava B: esperado R$ ${valorEsperado} | recebido R$ ${valorRecebido} | plano: ${planoMetadata} | paymentId: ${paymentId}`
      );
      return;
    }

    // ── TRAVA C: MÉTODO DE PAGAMENTO ─────────────────────────────
    if (pagamento.payment_method_id !== 'pix') {
      console.error(`[webhook] 🚨 FRAUDE — Trava C: método "${pagamento.payment_method_id}" ≠ "pix" | paymentId: ${paymentId}`);
      return;
    }

    // ── TRAVA D: METADATA ─────────────────────────────────────────
    const identificador = pagamento.metadata?.agrotecnico_identificador;
    if (!identificador) {
      console.error(`[webhook] 🚨 Trava D: metadata.agrotecnico_identificador ausente | paymentId: ${paymentId}`);
      return;
    }

    // ── 4. Idempotência ───────────────────────────────────────────
    const jaAtivado = await verificarSePagamentoJaFoiAtivado(paymentId);
    if (jaAtivado) {
      console.log(`[webhook] Idempotência: paymentId ${paymentId} já processado — ignorado`);
      return;
    }

    // ── 5. Todas as travas OK — registra Premium ──────────────────
    console.log(`[webhook] ✅ APROVADO — ident: ${identificador} | plano: ${planoMetadata} | paymentId: ${paymentId}`);
    const tecnicoIdMeta = pagamento.metadata?.agrotecnico_tecnico_id || null;
    await registrarPremiumMVP(identificador, paymentId, tecnicoIdMeta);

  } catch (err) {
    console.error('[webhook] Erro interno:', err?.message || err);
  }
});

// ══════════════════════════════════════════════════════════════════
// ROTA — POST /api/v1/pagamentos/criar-cartao  (Técnicos Premium)
// Valor lido dinamicamente de precosCfgLer().premium
// Travas B e D aplicadas após aprovação da operadora.
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/pagamentos/criar-cartao', limiterPix, async (req, res) => {
  try {
    const { token, parcelas = 1, nome, identificador, tecnicoId } = req.body;

    if (!identificador) {
      return res.status(400).json({ erro: 'Identificador obrigatório.' });
    }

    // ── Valor dinâmico ────────────────────────────────────────────
    const { premium: VALOR } = await precosCfgLer();

    // Modo dev — simula aprovação sem token real
    if (!token && NODE_ENV !== 'production') {
      console.warn('[cartao] Modo dev — simulando aprovação');
      const idSim = 'sim-' + Date.now();
      await registrarPremiumMVP(identificador, idSim, tecnicoId || null);
      return res.json({ aprovado: true, status: 'approved', pagamento_id: idSim, mensagem: 'Aprovado (dev)' });
    }

    if (!token) return res.status(400).json({ erro: 'Token do cartão obrigatório.' });

    const isEmail    = (identificador).includes('@');
    const payerEmail = isEmail ? identificador : 'pagador@agrotecnico.com.br';

    const pagamento = await paymentApi.create({
      body: {
        transaction_amount: VALOR,
        token,
        description:        'AgroTécnico Premium — Destaque mensal',
        installments:       Math.min(Math.max(parseInt(parcelas) || 1, 1), 5),
        payment_method_id:  'master',
        payer: {
          email:      payerEmail,
          first_name: (nome || '').split(' ')[0] || 'Técnico',
          last_name:  (nome || '').split(' ').slice(1).join(' ') || 'AgroTécnico',
        },
        metadata: {
          agrotecnico_identificador: identificador,
          agrotecnico_plano:         'premium_mensal',
          agrotecnico_tecnico_id:    tecnicoId || null, // fonte de verdade do vínculo
        },
        notification_url: process.env.WEBHOOK_URL || undefined,
      },
    });

    console.log(`[cartao] id: ${pagamento.id} | status: ${pagamento.status} | ident: ${identificador}`);

    if (pagamento.status === 'approved') {
      // Trava B — cartão
      if (Math.abs(Number(pagamento.transaction_amount) - VALOR) > 0.001) {
        console.error('[cartao] 🚨 Trava B: valor divergente');
        return res.status(400).json({ erro: 'Valor inválido.' });
      }
      // Trava D — cartão
      if (!pagamento.metadata?.agrotecnico_identificador) {
        console.error('[cartao] 🚨 Trava D: metadata ausente');
        return res.status(400).json({ erro: 'Metadata ausente.' });
      }
      const jaAtivado = await verificarSePagamentoJaFoiAtivado(pagamento.id);
      if (!jaAtivado) await registrarPremiumMVP(identificador, pagamento.id, tecnicoId || null);
    }

    res.json({
      aprovado:     pagamento.status === 'approved',
      status:       pagamento.status,
      pagamento_id: pagamento.id,
      mensagem:
        pagamento.status === 'approved'
          ? 'Pagamento aprovado! Premium ativado.'
          : (pagamento.status === 'in_process' || pagamento.status === 'pending')
            ? 'Pagamento em análise. Aguarde a confirmação.'
            : 'Pagamento não aprovado. Verifique os dados do cartão.',
    });

  } catch (err) {
    console.error('[cartao] Erro:', err?.message || err);
    res.status(500).json({
      erro:    'Falha ao processar o cartão.',
      detalhe: NODE_ENV === 'development' ? err?.message : undefined,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// ROTAS DE STATUS — Polling do frontend
// ══════════════════════════════════════════════════════════════════

// Por paymentId (seguro — confirmação via webhook)
app.get('/api/v1/pagamentos/status/id/:paymentId', async (req, res) => {
  try {
    const registro = await Pagamentos.statusPorId(req.params.paymentId);
    const aprovado = registro?.status === 'approved';

    res.json({
      aprovado,
      premium:          aprovado,
      ativado_em:       aprovado ? registro.aprovado_em : null,
      // Token de posse — só entregue quando o pagamento está de fato
      // aprovado. Exigido em POST /api/v1/demandas/:id/desbloquear.
      desbloqueioToken: aprovado ? (registro.desbloqueio_token || null) : null,
    });
  } catch (err) {
    console.error('[status-id] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao consultar status.' });
  }
});

// Por identificador (legado/fallback)
app.get('/api/v1/pagamentos/status/:identificador', async (req, res) => {
  try {
    const registro = await Pagamentos.statusPorIdentificador(req.params.identificador);
    res.json({
      premium:    registro?.status === 'approved',
      ativado_em: registro?.aprovado_em || null,
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao consultar status.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// KYC — Validação de Conselho de Classe
// ══════════════════════════════════════════════════════════════════

function validarCPF(cpf) {
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(cpf[i]) * (10 - i);
  let r = (s * 10) % 11; if (r >= 10) r = 0;
  if (r !== parseInt(cpf[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(cpf[i]) * (11 - i);
  r = (s * 10) % 11; if (r >= 10) r = 0;
  return r === parseInt(cpf[10]);
}

/**
 * Consulta mock do conselho de classe.
 * Em produção: substituir pela SDK Serpro DataValid / API CONFEA / CFMV.
 *
 * APIs sugeridas para produção:
 *   CREA → https://sei.confea.org.br/api
 *   CRMV → https://www.cfmv.gov.br/webservice
 *   CFTA → consulta manual (sem API pública)
 */
async function kycConsultarConselho({ cpf, conselho, numConselho, ufConselho }) {
  // Simula latência de rede (300–800 ms)
  await new Promise(ok => setTimeout(ok, 300 + Math.random() * 500));

  const cpfValido  = validarCPF(cpf);
  const numValido  = /^\d{4,8}$/.test(numConselho.replace(/\D/g, ''));
  const ufValida   = ufConselho.length === 2;
  const consOk     = ['CREA', 'CRMV', 'CFTA'].includes(conselho);

  // ~70% dos CPFs válidos com dados completos são aprovados no mock
  const aprovado = cpfValido && numValido && ufValida && consOk
    && (parseInt(cpf.slice(-2)) % 10 < 7);

  return {
    ativo:    aprovado,
    situacao: aprovado ? 'ATIVO' : (cpfValido ? 'IRREGULAR' : 'CPF_INVALIDO'),
    fonte:    'mock_desenvolvimento',
  };
}

app.post('/api/v1/tecnicos/validar-conselho', limiterKyc, async (req, res) => {
  const { cpf: cpfRaw, conselho, numConselho, ufConselho } = req.body;
  const cpf = (cpfRaw || '').replace(/\D/g, '');

  if (cpf.length !== 11)                         return res.status(400).json({ erro: 'CPF inválido.',              status: 'pendente' });
  if (!['CREA','CRMV','CFTA'].includes(conselho)) return res.status(400).json({ erro: 'Conselho inválido.',        status: 'pendente' });
  if (!numConselho || numConselho.trim().length < 3) return res.status(400).json({ erro: 'Nº de registro inválido.', status: 'pendente' });
  if (!ufConselho || ufConselho.length !== 2)    return res.status(400).json({ erro: 'UF inválida.',               status: 'pendente' });

  try {
    const resultado = await kycConsultarConselho({ cpf, conselho, numConselho, ufConselho });

    if (resultado.ativo) {
      console.log(`[kyc] ✅ ATIVO — ${conselho}-${ufConselho} ${numConselho}`);
      return res.json({ status: 'ativo', mensagem: `Registro ${conselho}-${ufConselho} ${numConselho} verificado.`, situacao: resultado.situacao });
    }

    console.log(`[kyc] ⏳ PENDENTE — ${conselho}-${ufConselho} ${numConselho} | ${resultado.situacao}`);
    return res.json({ status: 'pendente', mensagem: 'Não foi possível confirmar automaticamente. Análise manual em até 48h.', situacao: resultado.situacao });

  } catch (err) {
    console.error('[kyc] Erro na consulta:', err?.message || err);
    return res.json({ status: 'pendente', mensagem: 'Não foi possível consultar o conselho agora. Análise manual em até 48h.', situacao: 'ERRO_API_EXTERNA' });
  }
});

// ══════════════════════════════════════════════════════════════════
// TÉCNICOS — Cadastro, Validação e Gestão
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/tecnicos/cadastrar', limiterCad, async (req, res) => {
  try {
    const { nome, whatsapp, email, cidade, uf, formacao, conselho, numConselho, ufConselho, bio, especialidades, raio, servico } = req.body;

    // Validação do CPF — backend é a fonte da verdade
    const cpfLimpo = (req.body.cpf || '').replace(/\D/g, '');
    if (!validarCPF(cpfLimpo)) return res.status(400).json({ erro: 'CPF inválido.' });

    // Conselho é opcional — nem toda especialidade tem conselho
    // profissional equivalente (ex.: piloto de trator, piloto de drone
    // agrícola). Quem informa conselho passa pela mesma validação
    // rigorosa de sempre; quem não informa, cadastra sem essa exigência
    // e aparece na plataforma sem o destaque de "registro verificado".
    const temConselho = !!(conselho && String(conselho).trim());
    if (temConselho) {
      if (!['CREA','CRMV','CFTA'].includes(conselho))               return res.status(400).json({ erro: 'Conselho inválido.' });
      if (!numConselho || numConselho.trim().length < 3)            return res.status(400).json({ erro: 'Nº do conselho inválido.' });
      if (!ufConselho || ufConselho.length !== 2)                   return res.status(400).json({ erro: 'UF do conselho inválida.' });
    }

    // Sanitiza campos de texto — previne XSS armazenado
    const san = (v, max=200) => (v||'').trim().replace(/[<>"'`]/g,'').slice(0,max);

    // db.js (Tecnicos.criar) cuida de: gerar public_id único consultando
    // o banco, gerar o upload_token (prova de posse) e hashear o CPF —
    // nada disso fica mais em memória de processo único (Set/JSON).
    const { id, publicId, uploadToken } = await Tecnicos.criar({
      nome:           san(nome, 100),
      whatsapp:       (whatsapp||'').replace(/\D/g, '').slice(0,11),
      email:          san(email, 150).toLowerCase() || null,
      cpf:            cpfLimpo,
      cidade:         san(cidade, 100),
      uf:             san(uf, 2).toUpperCase(),
      formacao:       san(formacao, 50),
      conselho:       temConselho ? conselho : null,
      numConselho:    temConselho ? san(numConselho, 20) : null,
      ufConselho:     temConselho ? san(ufConselho, 2).toUpperCase() : null,
      bio:            san(bio, 800),
      especialidades: (Array.isArray(especialidades) ? especialidades : []).slice(0,20),
      raio,
      servico,
    });

    console.log(`[cadastrar] ${nome} — ${temConselho ? `${conselho}-${ufConselho} ${numConselho}` : 'sem conselho'} (pendente) — id ${id}`);

    res.status(201).json({ id, publicId, uploadToken, statusValidacao: 'pendente', mensagem: 'Cadastro realizado. Aguardando validação.' });

  } catch (err) {
    if (err?.cadastroDuplicado) {
      const campoTxt = err.campo === 'email' ? 'e-mail' : 'CPF';
      return res.status(409).json({ erro: `Já existe um cadastro com esse ${campoTxt}.` });
    }
    console.error('[cadastrar] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao cadastrar técnico.' });
  }
});

app.post('/api/v1/tecnicos/:id/documento', upload.single('documento'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const idNum = Number(req.params.id);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!tecnico) {
      // Nada em disco pra limpar — arquivo só existe em memória até aqui
      return res.status(404).json({ erro: 'Técnico não encontrado.' });
    }

    const tokenRecebido = req.headers['x-upload-token'] || req.body?.uploadToken || '';
    if (!await Tecnicos.verificarUploadToken(idNum, tokenRecebido)) {
      return res.status(403).json({ erro: 'Não autorizado a enviar documento para este técnico.' });
    }

    // ── Terceira camada: validação por magic bytes (conteúdo real) ──
    // Lida direto do buffer em memória — nada é gravado em disco antes
    // da validação passar.
    const ext = path.extname(req.file.originalname).toLowerCase();
    const verificacao = await validarMagicBytes(req.file.buffer, req.file.mimetype, ext);

    if (!verificacao.valido) {
      console.warn(`[doc-upload] ⚠ Magic bytes inválidos — ${req.file.originalname} (${req.file.mimetype}) — ${verificacao.motivo} — técnico ${req.params.id}`);
      return res.status(400).json({ erro: 'Tipo de arquivo não permitido. Use PDF, JPG ou PNG.' });
    }
    // ────────────────────────────────────────────────────────────────

    const key = `doc-${idNum}-${Date.now()}${ext}`;
    await storageR2.enviarDocumento(req.file.buffer, key, req.file.mimetype);

    await Tecnicos.salvarDocumento(idNum, {
      docPath:         key,
      docOriginalName: req.file.originalname,
      docMime:         req.file.mimetype,
    });

    console.log(`[doc-upload] ${key} → técnico ${req.params.id}`);
    res.json({ sucesso: true, arquivo: key, tamanho: req.file.size, mensagem: 'Documento recebido. Aguardando análise.' });

  } catch (err) {
    if (err.message?.includes('Tipo de arquivo')) return res.status(400).json({ erro: err.message });
    if (err.code === 'LIMIT_FILE_SIZE')            return res.status(400).json({ erro: 'Arquivo muito grande. Máx. 5 MB.' });
    console.error('[doc-upload] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao salvar documento.' });
  }
});

// Validação manual pelo admin
const PORTAIS_CONSELHO = {
  CREA: 'https://www.confea.org.br/profissional/consulta-de-registro',
  CRMV: 'https://www.cfmv.gov.br/consulta-medico-veterinario/',
  CFTA: 'https://www.cfta.org.br/consulta',
};

app.post('/api/v1/admin/tecnicos/:id/validar', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    await Tecnicos.atualizarStatus(idNum, 'ativo', req.body.adminNome || 'admin');
    console.log(`[validar] ${tecnico.nome} (${tecnico.registro_completo}) ativado.`);

    res.json({ id: idNum, statusValidacao: 'ativo', registroCompleto: tecnico.registro_completo, mensagem: 'Técnico validado e liberado no marketplace.' });

  } catch (err) {
    console.error('[validar] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao validar técnico.' });
  }
});

app.post('/api/v1/admin/tecnicos/:id/status', requireAdmin, async (req, res) => {

  const statusValidos = ['ativo', 'suspenso', 'pendente', 'recusado'];
  if (!statusValidos.includes(req.body.status)) return res.status(400).json({ erro: `Status inválido. Use: ${statusValidos.join(', ')}` });

  try {
    const idNum = Number(req.params.id);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const ant = tecnico.status;
    await Tecnicos.atualizarStatus(idNum, req.body.status, req.body.adminNome || 'admin');
    console.log(`[status] ${tecnico.nome}: ${ant} → ${req.body.status}`);
    res.json({ id: idNum, statusAnterior: ant, statusAtual: req.body.status });

  } catch (err) {
    console.error('[status] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao alterar status.' });
  }
});

app.get('/api/v1/admin/tecnicos/pendentes', requireAdmin, async (req, res) => {
  try {
    const pendentes = (await Tecnicos.listarPendentes())
      .map(t => ({ ...t, portalConselho: PORTAIS_CONSELHO[t.conselho] || null }));

    res.json({ total: pendentes.length, pendentes });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar pendentes.' });
  }
});

/**
 * POST /api/v1/admin/tecnicos/:id/premium — concede ou revoga Premium
 * manualmente (sem pagamento associado). Usada pelo botão "Dar/Remover
 * Premium" do painel admin.
 */
app.post('/api/v1/admin/tecnicos/:id/premium', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const premium = !!req.body?.premium;
    await Tecnicos.definirPremium(idNum, premium);
    console.log(`[admin/premium] ${tecnico.nome}: premium → ${premium}`);
    res.json({ id: idNum, premium });
  } catch (err) {
    console.error('[admin/premium] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao atualizar Premium.' });
  }
});

/**
 * POST /api/v1/admin/produtores/:id/status — suspende ou reativa uma
 * conta de produtor. Produtor suspenso (ativo=0) não consegue mais
 * fazer login (Produtores.buscarPorIdent já filtra ativo=1).
 */
app.post('/api/v1/admin/produtores/:id/status', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    const produtor = Number.isInteger(idNum) ? await Produtores.buscarPorId(idNum) : null;
    if (!produtor) return res.status(404).json({ erro: 'Produtor não encontrado.' });

    const ativo = !!req.body?.ativo;
    await Produtores.atualizarStatus(idNum, ativo);
    console.log(`[admin/produtores] ${produtor.nome}: ativo → ${ativo}`);
    res.json({ id: idNum, ativo });
  } catch (err) {
    console.error('[admin/produtores/status] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao atualizar status do produtor.' });
  }
});

/**
 * Formato de técnico para o painel admin — allow-list explícita.
 * Diferente de sanitizarTecnicoPublico(): é para uso interno (admin
 * autenticado), então pode incluir e-mail; nunca inclui cpf_hash,
 * senha_hash nem upload_token.
 */
function sanitizarTecnicoAdmin(t) {
  let especialidades = [];
  try { especialidades = JSON.parse(t.especialidades || '[]'); } catch { /* ok */ }
  return {
    id:               t.id,
    publicId:         t.public_id,
    nome:             t.nome,
    fotoUrl:          storageR2.urlPublicaAvatar(t.foto_path),
    whatsapp:         t.whatsapp,
    telefone:         t.telefone || null,
    email:            t.email,
    cidade:           t.cidade,
    uf:               t.uf,
    formacao:         t.formacao,
    conselho:         t.conselho,
    numConselho:      t.num_conselho,
    ufConselho:       t.uf_conselho,
    registroCompleto: t.registro_completo,
    verificadoPorConselho: !!t.conselho,
    especialidades,
    status:           t.status,
    ativo:            !!t.ativo,
    premium:          premiumEfetivo(t),
    premiumExpiraEm:  t.premium_expira_em || null,
    visivel:          t.visivel === undefined ? true : !!t.visivel,
    excluido:         !!t.excluido,
    mediaAvaliacoes:  t.media_avaliacoes,
    totalAvaliacoes:  t.total_avaliacoes,
    docOriginalName:  t.doc_original_name || null,
    criadoEm:         t.criado_em,
    validadoEm:       t.validado_em,
    ultimoAcesso:     t.ultimo_acesso || null,
  };
}

/**
 * GET /api/v1/admin/tecnicos — lista TODOS os técnicos, qualquer
 * status. Antes desta rota não existir, o painel admin não tinha
 * como enxergar a base real de técnicos (usava dados de demonstração
 * embutidos no frontend — auditoria, Achado #1).
 */
app.get('/api/v1/admin/tecnicos', requireAdmin, async (req, res) => {
  try {
    const tecnicos = (await Tecnicos.listarTodosAdmin()).map(sanitizarTecnicoAdmin);
    res.json({ total: tecnicos.length, tecnicos });
  } catch (err) {
    console.error('[admin/tecnicos] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao listar técnicos.' });
  }
});

/**
 * GET /api/v1/admin/produtores — lista todos os produtores reais
 * cadastrados, com contagem de favoritos. Antes o painel admin só
 * enxergava o único produtor logado no navegador atual (localStorage).
 */
app.get('/api/v1/admin/produtores', requireAdmin, async (req, res) => {
  try {
    const produtores = (await Produtores.listarComFavoritos()).map(p => ({
      id:               p.id,
      nome:             p.nome,
      identificador:    p.identificador,
      tipoIdent:        p.tipo_ident,
      aceitouNovidades: !!p.aceita_novidades,
      ativo:            !!p.ativo,
      totalFavoritos:   Number(p.total_favoritos || 0),
      criadoEm:         p.criado_em,
    }));
    res.json({ total: produtores.length, produtores });
  } catch (err) {
    console.error('[admin/produtores] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao listar produtores.' });
  }
});

/**
 * GET /api/v1/admin/denuncias — lista todas as denúncias registradas.
 * Antes o painel admin lia denúncias apenas do localStorage do
 * navegador do próprio admin (nunca via denúncias feitas por outros
 * visitantes em outros navegadores).
 */
app.get('/api/v1/admin/denuncias', requireAdmin, async (req, res) => {
  try {
    const denuncias = (await Denuncias.listar()).map(d => ({
      id:           d.id,
      tecnicoId:    d.tecnico_id,
      tecnicoNome:  d.tecnico_nome,
      motivo:       d.motivo,
      descricao:    d.descricao,
      status:       d.status,
      resolucao:    d.resolucao,
      criadoEm:     d.criado_em,
      resolvidoEm:  d.resolvido_em,
      // ip_hash nunca exposto — é interno para dedupe "já denunciou hoje"
    }));
    res.json({ total: denuncias.length, denuncias });
  } catch (err) {
    console.error('[admin/denuncias] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao listar denúncias.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// DENÚNCIAS — SUBTÓPICO 4.4
// ─────────────────────────────────────────────────────────────────
// denunciasLer/denunciasSalvar/verificarAutoSuspensao (baseadas em
// DENUNCIAS_FILE + TECNICOS_FILE) saem de uso — a lógica de
// auto-suspensão (3+ denúncias de "falso profissional" pendentes)
// agora usa Denuncias.contarFalsosProfissionais() + Tecnicos.
// suspenderAutomaticamente(), ambos do db.js, testados isoladamente
// antes desta migração.
// ══════════════════════════════════════════════════════════════════

const MOTIVOS_DENUNCIA_VALIDOS = [
  'falso_profissional','dados_falsos','profissional_inadequado',
  'numero_incorreto','golpe_fraude','conteudo_ofensivo','outro',
];

app.post('/api/v1/denuncias', limiterDen, async (req, res) => {
  const { tecnicoId, tecnicoNome, motivo, descricao } = req.body;
  if (!tecnicoId || !motivo) return res.status(400).json({ erro: 'tecnicoId e motivo são obrigatórios.' });
  if (!MOTIVOS_DENUNCIA_VALIDOS.includes(motivo)) return res.status(400).json({ erro: 'Motivo inválido.' });

  try {
    const idNum = Number(tecnicoId);
    if (!Number.isInteger(idNum)) return res.status(400).json({ erro: 'tecnicoId inválido.' });

    const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';

    if (await Denuncias.jaDenounciouHoje(idNum, motivo, ip)) {
      return res.status(429).json({ erro: 'Você já registrou esta denúncia nas últimas 24h.' });
    }

    const info = await Denuncias.criar({
      tecnicoId:   idNum,
      tecnicoNome: tecnicoNome || 'Desconhecido',
      motivo,
      descricao:   descricao?.slice(0, 300) || null,
      ip,
    });
    const denunciaId = info.lastInsertRowid;

    // Auto-suspensão: 3+ denúncias PENDENTES de "falso profissional"
    // para o mesmo técnico suspendem imediatamente, sem esperar
    // moderação manual — mesma regra do MVP original.
    let autoSuspenso = false;
    if (motivo === 'falso_profissional' && await Denuncias.contarFalsosProfissionais(idNum) >= 3) {
      await Tecnicos.suspenderAutomaticamente(idNum);
      autoSuspenso = true;
      console.warn(`[segurança] ⚠ AUTO-SUSPENSÃO: ${tecnicoNome || idNum} — 3+ denúncias de Falso Profissional`);
    }

    console.log(`[denúncia] ${motivo} — ${tecnicoNome || idNum}${autoSuspenso ? ' → SUSPENSO' : ''}`);

    res.status(201).json({
      recebido: true,
      id: denunciaId,
      autoSuspenso,
      mensagem: autoSuspenso ? 'Técnico suspenso automaticamente.' : 'Denúncia registrada.',
    });
  } catch (err) {
    console.error('[denúncia] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao registrar denúncia.' });
  }
});

app.post('/api/v1/denuncias/:id/ignorar', requireAdmin, async (req, res) => {
  try {
    await Denuncias.arquivar(Number(req.params.id), 'ignorada', req.body?.adminNome || 'admin');
    res.json({ ok: true });
  } catch (err) {
    console.error('[denuncia/ignorar] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao ignorar denúncia.' });
  }
});

app.post('/api/v1/denuncias/:id/suspender', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.body?.tecnicoId);
    if (Number.isInteger(idNum)) {
      await Tecnicos.atualizarStatus(idNum, 'suspenso', req.body?.adminNome || 'admin');
    }
    await Denuncias.arquivar(Number(req.params.id), 'suspenso', req.body?.adminNome || 'admin');
    console.log(`[denúncia] ${req.body?.tecnicoId} suspenso por moderação manual`);
    res.json({ ok: true, status: 'suspenso' });
  } catch (err) {
    console.error('[denuncia/suspender] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao suspender técnico.' });
  }
});

app.post('/api/v1/denuncias/:id/reativar', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.body?.tecnicoId);
    if (Number.isInteger(idNum)) {
      await Tecnicos.atualizarStatus(idNum, 'ativo', req.body?.adminNome || 'admin');
    }
    res.json({ ok: true, status: 'ativo' });
  } catch (err) {
    console.error('[denuncia/reativar] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao reativar técnico.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// AVALIAÇÕES — SUBTÓPICO 4.4
// ─────────────────────────────────────────────────────────────────
// avaliacoesLer/avaliacoesSalvar (AVALIACOES_FILE) saem de uso —
// Avaliacoes.criar/listarPorTecnico/jaAvaliouHoje (db.js) substituem.
// calcularMedia agora opera sobre linhas do banco (campo `nota`, não
// mais `stars`) — único ponto de cálculo de média usado por todas as
// rotas de avaliação, inclusive a self-service /tecnico/avaliacoes.
// ══════════════════════════════════════════════════════════════════

function calcularMedia(avs) {
  if (!avs?.length) return 0;
  return parseFloat((avs.reduce((s, a) => s + (a.nota || 0), 0) / avs.length).toFixed(1));
}

app.post('/api/v1/tecnicos/:id/avaliacoes', limiterAval, async (req, res) => {
  const idNum = Number(req.params.id);
  const { autor, texto, stars } = req.body;

  if (!Number.isInteger(idNum)) return res.status(400).json({ erro: 'Técnico inválido.' });
  if (!autor || autor.trim().length < 2)  return res.status(400).json({ erro: 'Nome do autor inválido.' });
  if (!texto || texto.trim().length < 10) return res.status(400).json({ erro: 'Comentário muito curto (mín. 10 chars).' });
  const nota = parseInt(stars);
  if (isNaN(nota) || nota < 1 || nota > 5) return res.status(400).json({ erro: 'Nota deve ser entre 1 e 5.' });

  try {
    // Confirma que o técnico existe antes de criar qualquer registro —
    // evita acumular avaliações "fantasma" para IDs inventados.
    const tecnico = await Tecnicos.buscarPorId(idNum);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
    if (await Avaliacoes.jaAvaliouHoje(idNum, ip)) {
      return res.status(429).json({ erro: 'Você já avaliou este técnico hoje.' });
    }

    const autorLimpo = autor.trim().slice(0, 80);
    const textoLimpo = texto.trim().slice(0, 400);

    await Avaliacoes.criar({ tecnicoId: idNum, autorNome: autorLimpo, texto: textoLimpo, nota, ip });
    await Tecnicos.atualizarMediaAvaliacoes(idNum);

    const avs = await Avaliacoes.listarPorTecnico(idNum);

    console.log(`[avaliação] ${nota}★ — técnico ${idNum} — ${autorLimpo}`);
    res.status(201).json({
      recebido:        true,
      avaliacao:       { autor: autorLimpo, texto: textoLimpo, stars: nota, data: new Date().toISOString() },
      totalAvaliacoes: avs.length,
      mediaAvaliacoes: calcularMedia(avs),
    });

  } catch (err) {
    console.error('[avaliação] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao salvar avaliação.' });
  }
});

app.get('/api/v1/tecnicos/:id/avaliacoes', async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    const avs   = Number.isInteger(idNum) ? await Avaliacoes.listarPorTecnico(idNum) : [];
    const avaliacoesPublicas = avs.map(a => ({
      autor: a.autor_nome, texto: a.texto, stars: a.nota, data: a.criado_em,
    }));
    res.json({ tecnicoId: req.params.id, avaliacoes: avaliacoesPublicas, total: avs.length, mediaAvaliacoes: calcularMedia(avs) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar avaliações.' });
  }
});

/**
 * Fábrica de rota de contador — as 4 rotas abaixo (whatsapp, telefone,
 * email, visualização) tinham exatamente o mesmo corpo, só trocando o
 * nome do campo incrementado. Uma função só evita repetir 4× a mesma
 * lógica de busca/erro.
 */
function rotaContador(campo, label) {
  return async (req, res) => {
    try {
      const idNum = Number(req.params.id);
      if (!Number.isInteger(idNum) || !await Tecnicos.buscarPorId(idNum)) {
        return res.status(404).json({ erro: 'Técnico não encontrado.' });
      }
      await Tecnicos.incrementarContador(idNum, campo);
      res.json({ sucesso: true });
    } catch (err) {
      console.error(`[${label}] Erro:`, err?.message || err);
      res.status(500).json({ erro: 'Erro ao registrar clique.' });
    }
  };
}

app.post('/api/v1/tecnicos/:id/clique-whatsapp', rotaContador('cliquesWhatsapp', 'clique-whatsapp'));
app.post('/api/v1/tecnicos/:id/clique-telefone', rotaContador('cliquesTelefone', 'clique-telefone'));
app.post('/api/v1/tecnicos/:id/clique-email',    rotaContador('cliquesEmail',    'clique-email'));
app.post('/api/v1/tecnicos/:id/visualizacao',    rotaContador('visualizacoes',   'visualizacao'));

// ══════════════════════════════════════════════════════════════════
// DEMANDAS — Mural de Oportunidades — SUBTÓPICO 4.5
// ─────────────────────────────────────────────────────────────────
// demandasLer/demandasSalvar (DEMANDAS_FILE) saem de uso. O contato
// (wpp/email) passa a ser cifrado com cripto-contato.js ANTES de
// chegar ao banco — Demandas.criar() só recebe contato_enc/contato_iv,
// nunca o texto puro. Somente após a verificação de Premium +
// desbloqueio_token (POST /desbloquear) o contato é decifrado.
// ══════════════════════════════════════════════════════════════════

app.post('/api/v1/demandas', async (req, res) => {
  const { cultura, descricao, cidade, uf, wpp, email, canal, optin, produtor } = req.body;

  if (!cultura || !descricao || descricao.trim().length < 20) return res.status(400).json({ erro: 'Cultura e descrição (mín. 20 chars) são obrigatórios.' });

  const wppDigits = (wpp || '').replace(/\D/g, '');
  const precisaWpp = canal === 'wpp' || canal === 'ambos';
  if (precisaWpp && wppDigits.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido.' });

  try {
    const sanD = (v, max=400) => (v||'').trim().replace(/[<>"'`]/g,'').slice(0,max);

    // Cifra o contato ANTES de gravar — o banco nunca guarda wpp/email
    // em texto puro (ver lib/cripto-contato.js).
    const { contato_enc, contato_iv } = cripto.cifrarContato({
      wpp:   wppDigits || null,
      email: sanD(email, 150) || null,
      canal: canal || 'wpp',
    });

    const info = await Demandas.criar({
      produtorNome: (produtor || 'Produtor').trim().slice(0, 60),
      cultura:      sanD(cultura, 60),
      descricao:    sanD(descricao, 400),
      cidade:       sanD(cidade, 100),
      uf:           sanD(uf, 2).toUpperCase(),
      canal:        canal || 'wpp',
      contatoEnc:   contato_enc,
      contatoIv:    contato_iv,
      optin:        !!optin,
      ip:           req.ip || '',
    });

    console.log(`[demanda] Nova: ${cultura} — ${cidade}/${uf} — id ${info.lastInsertRowid}`);
    res.status(201).json({ recebido: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[demanda] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao salvar demanda.' });
  }
});

app.get('/api/v1/demandas', async (req, res) => {
  try {
    // Demandas.listarAtivas() já faz um SELECT explícito sem contato_enc/
    // contato_iv/ip_hash — nunca expõe dados de contato publicamente,
    // por design da query (allow-list), não por filtragem depois.
    const publicas = await Demandas.listarAtivas();
    res.json({ total: publicas.length, demandas: publicas });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar demandas.' });
  }
});

app.post('/api/v1/demandas/:id/desbloquear', async (req, res) => {
  const { tecnicoId, desbloqueioToken } = req.body;
  if (!tecnicoId) return res.status(400).json({ erro: 'tecnicoId é obrigatório.' });
  if (!desbloqueioToken) return res.status(400).json({ erro: 'desbloqueioToken é obrigatório.' });

  try {
    const idNum = Number(tecnicoId);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!premiumEfetivo(tecnico)) return res.status(403).json({ erro: 'Acesso restrito ao Plano Premium.', upgrade: true });

    // Prova de posse — sem isso, qualquer um que soubesse um tecnicoId
    // premium real desbloquearia qualquer demanda. O token só é conhecido
    // por quem consultou o status daquele pagamento já aprovado.
    const tokenValido = await Pagamentos.desbloqueioTokenPorTecnico(idNum);
    if (!tokenValido || desbloqueioToken !== tokenValido) {
      return res.status(403).json({ erro: 'Token de acesso inválido.' });
    }

    const demandaId = Number(req.params.id);
    const registro  = Number.isInteger(demandaId) ? await Demandas.buscarContato(demandaId) : null;
    if (!registro) return res.status(404).json({ erro: 'Demanda não encontrada.' });

    // Só decifra depois de confirmado o pagamento — se o payload foi
    // adulterado ou a chave mudou sem migração, decifrarContato lança
    // erro em vez de devolver contato incorreto silenciosamente.
    const contato = cripto.decifrarContato(registro.contato_enc, registro.contato_iv);

    await Demandas.registrarDesbloqueio(demandaId, idNum, req.ip || '');

    console.log(`[demanda] Contato desbloqueado: ${demandaId} por técnico ${idNum}`);
    res.json({ wpp: contato.wpp, email: contato.email, canal: contato.canal });
  } catch (err) {
    console.error('[demanda] Erro desbloquear:', err?.message);
    res.status(500).json({ erro: 'Erro ao desbloquear contato.' });
  }
});

app.delete('/api/v1/demandas/:id', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    if (!Number.isInteger(idNum)) return res.status(404).json({ erro: 'Demanda não encontrada.' });
    await Demandas.encerrar(idNum);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao encerrar demanda.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GEOLOCALIZAÇÃO — Haversine + coordenadas IBGE
// ══════════════════════════════════════════════════════════════════

const COORDS_MUNICIPIOS = {
  // Rondônia
  'porto velho':          { lat: -8.7612,  lng: -63.9004 },
  'ji-parana':            { lat: -10.8794, lng: -61.9264 },
  'ariquemes':            { lat: -9.9133,  lng: -63.0389 },
  'vilhena':              { lat: -12.7406, lng: -60.1458 },
  'cacoal':               { lat: -11.4344, lng: -61.4483 },
  'rolim de moura':       { lat: -11.7253, lng: -61.7799 },
  'guajara-mirim':        { lat: -10.7864, lng: -65.3386 },
  'jaru':                 { lat: -10.4381, lng: -62.4661 },
  'pimenta bueno':        { lat: -11.6724, lng: -61.1953 },
  'ouro preto do oeste':  { lat: -10.7227, lng: -62.2168 },
  'presidente medici':    { lat: -11.1785, lng: -61.8952 },
  'espigao d oeste':      { lat: -11.5280, lng: -61.0072 },
  'nova mamore':          { lat: -10.4142, lng: -65.3350 },
  'costa marques':        { lat: -12.4394, lng: -64.2381 },
  'colorado do oeste':    { lat: -13.1195, lng: -60.5420 },
  // Mato Grosso
  'cuiaba':               { lat: -15.5989, lng: -56.0949 },
  'rondonopolis':         { lat: -16.4701, lng: -54.6358 },
  'sinop':                { lat: -11.8650, lng: -55.5072 },
  'sorriso':              { lat: -12.5447, lng: -55.7219 },
  'lucas do rio verde':   { lat: -13.0553, lng: -55.9167 },
  'nova mutum':           { lat: -13.8296, lng: -56.0804 },
  'campo verde':          { lat: -15.5424, lng: -55.1680 },
  'tanguara da serra':    { lat: -14.6222, lng: -57.4950 },
  'caceres':              { lat: -16.0730, lng: -57.6815 },
  'alta floresta':        { lat: -9.8754,  lng: -56.0861 },
  'primavera do leste':   { lat: -15.5554, lng: -54.2994 },
  // Goiás
  'goiania':              { lat: -16.6864, lng: -49.2643 },
  'rio verde':            { lat: -17.7928, lng: -50.9281 },
  'jatai':                { lat: -17.8800, lng: -51.7156 },
  // Mato Grosso do Sul
  'campo grande':         { lat: -20.4697, lng: -54.6201 },
  'dourados':             { lat: -22.2233, lng: -54.8059 },
  // Pará
  'belem':                { lat: -1.4558,  lng: -48.4902 },
  'santarem':             { lat: -2.4320,  lng: -54.7080 },
  'paragominas':          { lat: -2.9730,  lng: -47.3483 },
  // Bahia
  'barreiras':            { lat: -12.1446, lng: -45.0044 },
  'luis eduardo magalhaes': { lat: -12.0963, lng: -45.7900 },
  // São Paulo
  'ribeirao preto':       { lat: -21.1775, lng: -47.8103 },
  'campinas':             { lat: -22.9056, lng: -47.0608 },
  // Paraná
  'londrina':             { lat: -23.3045, lng: -51.1696 },
  'cascavel':             { lat: -24.9578, lng: -53.4596 },
  // Tocantins
  'palmas':               { lat: -10.2491, lng: -48.3243 },
  // Brasília
  'brasilia':             { lat: -15.7942, lng: -47.8825 },
};

function normalizarCidade(nome) {
  return (nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function getCoordenadas(nome) {
  return COORDS_MUNICIPIOS[normalizarCidade(nome)] || null;
}

/**
 * Premium "de verdade" — considera vencimento, não só a flag `premium`.
 * A flag no banco pode continuar 1 depois de vencido (não há cron pra
 * zerá-la automaticamente — não precisa, esta checagem já cobre todo
 * lugar que decide algo com base em ser ou não Premium). Usar SEMPRE
 * esta função em vez de ler `tecnico.premium` cru.
 */
function premiumEfetivo(tecnico) {
  return !!(
    tecnico?.premium &&
    tecnico?.premium_expira_em &&
    new Date(tecnico.premium_expira_em) > new Date()
  );
}

function haversineServer(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2
           + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
           * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Converte um registro bruto de `tecnicos` (colunas snake_case do banco)
 * no formato público consumido pelo frontend — allow-list explícita:
 * só entra no JSON o que está listado aqui. Substitui o padrão antigo
 * de "denylist" (`campo: undefined`), que falha silenciosamente se um
 * novo campo sensível for adicionado à tabela e alguém esquecer de
 * excluí-lo manualmente.
 */
function sanitizarTecnicoPublico(t) {
  let especialidades = [];
  try { especialidades = JSON.parse(t.especialidades || '[]'); } catch { /* ok */ }
  let servicosLista = [];
  try { servicosLista = JSON.parse(t.servicos || '[]'); } catch { /* ok */ }

  return {
    id:               t.id,
    publicId:         t.public_id,
    nome:             t.nome,
    fotoUrl:          storageR2.urlPublicaAvatar(t.foto_path),
    // O WhatsApp é exibido publicamente por design do produto — é o
    // canal de contato direto entre produtor e técnico, o núcleo da
    // proposta de valor da plataforma. Omiti-lo aqui (como estava)
    // quebra o botão "Falar pelo WhatsApp" para qualquer técnico real.
    whatsapp:         t.whatsapp,
    cidade:           t.cidade,
    uf:               t.uf,
    coords:           getCoordenadas(t.cidade),
    formacao:         t.formacao,
    conselho:         t.conselho,
    numConselho:      t.num_conselho,
    ufConselho:       t.uf_conselho,
    registroCompleto: t.registro_completo,
    verificadoPorConselho: !!t.conselho,
    bio:              t.bio,
    experiencia:      t.experiencia,
    especialidades,
    servicos:         servicosLista,
    raio:             t.raio_km,
    servico:          t.servico,
    sitePessoal:      t.site_pessoal || null,
    redesSociais: {
      instagram: t.instagram || null,
      facebook:  t.facebook  || null,
      linkedin:  t.linkedin  || null,
    },
    statusValidacao:  t.status,
    ativo:            !!t.ativo,
    premium:          premiumEfetivo(t),
    mediaAvaliacoes:  t.media_avaliacoes,
    totalAvaliacoes:  t.total_avaliacoes,
    cadastradoEm:     t.criado_em,
  };
}

app.get('/api/v1/tecnicos', async (req, res) => {
  try {
    const { cidade, raio, uf, especialidade } = req.query;
    const raioKm = parseInt(raio);

    let tecnicos = (await Tecnicos.listar({ uf: uf || undefined }))
      .map(sanitizarTecnicoPublico);

    if (especialidade && especialidade.trim()) {
      tecnicos = tecnicos.filter(t => Array.isArray(t.especialidades) && t.especialidades.includes(especialidade.trim()));
    }

    if (cidade && !isNaN(raioKm)) {
      const origem = getCoordenadas(cidade);
      if (origem) {
        tecnicos = tecnicos
          .map(t => {
            if (!t.coords) return null;
            const dist = haversineServer(origem.lat, origem.lng, t.coords.lat, t.coords.lng);
            if (raioKm === 0) return normalizarCidade(t.cidade) === normalizarCidade(cidade) ? { ...t, distanciaKm: 0 } : null;
            return dist <= raioKm ? { ...t, distanciaKm: Math.round(dist) } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.distanciaKm - b.distanciaKm);
      }
    }

    res.json({ total: tecnicos.length, tecnicos });

    // Métrica "quantidade de buscas em que apareceu" (dashboard do
    // técnico) — roda depois de responder, não atrasa a busca do
    // produtor por causa de um UPDATE de métricas.
    if (tecnicos.length) {
      Tecnicos.incrementarImpressoesBusca(tecnicos.map(t => t.id)).catch(err =>
        console.error('[tecnicos] Falha ao registrar impressões de busca:', err?.message)
      );
    }
  } catch (err) {
    console.error('[tecnicos] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao listar técnicos.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/tecnicos/public/:publicId
// Rota de detalhe público por identificador estável (publicId).
// Mesmo critério de visibilidade e mesma sanitização de campos
// sensíveis usados em GET /api/v1/tecnicos. Infraestrutura para
// futura migração do modal de perfil — não consumida pelo frontend
// nesta entrega.
// ══════════════════════════════════════════════════════════════════
app.get('/api/v1/tecnicos/public/:publicId', async (req, res) => {
  try {
    const tecnico = await Tecnicos.buscarPorPublicId(req.params.publicId);

    if (!tecnico || !tecnico.ativo || tecnico.status !== 'ativo') {
      return res.status(404).json({ erro: 'Técnico não encontrado.' });
    }

    res.json({ tecnico: sanitizarTecnicoPublico(tecnico) });
  } catch (err) {
    console.error('[tecnicos/public/:publicId] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao buscar técnico.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// AVISO GLOBAL — SUBTÓPICO 4.6
// ─────────────────────────────────────────────────────────────────
// avisoLer/avisoSalvar (AVISO_FILE) saem de uso — Avisos.ativo()/
// publicar()/remover() (db.js) cuidam de manter só um aviso ativo por
// vez (publicar() desativa qualquer aviso anterior antes de inserir
// o novo), mantendo o histórico completo na tabela em vez de
// sobrescrever um único arquivo.
// ══════════════════════════════════════════════════════════════════

app.get('/api/v1/aviso', async (req, res) => {
  try {
    const a = await Avisos.ativo();
    res.json({ texto: a?.texto || '', ativo: !!a?.texto });
  } catch {
    res.json({ texto: '', ativo: false });
  }
});

app.post('/api/v1/aviso', requireAdmin, async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ erro: 'Texto obrigatório.' });
  await Avisos.publicar(texto.trim());
  console.log(`[aviso] Publicado: "${texto.trim().slice(0, 60)}"`);
  res.json({ ok: true, texto: texto.trim() });
});

app.delete('/api/v1/aviso', requireAdmin, async (req, res) => {
  await Avisos.remover();
  console.log('[aviso] Removido.');
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// CLASSIFICADOS — SUBTÓPICO 4.5
// ─────────────────────────────────────────────────────────────
// classLer/classSalvar/classCountLer/classCountSalvar (JSON) saem
// de uso. A contagem de "já usou o anúncio grátis" deixa de vir de
// um contador solto (classificados-count.json) e passa a ser
// derivada diretamente das linhas reais da tabela `classificados`
// via Classificados.contarPorIdent() — uma fonte de verdade a menos
// para manter sincronizada.
// ══════════════════════════════════════════════════════════════

// Lock em memória — previne race condition em /confirmar quando duas
// requisições chegam quase simultâneas para o mesmo pagamentoId.
// Continua fazendo sentido independentemente do backend de persistência
// (é sobre concorrência dentro do processo, não sobre onde os dados
// ficam salvos). MVP: Map local. Produção multi-processo: Redis SET NX EX 30.
const _confirmandoIds = new Map();

function _confirmarAdquirirLock(pagamentoId) {
  if (_confirmandoIds.has(pagamentoId)) return false; // já em processamento
  _confirmandoIds.set(pagamentoId, Date.now());
  setTimeout(() => _confirmandoIds.delete(pagamentoId), 30_000);
  return true;
}

function _confirmarLiberarLock(pagamentoId) {
  _confirmandoIds.delete(pagamentoId);
}

/**
 * GET /api/v1/classificados/contagem/:identificador
 * Consulta quantos anúncios o parceiro já publicou.
 * Frontend usa para decidir grátis ou pago — sem confiar no localStorage.
 */
app.get('/api/v1/classificados/contagem/:identificador', async (req, res) => {
  try {
    const ident = (req.params.identificador || '').trim();
    if (!ident || ident.length < 5) {
      return res.status(400).json({ erro: 'Identificador inválido.' });
    }
    const total = await Classificados.contarPorIdent(ident);
    res.json({ identificador: ident, total, primeiroBloqueado: total >= 1 });
  } catch (err) {
    console.error('[classificados/contagem] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao consultar contagem.' });
  }
});

/**
 * GET /api/v1/classificados
 * Lista anúncios ativos — substitui o localStorage como fonte de verdade.
 * Fixos (hardcoded) são mesclados no frontend para compatibilidade.
 */
app.get('/api/v1/classificados', async (req, res) => {
  try {
    const ativos = await Classificados.listarAtivos();
    res.json({ total: ativos.length, classificados: ativos });
  } catch (err) {
    console.error('[classificados] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao listar classificados.' });
  }
});

/**
 * GET /api/v1/classificados/:id
 * Um único anúncio, pra pré-preencher o formulário de edição com os
 * dados atuais. NUNCA retorna edit_token — esse só é entregue uma vez,
 * na criação/confirmação do pagamento.
 */
app.get('/api/v1/classificados/:id', async (req, res) => {
  const idNum = Number(req.params.id);
  if (!Number.isInteger(idNum)) return res.status(400).json({ erro: 'Id inválido.' });

  try {
    const c = await Classificados.buscarPorId(idNum);
    if (!c || c.status !== 'ativo') return res.status(404).json({ erro: 'Anúncio não encontrado.' });

    res.json({
      id: c.id,
      empresa: c.empresa,
      titulo: c.titulo,
      descricao: c.descricao,
      wpp: c.wpp,
      icone: c.icone,
      expiraEm: c.expira_em,
    });
  } catch (err) {
    console.error('[classificados/:id] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao buscar anúncio.' });
  }
});

/**
 * POST /api/v1/classificados/publicar
 * Recebe dados do anúncio. Decide grátis ou pago baseado na contagem
 * real do backend — nunca confia no localStorage do frontend.
 *
 * Fluxo:
 *   1º anúncio  → publica imediatamente, registra contagem, retorna { gratis: true }
 *   2º+ anúncio → retorna { gratis: false, requerPagamento: true }
 *                 frontend então chama /criar-pix-classificado
 *                 e após aprovação chama /classificados/confirmar/:pagamentoId
 */
app.post('/api/v1/classificados/publicar', limiterCad, async (req, res) => {
  const { empresa, titulo, desc, wpp, icone } = req.body || {};

  // Validação — mesmos critérios do frontend
  const wppLimpo = (wpp || '').replace(/\D/g, '');
  if (!empresa || empresa.trim().length < 2)  return res.status(400).json({ erro: 'Nome da empresa inválido.' });
  if (!titulo  || titulo.trim().length < 5)   return res.status(400).json({ erro: 'Título inválido.' });
  if (!desc    || desc.trim().length < 10)     return res.status(400).json({ erro: 'Descrição inválida.' });
  if (wppLimpo.length < 10)                   return res.status(400).json({ erro: 'WhatsApp inválido.' });

  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
  const identificador = wppLimpo; // canônico = WhatsApp limpo (sem espaços/máscaras)

  try {
    const total = await Classificados.contarPorIdent(identificador);

    if (total >= 1) {
      // Já usou o grátis — frontend deve gerar Pix antes de publicar
      return res.json({
        gratis:           false,
        requerPagamento:  true,
        total,
        mensagem: 'Seu primeiro anúncio grátis já foi usado. Realize o pagamento para publicar.',
      });
    }

    // Primeiro anúncio — publica gratuitamente
    let info;
    try {
      info = await Classificados.criar({
        identificador,
        empresa: san(empresa, 60),
        titulo:  san(titulo, 80),
        descricao: san(desc, 200),
        wpp:     wppLimpo,
        icone:   (icone || '🏪').slice(0, 4),
        pago:    false,
      });
    } catch (err) {
      if (err?.corridaPerdida) {
        // Duas requisições simultâneas passaram pela checagem de contagem
        // ao mesmo tempo — o índice único do banco garantiu que só uma
        // vira grátis. Esta perdeu a corrida; mesma resposta de quando o
        // grátis já tinha sido usado antes.
        return res.json({
          gratis: false, requerPagamento: true, total: 1,
          mensagem: 'Seu primeiro anúncio grátis já foi usado. Realize o pagamento para publicar.',
        });
      }
      throw err;
    }

    console.log(`[classificados] 1º anúncio grátis: ${empresa} (${identificador})`);
    res.status(201).json({ ok: true, gratis: true, id: info.lastInsertRowid, editToken: info.editToken });

  } catch (err) {
    console.error('[classificados/publicar] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao publicar anúncio.' });
  }
});

/**
 * PUT /api/v1/classificados/:id
 * Permite ao anunciante editar o próprio anúncio a qualquer momento —
 * exige o editToken recebido na publicação como prova de posse, no
 * mesmo espírito do upload_token do cadastro de técnico. Não existe
 * conceito de "login de anunciante" no projeto, então esta é a forma
 * de autorizar a edição sem construir um sistema de conta completo.
 */
app.put('/api/v1/classificados/:id', limiterEditarClassificado, async (req, res) => {
  const idNum = Number(req.params.id);
  const { editToken, empresa, titulo, desc, wpp, icone } = req.body || {};

  if (!Number.isInteger(idNum)) return res.status(400).json({ erro: 'Id inválido.' });
  if (!editToken || typeof editToken !== 'string') return res.status(400).json({ erro: 'editToken é obrigatório.' });

  // Mesma validação da criação — não afrouxar critério só porque é edição
  if (empresa !== undefined && empresa.trim().length < 2) return res.status(400).json({ erro: 'Nome da empresa inválido.' });
  if (titulo  !== undefined && titulo.trim().length < 5)  return res.status(400).json({ erro: 'Título inválido.' });
  if (desc    !== undefined && desc.trim().length < 10)   return res.status(400).json({ erro: 'Descrição inválida.' });

  const wppLimpo = wpp !== undefined ? wpp.replace(/\D/g, '') : undefined;
  if (wppLimpo !== undefined && wppLimpo.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido.' });

  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);

  try {
    const existente = await Classificados.buscarPorId(idNum);
    if (!existente) return res.status(404).json({ erro: 'Anúncio não encontrado.' });

    const resultado = await Classificados.atualizar(idNum, editToken, {
      empresa:   empresa   !== undefined ? san(empresa, 60)  : undefined,
      titulo:    titulo    !== undefined ? san(titulo, 80)   : undefined,
      descricao: desc      !== undefined ? san(desc, 200)    : undefined,
      wpp:       wppLimpo,
      icone:     icone     !== undefined ? icone.slice(0, 4) : undefined,
    });

    if (!resultado.ok) {
      // Mesma resposta pra "token errado" e "id inexistente" — não dar
      // pista pra quem estiver tentando adivinhar um token de outro anúncio
      return res.status(403).json({ erro: 'Não autorizado a editar este anúncio.' });
    }

    console.log(`[classificados] Anúncio ${idNum} editado pelo próprio anunciante`);
    res.json({ ok: true });

  } catch (err) {
    console.error('[classificados/editar] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao editar anúncio.' });
  }
});

/**
 * POST /api/v1/classificados/confirmar/:pagamentoId
 * Chamado pelo frontend após polling confirmar pagamento aprovado.
 * Publica o anúncio pendente. Idempotente — múltiplas chamadas com o
 * mesmo pagamentoId não duplicam (Classificados.buscarPorPagamentoId).
 */
app.post('/api/v1/classificados/confirmar/:pagamentoId', async (req, res) => {
  const { pagamentoId } = req.params;
  const { empresa, titulo, desc, wpp, icone } = req.body || {};

  const wppLimpo = (wpp || '').replace(/\D/g, '');
  if (!empresa || !titulo || !desc || wppLimpo.length < 10) {
    return res.status(400).json({ erro: 'Dados do anúncio incompletos.' });
  }

  // Lock em memória — rejeita requisições simultâneas com o mesmo pagamentoId
  if (!_confirmarAdquirirLock(pagamentoId)) {
    return res.status(409).json({ ok: true, duplicata: true,
      mensagem: 'Pagamento já está sendo processado. Aguarde.' });
  }

  try {
    // Idempotência — verifica se este pagamento já publicou um anúncio
    const jaPublicado = await Classificados.buscarPorPagamentoId(pagamentoId);
    if (jaPublicado) {
      _confirmarLiberarLock(pagamentoId);
      return res.json({ ok: true, duplicata: true, id: jaPublicado.id, editToken: jaPublicado.edit_token });
    }

    // Confirmação real junto ao Mercado Pago — nunca publica só porque
    // o pagamentoId "parece" válido. Mesmo mecanismo do webhook/cartão.
    const verificacao = await verificarPagamentoAprovadoMP(pagamentoId, 'pix');
    if (!verificacao.ok) {
      _confirmarLiberarLock(pagamentoId);
      console.warn(`[classificados/confirmar] Bloqueado — ${verificacao.motivo} | pagamentoId: ${pagamentoId}`);
      return res.status(402).json({ erro: 'Pagamento não confirmado.', detalhe: verificacao.motivo });
    }

    const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
    const identificador = wppLimpo;

    const info = await Classificados.criar({
      identificador,
      empresa: san(empresa, 60),
      titulo:  san(titulo, 80),
      descricao: san(desc, 200),
      wpp:     wppLimpo,
      icone:   (icone || '🏪').slice(0, 4),
      pago:    true,
      pagamentoId,
    });

    console.log(`[classificados] Anúncio pago confirmado: ${empresa} (pagamentoId: ${pagamentoId})`);
    res.status(201).json({ ok: true, gratis: false, id: info.lastInsertRowid, editToken: info.editToken });

  } catch (err) {
    console.error('[classificados/confirmar] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao confirmar anúncio.' });
  } finally {
    _confirmarLiberarLock(pagamentoId); // sempre libera, mesmo em erro
  }
});

/**
 * POST /api/v1/classificados/registrar (admin)
 * Mantido por compatibilidade — desde a migração para o banco, a
 * contagem é derivada automaticamente das linhas reais de
 * `classificados` (Classificados.contarPorIdent), então esta rota
 * virou somente leitura: não há mais um contador solto para
 * incrementar manualmente sem criar um anúncio de verdade.
 */
app.post('/api/v1/classificados/registrar', requireAdmin, async (req, res) => {
  try {
    const { identificador } = req.body;
    if (!identificador) return res.status(400).json({ erro: 'Identificador obrigatório.' });
    const total = await Classificados.contarPorIdent(identificador);
    res.json({ ok: true, total, aviso: 'Contagem derivada automaticamente das linhas de classificados — nada foi incrementado manualmente.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao consultar contagem.' });
  }
});

// ══════════════════════════════════════════════════════════════
// AUTENTICAÇÃO ADMIN — sem token no frontend
// ══════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', limiterLogin, async (req, res) => {
  const { email, senha } = req.body || {};

  if (!email || !senha) {
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });
  }

  const emailOk = email.trim().toLowerCase() === ADMIN_EMAIL_BACK.toLowerCase();
  const senhaOk = hashSenha(senha) === ADMIN_SENHA_HASH;

  if (!emailOk || !senhaOk) {
    // Delay de 500ms anti-brute-force
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ erro: 'Credenciais inválidas.' });
  }

  const token    = await AdminSessoes.criar(req.ip || '', ADMIN_SESS_TTL);
  const expiraEm = Date.now() + ADMIN_SESS_TTL;

  // Cookie HttpOnly — não acessível via JavaScript
  res.cookie('agro_admin_sess', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production', // HTTPS em produção
    sameSite: 'strict',
    maxAge:   ADMIN_SESS_TTL,
    path:     '/',
  });

  console.log(`[admin/login] Login bem-sucedido — IP: ${req.ip}`);
  res.json({ ok: true, expiraEm: new Date(expiraEm).toISOString() });
});

// POST /api/admin/logout
app.post('/api/admin/logout', async (req, res) => {
  const token = req.cookies?.agro_admin_sess;
  if (token) await AdminSessoes.revogar(token);
  res.clearCookie('agro_admin_sess', { path: '/' });
  res.json({ ok: true });
});

// GET /api/admin/verificar — frontend checa se sessão ainda é válida ao recarregar
app.get('/api/admin/verificar', async (req, res) => {
  const token = req.cookies?.agro_admin_sess;
  res.json({ logado: !!(token && await AdminSessoes.validar(token)) });
});

// ══════════════════════════════════════════════════════════════
// POST /api/pedidos
// Recebe interesse de produtor em região sem técnico.
// Persistido na tabela `pedidos_tecnico` via PedidosTecnico (db.js) —
// antes gravava em pedidos.json, um arquivo solto que GET /api/admin/
// crescimento também tentava ler separadamente (duas fontes de
// verdade divergentes para o mesmo dado).
// ══════════════════════════════════════════════════════════════

app.post('/api/pedidos', limiterCad, async (req, res) => {
  const { nome, whatsapp, necessidade, cidade, especialidade } = req.body || {};

  const wpp = (whatsapp || '').replace(/\D/g, '');
  if (!nome || nome.trim().length < 2)      return res.status(400).json({ erro: 'Nome inválido.' });
  if (wpp.length < 10)                      return res.status(400).json({ erro: 'WhatsApp inválido.' });
  if (!necessidade || necessidade.trim().length < 5)
    return res.status(400).json({ erro: 'Descrição muito curta.' });

  try {
    const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);

    const info = await PedidosTecnico.criar({
      nome:          san(nome, 100),
      whatsapp:      wpp.slice(0, 11),
      necessidade:   san(necessidade, 400),
      cidade:        san(cidade, 100) || null,
      especialidade: san(especialidade, 60) || null,
    });

    console.log(`[pedidos] Novo pedido: ${san(nome, 100)} — ${san(cidade, 100)}`);
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[pedidos] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao salvar pedido.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// PRODUTOR — Cadastro, Login e Favoritos (sessão real de servidor)
// ─────────────────────────────────────────────────────────────────
// Antes: o cadastro/login do produtor era 100% localStorage no
// navegador (ver auditoria, Achado #1) — nenhum dado sobrevivia à
// troca de aparelho, e o admin nunca via a base real de produtores.
// Agora: mesma arquitetura já usada para técnico e admin — senha
// hasheada (HMAC-SHA256), sessão em tabela própria (produtor_sessoes),
// cookie HttpOnly agro_prod_sess.
// ══════════════════════════════════════════════════════════════════

/**
 * Detecta se o identificador é e-mail ou telefone e valida o formato.
 * Mesma regra usada no frontend (prodValidarIdent em inline-06.js):
 * qualquer string com '@' é e-mail; sem '@', é tratado como telefone.
 */
function validarIdentProdutor(v) {
  if (!v) return { valido: false, tipo: null };
  if (v.includes('@')) {
    return { valido: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), tipo: 'email' };
  }
  const digitos = v.replace(/\D/g, '');
  return { valido: digitos.length >= 10 && digitos.length <= 11, tipo: 'tel' };
}

function hashSenhaGenerica(senha) {
  return crypto
    .createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev')
    .update(senha)
    .digest('hex');
}

/**
 * Monta a resposta pública do produtor autenticado — allow-list
 * explícita, nunca inclui senha_hash. Inclui a lista de tecnico_id
 * favoritados para o frontend sincronizar os corações dos cards.
 */
async function produtorRespostaPublica(produtor) {
  const favoritos = await db.query(
    'SELECT tecnico_id FROM produtor_favoritos WHERE produtor_id = ?',
    [produtor.id]
  );
  return {
    produtorId:       produtor.id,
    nome:             produtor.nome,
    ident:            produtor.identificador,
    tipoIdent:        produtor.tipo_ident,
    aceitouNovidades: !!produtor.aceita_novidades,
    favoritos:        favoritos.map(f => f.tecnico_id),
  };
}

/** Cria a sessão e o cookie HttpOnly compartilhados por cadastro e login. */
async function produtorCriarSessaoECookie(res, produtorId, ip) {
  const { token } = await ProdutorSessoes.criar(produtorId, ip || '');
  res.cookie('agro_prod_sess', token, {
    httpOnly: true,
    secure:   IS_PRODUCTION,
    sameSite: 'strict',
    maxAge:   PRODUTOR_SESS_TTL,
    path:     '/',
  });
}

app.post('/api/v1/produtor/cadastrar', limiterCad, async (req, res) => {
  const { nome, identificador, senha, aceitaNovidades } = req.body || {};

  if (!nome || nome.trim().length < 2) {
    return res.status(400).json({ erro: 'Nome inválido.' });
  }
  const { valido: identValido, tipo: tipoIdent } = validarIdentProdutor((identificador || '').trim());
  if (!identValido) {
    return res.status(400).json({ erro: 'Informe um e-mail ou celular válido.' });
  }
  if (!senha || senha.length < 6) {
    return res.status(400).json({ erro: 'A senha deve ter no mínimo 6 caracteres.' });
  }

  try {
    const identLimpo = identificador.trim().toLowerCase();
    const existente   = await Produtores.buscarPorIdent(identLimpo);
    if (existente) {
      return res.status(409).json({ erro: 'Já existe uma conta com este e-mail/celular. Faça login.' });
    }

    const info = await Produtores.criar({
      nome:             nome.trim().slice(0, 100),
      identificador:    identLimpo,
      tipoIdent,
      senhaHash:        hashSenhaGenerica(senha),
      aceitouNovidades: !!aceitaNovidades,
    });

    await produtorCriarSessaoECookie(res, info.lastInsertRowid, req.ip);
    const produtor = await Produtores.buscarPorId(info.lastInsertRowid);

    console.log(`[produtor/cadastrar] Nova conta — id ${info.lastInsertRowid} (${tipoIdent})`);
    res.status(201).json({ ok: true, ...(await produtorRespostaPublica(produtor)) });

  } catch (err) {
    console.error('[produtor/cadastrar] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao criar conta.' });
  }
});

/** Handler compartilhado entre a rota atual e o alias legado abaixo. */
async function handleProdutorLogin(req, res) {
  const { identificador, senha } = req.body || {};
  if (!identificador || !senha) {
    return res.status(400).json({ erro: 'Identificador e senha são obrigatórios.' });
  }

  try {
    const produtor = await Produtores.buscarPorIdent(identificador.trim());

    if (!produtor || produtor.senha_hash !== hashSenhaGenerica(senha)) {
      // Delay anti-brute-force — mesmo padrão do admin e do técnico
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Identificador ou senha incorretos.' });
    }

    await produtorCriarSessaoECookie(res, produtor.id, req.ip);
    console.log(`[produtor/login] Login bem-sucedido — produtor ${produtor.id} — IP: ${req.ip}`);
    res.json({ ok: true, ...(await produtorRespostaPublica(produtor)) });

  } catch (err) {
    console.error('[produtor/login] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao realizar login.' });
  }
}

app.post('/api/v1/produtor/login', limiterLogin, handleProdutorLogin);
// Alias legado — mantido para não quebrar quem ainda aponta para a URL antiga.
app.post('/api/produtor/login', limiterLogin, handleProdutorLogin);

app.post('/api/v1/produtor/logout', async (req, res) => {
  const token = req.cookies?.agro_prod_sess;
  if (token) await ProdutorSessoes.revogar(token);
  res.clearCookie('agro_prod_sess', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/v1/produtor/verificar', async (req, res) => {
  const token  = req.cookies?.agro_prod_sess;
  const sessao = token ? await ProdutorSessoes.validar(token) : null;
  res.json({ logado: !!sessao, produtorId: sessao ? sessao.produtorId : null });
});

app.get('/api/v1/produtor/me', requireProdutor, async (req, res) => {
  try {
    const produtor = await Produtores.buscarPorId(req.produtorSessao.produtorId);
    if (!produtor) return res.status(404).json({ erro: 'Produtor não encontrado.' });
    res.json(await produtorRespostaPublica(produtor));
  } catch (err) {
    console.error('[produtor/me] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar conta.' });
  }
});

/**
 * POST /api/v1/produtor/favoritos/:tecnicoId — alterna favorito.
 * Requer sessão de produtor autenticado (cookie).
 */
app.post('/api/v1/produtor/favoritos/:tecnicoId', requireProdutor, async (req, res) => {
  try {
    const tecnicoId = Number(req.params.tecnicoId);
    if (!Number.isInteger(tecnicoId)) return res.status(400).json({ erro: 'tecnicoId inválido.' });
    if (!await Tecnicos.buscarPorId(tecnicoId)) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const favoritado = await Produtores.toggleFavorito(req.produtorSessao.produtorId, tecnicoId);
    res.json({ ok: true, favoritado });
  } catch (err) {
    console.error('[produtor/favoritos] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar favorito.' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/crescimento
// Retorna dados reais para o gráfico de barras do painel admin.
// Lê exclusivamente do banco (Tecnicos, Pagamentos, PedidosTecnico) —
// antes lia de tecnicos.json/pedidos.json, arquivos que não são mais
// escritos por nenhuma rota, então o gráfico e as métricas do admin
// nunca batiam com os números reais das tabelas.
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/crescimento', requireAdmin, async (req, res) => {
  try {
    const [tecnicosPorMes, aprovadosPorMes, todosTecnicos, totalPremiumAprovados, totalPedidos] = await Promise.all([
      Tecnicos.contarPorMes(6),
      Pagamentos.aprovadosPorMes(6),
      Tecnicos.listarTodosAdmin(),
      Pagamentos.totalAprovados(),
      PedidosTecnico.contarTotal(),
    ]);

    const mapaTecnicos  = Object.fromEntries(tecnicosPorMes.map(r => [r.mes, Number(r.total)]));
    const mapaAprovados = Object.fromEntries(aprovadosPorMes.map(r => [r.mes, Number(r.total)]));

    const agora    = new Date();
    const meses    = [];
    const totais   = [];
    const premiums = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      const mesLabel = d.toLocaleDateString('pt-BR', { month: 'short' });
      const mesISO   = d.toISOString().slice(0, 7); // 'YYYY-MM'

      meses.push(mesLabel);
      totais.push(mapaTecnicos[mesISO] || 0);
      premiums.push(mapaAprovados[mesISO] || 0);
    }

    res.json({
      meses,
      totais,
      premiums,
      resumo: {
        total_tecnicos: todosTecnicos.length,
        ativos:         todosTecnicos.filter(t => t.status === 'ativo').length,
        premium_ativo:  totalPremiumAprovados,
        total_pedidos:  totalPedidos,
      },
    });
  } catch (err) {
    console.error('[crescimento] Erro:', err?.message);
    res.status(500).json({ erro: 'Erro ao carregar métricas.' });
  }
});

// ── Alias de compatibilidade — frontend usa /api/v1/preco-premium
// A rota foi renomeada para /api/v1/config/precos mas o frontend
// ainda chama a URL antiga em carregarPrecoPremium()
app.get('/api/v1/preco-premium', async (req, res) => {
  try {
    const p = await precosCfgLer();
    res.json({ valor: p.premium, formatado: `R$ \${p.premium.toFixed(2).replace('.', ',')}` });
  } catch {
    res.json({ valor: 49.90, formatado: 'R$ 49,90' });
  }
});

// ── Health check ───────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // Checagem de liveness (processo rodando) já bastava antes. Agora
  // também verifica readiness (banco realmente acessível) — sem isso,
  // uma DATABASE_URL quebrada em produção faria o processo subir normal,
  // responder 200 aqui, e só falhar na primeira requisição real de um
  // usuário. O deploy zero-downtime do Render depende deste endpoint
  // pra decidir se roteia tráfego pra uma instância nova — combinado com
  // detecção de falha, o rollback automático dele funciona de verdade.
  try {
    await Promise.race([
      db.queryOne('SELECT 1 AS ok'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    res.json({ status: 'ok', env: NODE_ENV, porta: Number(PORT), db: 'ok' });
  } catch (err) {
    console.error('[health] Banco inacessível:', err?.message || err);
    res.status(503).json({ status: 'erro', env: NODE_ENV, porta: Number(PORT), db: 'inacessível' });
  }
});

// ══════════════════════════════════════════════════════════════════
// SEO — robots.txt e sitemap.xml dinâmico
//
// robots.txt:
//   Permite todos os crawlers. Bloqueia rotas de API e admin.
//   Aponta para o sitemap.
//
// sitemap.xml:
//   Gerado dinamicamente a partir de tecnicos.json.
//   Inclui: homepage, páginas de estado, cidade e especialidade.
//   Cache em memória de 1 hora — evita releitura de disco a cada crawl.
//   TTL controlado por SITEMAP_CACHE_TTL_MS no .env (opcional).
//
// Variável de ambiente necessária no .env:
//   SITE_URL=https://www.agrotecnico.com.br
//   (sem barra final)
// ══════════════════════════════════════════════════════════════════

// ── Mapa de especialidades: slug da URL → nome legível ─────────────
// Os slugs são os mesmos valores armazenados no campo `especialidades`
// dos técnicos. O nome legível vai para a <loc> descritiva futura e
// é usado apenas para derivar o slug da URL aqui.
const ESP_SLUGS = {
  solo:  'analise-de-solo',
  fito:  'fitossanidade',
  irrig: 'irrigacao',
  past:  'manejo-de-pastagens',
  nutr:  'nutricao-de-culturas',
  anim:  'nutricao-animal',
  frut:  'fruticultura',
  oler:  'olericultura',
  drone: 'pulverizacao-com-drone',
  trator: 'operacao-de-maquinas-agricolas',
  maquinario: 'monitoramento-de-maquinario',
  ia:    'inseminacao-artificial',
  iatf:  'inseminacao-artificial-tempo-fixo',
  rebanho: 'manejo-de-rebanho',
  insumos: 'controle-de-insumos-e-estoque',
};

// Inverso: slug da URL → chave interna. Usado na validação do sitemap.
const ESP_SLUGS_INVERSO = Object.fromEntries(
  Object.entries(ESP_SLUGS).map(([chave, slug]) => [slug, chave])
);

/**
 * Converte um nome de cidade para slug de URL.
 * "Cacoal"          → "cacoal"
 * "Ji-Paraná"       → "ji-parana"
 * "Ouro Preto do Oeste" → "ouro-preto-do-oeste"
 * "Espigão d'Oeste" → "espigao-d-oeste"
 *
 * Regras:
 *   1. Caixa baixa
 *   2. Remove acentos (NFD + strip combining chars)
 *   3. Substitui espaços e hifens múltiplos por hífen único
 *   4. Converte apóstrofos em hífen; remove demais chars não alfanuméricos
 *   5. Remove hifens no início ou fim
 */
function cidadeParaSlug(nome) {
  return (nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // remove diacríticos
    .replace(/['‘’ʼ`]/g, '-') // apóstrofos (ASCII, tipográfico, modifier) → hífen
    .replace(/[^a-z0-9\s-]/g, '')      // remove chars especiais
    .trim()
    .replace(/[\s-]+/g, '-')           // espaços/hifens → hífen único
    .replace(/^-+|-+$/g, '');          // remove hifens nas bordas
}

/**
 * Extrai pares únicos de { uf, cidade, especialidades } dos técnicos
 * ativos — usado para montar o sitemap.xml dinâmico.
 * Migrado do JSON (TECNICOS_FILE) para Tecnicos.listar() (db.js) no
 * subtópico 4.6. Tecnicos.listar() já filtra status='ativo' AND
 * ativo=1 na própria query SQL.
 *
 * @returns {Promise<Array<{ uf: string, cidade: string, esps: string[] }>>}
 */
async function sitemapLerTecnicos() {
  try {
    return (await Tecnicos.listar({}))
      .map(t => {
        let esps = [];
        try { esps = JSON.parse(t.especialidades || '[]'); } catch { esps = []; }
        return {
          uf:     (t.uf || '').toUpperCase(),
          cidade: (t.cidade || '').trim(),
          esps:   esps.filter(e => ESP_SLUGS[e]),  // só especialidades mapeadas
        };
      })
      .filter(t => t.uf.length === 2 && t.cidade.length > 0);
  } catch {
    // Banco vazio (instância nova) — sitemap só com homepage
    return [];
  }
}

/**
 * Gera o XML do sitemap a partir dos dados dos técnicos.
 * Deduplica estados, cidades e pares cidade+especialidade.
 *
 * Prioridades por nível (convenção Google):
 *   homepage             → 1.0
 *   página de estado     → 0.8
 *   página de cidade     → 0.7  (DESATIVADO — rota ainda não existe)
 *   página de esp.       → 0.6  (DESATIVADO — rota ainda não existe)
 *
 * changefreq:
 *   homepage e estado    → weekly  (conteúdo agrega novos técnicos)
 *   cidade e esp.        → monthly (muda menos)
 *
 * lastmod: data atual no formato YYYY-MM-DD (recomendação Google).
 *
 * SITEMAP_INCLUIR_CIDADES / SITEMAP_INCLUIR_CIDADE_ESP controlam quais
 * blocos são emitidos no XML. A coleta (estados/cidades/cidadeEsps) continua
 * completa independente das flags — reativar basta trocar para true.
 */
// true quando GET /tecnicos/:uf/:cidade existir no servidor
const SITEMAP_INCLUIR_CIDADES    = false;
// true quando GET /tecnicos/:uf/:cidade/:especialidade existir no servidor
const SITEMAP_INCLUIR_CIDADE_ESP = false;

function sitemapGerarXML(baseUrl, tecnicos) {
  const hoje = new Date().toISOString().slice(0, 10);

  // Coleta deduplicada por estado
  const estados = new Set();
  // Coleta deduplicada por "UF|cidade"
  const cidades = new Set();
  // Coleta deduplicada por "UF|cidade|esp-slug"
  const cidadeEsps = new Set();

  for (const t of tecnicos) {
    const uf        = t.uf.toLowerCase();
    const cidSlug   = cidadeParaSlug(t.cidade);
    const cidKey    = `${uf}|${cidSlug}`;

    estados.add(uf);
    cidades.add(cidKey);

    for (const esp of t.esps) {
      const espSlug = ESP_SLUGS[esp];
      if (espSlug) cidadeEsps.add(`${cidKey}|${espSlug}`);
    }
  }

  // Função auxiliar que escapa os 5 chars especiais do XML
  const esc = v => v
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');

  // Constrói entradas do sitemap
  const entradas = [];

  // 1. Homepage
  entradas.push(
    `  <url>\n` +
    `    <loc>${esc(baseUrl)}/</loc>\n` +
    `    <lastmod>${hoje}</lastmod>\n` +
    `    <changefreq>weekly</changefreq>\n` +
    `    <priority>1.0</priority>\n` +
    `  </url>`
  );

  // 2. Páginas de estado — /tecnicos/ro, /tecnicos/mt …
  for (const uf of [...estados].sort()) {
    entradas.push(
      `  <url>\n` +
      `    <loc>${esc(baseUrl)}/tecnicos/${uf}</loc>\n` +
      `    <lastmod>${hoje}</lastmod>\n` +
      `    <changefreq>weekly</changefreq>\n` +
      `    <priority>0.8</priority>\n` +
      `  </url>`
    );
  }

  // 3. Páginas de cidade — /tecnicos/ro/cacoal …
  // DESATIVADO: rota ainda não existe. Coleta em `cidades` permanece ativa.
  if (SITEMAP_INCLUIR_CIDADES) {
    for (const cidKey of [...cidades].sort()) {
      const [uf, cidSlug] = cidKey.split('|');
      entradas.push(
        `  <url>\n` +
        `    <loc>${esc(baseUrl)}/tecnicos/${uf}/${cidSlug}</loc>\n` +
        `    <lastmod>${hoje}</lastmod>\n` +
        `    <changefreq>monthly</changefreq>\n` +
        `    <priority>0.7</priority>\n` +
        `  </url>`
      );
    }
  }

  // 4. Páginas de cidade + especialidade — /tecnicos/ro/cacoal/analise-de-solo …
  // DESATIVADO: rota ainda não existe. Coleta em `cidadeEsps` permanece ativa.
  if (SITEMAP_INCLUIR_CIDADE_ESP) {
    for (const ceKey of [...cidadeEsps].sort()) {
      const [uf, cidSlug, espSlug] = ceKey.split('|');
      entradas.push(
        `  <url>\n` +
        `    <loc>${esc(baseUrl)}/tecnicos/${uf}/${cidSlug}/${espSlug}</loc>\n` +
        `    <lastmod>${hoje}</lastmod>\n` +
        `    <changefreq>monthly</changefreq>\n` +
        `    <priority>0.6</priority>\n` +
        `  </url>`
      );
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entradas.join('\n') + '\n' +
    `</urlset>\n`
  );
}

// ── Cache em memória do sitemap ────────────────────────────────────
// Evita releitura de tecnicos.json a cada request de crawler.
// TTL padrão: 1 hora. Configurável via SITEMAP_CACHE_TTL_MS no .env.
const SITEMAP_CACHE_TTL = parseInt(process.env.SITEMAP_CACHE_TTL_MS || '') || 60 * 60 * 1000;

let _sitemapCache     = null;   // string XML ou null
let _sitemapCacheTime = 0;      // Date.now() do último build

/**
 * Retorna o XML do sitemap, usando cache se válido.
 * Invalida o cache automaticamente após TTL.
 */
async function sitemapObter(baseUrl) {
  const agora = Date.now();
  if (_sitemapCache && agora - _sitemapCacheTime < SITEMAP_CACHE_TTL) {
    return _sitemapCache;
  }
  const tecnicos      = await sitemapLerTecnicos();
  _sitemapCache       = sitemapGerarXML(baseUrl, tecnicos);
  _sitemapCacheTime   = agora;
  console.log(`[sitemap] Regenerado — ${tecnicos.length} técnico(s) ativos`);
  return _sitemapCache;
}

// ── GET /robots.txt ────────────────────────────────────────────────
//
// Permite todos os crawlers legítimos no conteúdo público.
// Bloqueia explicitamente as rotas de API, admin e upload que não
// devem ser indexadas (expõem dados sensíveis ou são dinâmicas demais).
// Aponta para o sitemap para que o Google o descubra automaticamente.
//
// Não usa express-rate-limit aqui: robots.txt é um arquivo estático
// com cache HTTP de 24h — o Googlebot raramente o busca mais de 1x/dia.
app.get('/robots.txt', (req, res) => {
  const baseUrl = process.env.SITE_URL || `https://www.agrotecnico.com.br`;

  const corpo = [
    'User-agent: *',
    'Allow: /',
    '',
    '# Bloqueia rotas de API — não há conteúdo útil para indexar',
    'Disallow: /api/',
    '',
    '# Bloqueia painel administrativo',
    'Disallow: /admin',
    '',
    '# Bloqueia health check interno',
    'Disallow: /health',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
  ].join('\n');

  res
    .set('Content-Type', 'text/plain; charset=utf-8')
    .set('Cache-Control', 'public, max-age=86400')   // 24 horas — robots.txt muda raramente
    .send(corpo);
});

// ── GET /sitemap.xml ───────────────────────────────────────────────
//
// Sitemap dinâmico gerado a partir de tecnicos.json.
// Cache em memória de 1 hora (SITEMAP_CACHE_TTL_MS no .env).
// Cache HTTP de 1 hora para CDN/proxy.
//
// Estrutura de URLs geradas:
//   /                                          homepage
//   /tecnicos/:uf                              estado   (ex: /tecnicos/ro)
//   /tecnicos/:uf/:cidade                      cidade   (ex: /tecnicos/ro/cacoal)
//   /tecnicos/:uf/:cidade/:especialidade       esp.     (ex: /tecnicos/ro/cacoal/analise-de-solo)
//
// Se tecnicos.json não existir (MVP sem técnicos), retorna sitemap
// apenas com a homepage — sem erro, sem crash.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = process.env.SITE_URL || `https://www.agrotecnico.com.br`;
    const xml     = await sitemapObter(baseUrl);

    res
      .set('Content-Type', 'application/xml; charset=utf-8')
      .set('Cache-Control', 'public, max-age=3600')  // 1 hora — alinhado com TTL do cache interno
      .send(xml);
  } catch (err) {
    // Falha no sitemap nunca deve derrubar o servidor — responde com sitemap mínimo
    console.error('[sitemap] Erro ao gerar:', err?.message || err);
    const baseUrl = process.env.SITE_URL || `https://www.agrotecnico.com.br`;
    const hoje    = new Date().toISOString().slice(0, 10);
    res
      .set('Content-Type', 'application/xml; charset=utf-8')
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url>\n` +
        `    <loc>${baseUrl}/</loc>\n` +
        `    <lastmod>${hoje}</lastmod>\n` +
        `    <changefreq>weekly</changefreq>\n` +
        `    <priority>1.0</priority>\n` +
        `  </url>\n` +
        `</urlset>\n`
      );
  }
});


// ══════════════════════════════════════════════════════════════════
// SSR — GET /tecnicos/:uf
// Página pública de técnicos por estado, para indexação pelo Google.
// Fonte: tecnicos.json (dados reais). Filtra: ativo===true && statusValidacao==='ativo'.
// Retorna HTML completo com title, meta description e canonical por UF.
// Não reutiliza GET /api/v1/tecnicos. Não usa TECNICOS_DEMO.
// ══════════════════════════════════════════════════════════════════

// Lista canônica das 27 UFs brasileiras (IBGE)
const UFS_BRASIL = new Set([
  'AC','AL','AM','AP','BA','CE','DF','ES','GO',
  'MA','MG','MS','MT','PA','PB','PE','PI','PR',
  'RJ','RN','RO','RR','RS','SC','SE','SP','TO',
]);

// Nomes completos para exibição e SEO
const UF_NOMES = {
  AC:'Acre', AL:'Alagoas', AM:'Amazonas', AP:'Amapá', BA:'Bahia',
  CE:'Ceará', DF:'Distrito Federal', ES:'Espírito Santo', GO:'Goiás',
  MA:'Maranhão', MG:'Minas Gerais', MS:'Mato Grosso do Sul',
  MT:'Mato Grosso', PA:'Pará', PB:'Paraíba', PE:'Pernambuco',
  PI:'Piauí', PR:'Paraná', RJ:'Rio de Janeiro', RN:'Rio Grande do Norte',
  RO:'Rondônia', RR:'Roraima', RS:'Rio Grande do Sul', SC:'Santa Catarina',
  SE:'Sergipe', SP:'São Paulo', TO:'Tocantins',
};

// Mapa: chave interna de especialidade → rótulo legível
const ESP_ROTULOS = {
  solo:  'Análise de Solo',
  fito:  'Fitossanidade',
  irrig: 'Irrigação',
  past:  'Manejo de Pastagens',
  nutr:  'Nutrição de Culturas',
  anim:  'Nutrição Animal e Consultoria Veterinária',
  frut:  'Fruticultura',
  oler:  'Olericultura',
  drone: 'Pulverização com Drone Agrícola',
  trator: 'Operação de Máquinas e Tratores Agrícolas',
  maquinario: 'Monitoramento de Maquinário: agendamento de manutenção preventiva e cálculo de horas de uso',
  ia:    'Inseminação Artificial',
  iatf:  'Inseminação Artificial em Tempo Fixo (IATF)',
  rebanho: 'Manejo de Rebanho (Pecuária): pesagem, vacinação, histórico reprodutivo, genealogia e rastreabilidade',
  insumos: 'Controle de Insumos e Estoque: mapeamento de sementes, fertilizantes, combustíveis e ferramentas',
};

/**
 * Escapa os 5 caracteres especiais de HTML.
 * Usada em TODAS as interpolações de dados vindos do cadastro.
 */
function ssrEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/tecnicos/:uf', async (req, res) => {
  // 1. Validar UF
  const uf = (req.params.uf || '').toUpperCase();
  if (!UFS_BRASIL.has(uf)) {
    return res.status(404).type('text/plain').send('Estado inválido.');
  }

  // 2. Ler técnicos reais — Tecnicos.listar({ uf }) já filtra
  // ativo=1 AND status='ativo' AND uf=? na própria query SQL.
  const tecnicos = await Tecnicos.listar({ uf });

  // 3. Sem técnicos ativos nessa UF → 404
  if (tecnicos.length === 0) {
    return res.status(404).type('text/plain')
      .send(`Nenhum técnico ativo encontrado em ${UF_NOMES[uf] || uf}.`);
  }

  // 4. Montar HTML SSR
  const nomeEstado   = ssrEsc(UF_NOMES[uf] || uf);
  const total        = tecnicos.length;
  const baseUrl      = process.env.SITE_URL || 'https://www.agrotecnico.com.br';
  const canonicalUrl = ssrEsc(`${baseUrl}/tecnicos/${uf.toLowerCase()}`);

  const itens = tecnicos.map(t => {
    let esps = [];
    try { esps = JSON.parse(t.especialidades || '[]'); } catch { /* ok */ }
    const espsTxt = esps.map(e => ssrEsc(ESP_ROTULOS[e] || e)).join(', ') || '—';

    return `<li>
      <strong>${ssrEsc(t.nome)}</strong><br>
      Cidade: ${ssrEsc(t.cidade)} — ${ssrEsc(t.uf)}<br>
      Formação: ${ssrEsc(t.formacao || '—')}<br>
      Conselho: ${ssrEsc(t.conselho || '—')}<br>
      Registro: ${ssrEsc(t.registro_completo || t.num_conselho || '—')}<br>
      Especialidades: ${espsTxt}
    </li>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Técnicos Agrícolas em ${nomeEstado} | AgroTécnico</title>
<meta name="description" content="Encontre agrônomos, técnicos agrícolas e veterinários em ${nomeEstado}. ${total} profissional${total !== 1 ? 'is' : ''} disponível${total !== 1 ? 'is' : ''} no AgroTécnico.">
<link rel="canonical" href="${canonicalUrl}">
</head>
<body>
<h1>Técnicos Agrícolas em ${nomeEstado}</h1>
<p>${total} profissional${total !== 1 ? 'is' : ''} ativo${total !== 1 ? 's' : ''} encontrado${total !== 1 ? 's' : ''}.</p>
<ul>
${itens}
</ul>
</body>
</html>`;

  res.status(200).type('text/html; charset=utf-8').send(html);
});

// ══════════════════════════════════════════════════════════════
// AUTENTICAÇÃO TÉCNICO
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/v1/tecnico/me
 * Retorna os dados do técnico autenticado.
 * Nunca expõe segredos internos (upload_token, senha_hash, doc_path) —
 * resposta é uma allow-list explícita, igual ao padrão adotado em
 * sanitizarTecnicoPublico() (subtópico 4.2).
 */
app.get('/api/v1/tecnico/me', requireTecnico, async (req, res) => {
  try {
    const tecnico = await Tecnicos.buscarPorId(req.tecnicoSessao.tecnicoId);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    let especialidades = [];
    try { especialidades = JSON.parse(tecnico.especialidades || '[]'); } catch { /* ok */ }
    let servicosLista = [];
    try { servicosLista = JSON.parse(tecnico.servicos || '[]'); } catch { /* ok */ }

    const totalFavoritos = await Tecnicos.contarFavoritadoPor(tecnico.id);

    res.json({
      id:               tecnico.id,
      publicId:         tecnico.public_id,
      nome:             tecnico.nome,
      fotoUrl:          storageR2.urlPublicaAvatar(tecnico.foto_path),
      whatsapp:         tecnico.whatsapp,
      telefone:         tecnico.telefone || null,
      email:            tecnico.email,
      cidade:           tecnico.cidade,
      uf:               tecnico.uf,
      endereco:         tecnico.endereco || null,
      cep:              tecnico.cep || null,
      bio:              tecnico.bio,
      formacao:         tecnico.formacao,
      conselho:         tecnico.conselho,
      numConselho:      tecnico.num_conselho,
      ufConselho:       tecnico.uf_conselho,
      registroCompleto: tecnico.registro_completo,
      verificadoPorConselho: !!tecnico.conselho,
      especialidades,
      experiencia:      tecnico.experiencia || null,
      servicos:         servicosLista,
      raio:             tecnico.raio_km,
      servico:          tecnico.servico,
      redesSociais: {
        instagram: tecnico.instagram || null,
        facebook:  tecnico.facebook  || null,
        linkedin:  tecnico.linkedin  || null,
      },
      sitePessoal:      tecnico.site_pessoal || null,
      statusValidacao:  tecnico.status,
      ativo:            !!tecnico.ativo,
      premium:          premiumEfetivo(tecnico),
      premiumExpiraEm:  tecnico.premium_expira_em || null,
      premiumDesde:     tecnico.premium_desde || null,
      mediaAvaliacoes:  tecnico.media_avaliacoes || null,
      totalAvaliacoes:  tecnico.total_avaliacoes || 0,
      totalFavoritos,
      visualizacoes:    tecnico.visualizacoes    || 0,
      cliquesWhatsapp:  tecnico.cliques_whatsapp || 0,
      cliquesTelefone:  tecnico.cliques_telefone || 0,
      impressoesBusca:  tecnico.impressoes_busca || 0,
      configuracoes: {
        visivel:        tecnico.visivel        === undefined ? true : !!tecnico.visivel,
        notifEmail:     tecnico.notif_email    === undefined ? true : !!tecnico.notif_email,
        notifWhatsapp:  tecnico.notif_whatsapp === undefined ? true : !!tecnico.notif_whatsapp,
      },
      cadastradoEm:     tecnico.criado_em,
      validadoEm:       tecnico.validado_em      || null,
      ultimoAcesso:     tecnico.ultimo_acesso     || null,
      docEnviadoEm:     tecnico.doc_enviado_em    || null,
      docOriginalName:  tecnico.doc_original_name || null,
    });
  } catch (err) {
    console.error('[tecnico/me] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar perfil.' });
  }
});

/**
 * GET /api/v1/tecnico/dashboard
 * Resumo MVP do técnico autenticado — sem dados sensíveis.
 */
app.get('/api/v1/tecnico/dashboard', requireTecnico, async (req, res) => {
  try {
    const tecnico = await Tecnicos.buscarPorId(req.tecnicoSessao.tecnicoId);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    res.json({
      nome:            tecnico.nome,
      statusValidacao: tecnico.status,
      premium:         premiumEfetivo(tecnico),
      premiumExpiraEm: tecnico.premium_expira_em || null,
      ativo:           !!tecnico.ativo,
      cadastradoEm:    tecnico.criado_em,
      validadoEm:      tecnico.validado_em      || null,
      totalAvaliacoes: tecnico.total_avaliacoes || 0,
      mediaAvaliacoes: tecnico.media_avaliacoes || null,
    });
  } catch (err) {
    console.error('[tecnico/dashboard] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar dashboard.' });
  }
});

/**
 * GET /api/v1/tecnico/premium
 * Retorna o status Premium do técnico autenticado, a partir da data de
 * expiração real gravada no banco (premium_expira_em) — renovada a cada
 * pagamento aprovado (ver Tecnicos.ativarPremiumPorId em db.js).
 */
app.get('/api/v1/tecnico/premium', requireTecnico, async (req, res) => {
  try {
    const tecnico = await Tecnicos.buscarPorId(req.tecnicoSessao.tecnicoId);
    if (!tecnico) return res.status(404).json({ erro: 'Tecnico nao encontrado.' });

    const premiumAte = tecnico.premium_expira_em || null;
    let diasRestantes = null;
    if (premiumAte) {
      const diff = new Date(premiumAte).getTime() - Date.now();
      diasRestantes = diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
    }

    res.json({
      premium:       premiumEfetivo(tecnico),
      premiumDesde:  tecnico.premium_desde || null,
      premiumAte,
      diasRestantes,
    });

  } catch (err) {
    console.error('[tecnico/premium] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar status Premium.' });
  }
});

/**
 * GET /api/v1/tecnico/oportunidades
 * Retorna demandas ativas para o tecnico autenticado.
 * Demandas compativeis (por especialidade ou UF) aparecem primeiro.
 * Mesmo filtro de campos da rota publica GET /api/v1/demandas:
 * nunca expoe wpp, email ou ip — dados de contato sao privados.
 * Limitado a 20 registros mais recentes por grupo (compativeis + demais).
 */
app.get('/api/v1/tecnico/oportunidades', requireTecnico, async (req, res) => {
  try {
    const tecnico = await Tecnicos.buscarPorId(req.tecnicoSessao.tecnicoId);

    let especialidadesTec = [];
    try { especialidadesTec = JSON.parse(tecnico?.especialidades || '[]'); } catch { /* ok */ }

    // Monta lista de termos de compatibilidade a partir das especialidades do técnico
    // Usa ESP_ROTULOS para converter chaves ('solo', 'fito'...) em rótulos legíveis
    const termosEsp = especialidadesTec.map(e => (ESP_ROTULOS[e] || e).toLowerCase()).filter(Boolean);
    const ufTecnico = tecnico?.uf?.toUpperCase() || '';

    /**
     * Verifica se uma demanda é compatível com o técnico autenticado.
     * Compatível se: cultura ou descrição contém termo da especialidade,
     * ou UF da demanda coincide com UF do técnico.
     */
    function ehCompativel(d) {
      if (!termosEsp.length && !ufTecnico) return false;
      if (ufTecnico && d.uf?.toUpperCase() === ufTecnico) return true;
      const texto = `${d.cultura} ${d.descricao}`.toLowerCase();
      return termosEsp.some(t => texto.includes(t));
    }

    // Demandas.listarAtivas() já retorna sem wpp/email/ip (SELECT
    // explícito) e ordenada por criado_em DESC.
    const ativas = await Demandas.listarAtivas();

    // Se não houver especialidades cadastradas, comportamento original
    const semEspecialidades = termosEsp.length === 0 && !ufTecnico;

    const compativeis   = semEspecialidades ? [] : ativas.filter(d =>  ehCompativel(d));
    const naoCompativeis= semEspecialidades ? ativas : ativas.filter(d => !ehCompativel(d));

    const demandas = [...compativeis, ...naoCompativeis]
      .slice(0, 20)
      .map(d => ({ ...d, compativel: semEspecialidades ? undefined : ehCompativel(d) }));

    res.json({ total: demandas.length, demandas });

  } catch (err) {
    console.error('[tecnico/oportunidades] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar oportunidades.' });
  }
});

/**
 * GET /api/v1/tecnico/avaliacoes
 * Retorna as avaliações do técnico autenticado. Usa Avaliacoes.
 * listarPorTecnico() (db.js) — o repositório já exclui o ip da consulta
 * SQL (SELECT explícito sem ip_hash), então não há necessidade de
 * filtrar campo por campo como no modelo JSON anterior.
 */
app.get('/api/v1/tecnico/avaliacoes', requireTecnico, async (req, res) => {
  try {
    const avsDb = await Avaliacoes.listarPorTecnico(req.tecnicoSessao.tecnicoId);
    const avaliacoes = avsDb.map(a => ({ id: a.id, autor: a.autor_nome, texto: a.texto, stars: a.nota, data: a.criado_em }));
    const media = avsDb.length ? calcularMedia(avsDb) : null;

    res.json({ media, total: avsDb.length, avaliacoes });

  } catch (err) {
    console.error('[tecnico/avaliacoes] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar avaliacoes.' });
  }
});

/**
 * GET /api/v1/tecnico/estatisticas
 * Retorna contadores de interação do técnico autenticado.
 */
app.get('/api/v1/tecnico/estatisticas', requireTecnico, async (req, res) => {
  try {
    const idNum   = req.tecnicoSessao.tecnicoId;
    const tecnico = await Tecnicos.buscarPorId(idNum);
    if (!tecnico) return res.status(404).json({ erro: 'Tecnico nao encontrado.' });

    const [totalFavoritos, evolucaoMensal] = await Promise.all([
      Tecnicos.contarFavoritadoPor(idNum),
      TecnicoMetricas.evolucaoMensal(idNum, 6),
    ]);

    res.json({
      visualizacoes:   tecnico.visualizacoes    || 0,
      cliquesWhatsapp: tecnico.cliques_whatsapp || 0,
      cliquesTelefone: tecnico.cliques_telefone || 0,
      cliquesEmail:    tecnico.cliques_email    || 0,
      impressoesBusca: tecnico.impressoes_busca || 0,
      totalFavoritos,
      evolucaoMensal, // [{ mes, visualizacoes, cliquesWhatsapp, cliquesTelefone, impressoesBusca }]
    });

  } catch (err) {
    console.error('[tecnico/estatisticas] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar estatisticas.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/perfil
 * Atualiza os campos de perfil do técnico autenticado — nome,
 * localização (cidade/uf/endereço/CEP), raio de atendimento, formação,
 * experiência, bio, redes sociais e site pessoal. Campos não enviados
 * são preservados; nenhum campo é obrigatório nesta rota (o cliente
 * envia só o que mudou).
 */
app.put('/api/v1/tecnico/me/perfil', requireTecnico, async (req, res) => {
  const {
    nome, cidade, uf, endereco, cep, raio, formacao, experiencia, bio,
    instagram, facebook, linkedin, sitePessoal,
  } = req.body || {};

  const camposRecebidos = [
    nome, cidade, uf, endereco, cep, raio, formacao, experiencia, bio,
    instagram, facebook, linkedin, sitePessoal,
  ];
  if (camposRecebidos.every(v => v === undefined)) {
    return res.status(400).json({ erro: 'Informe ao menos um campo para atualizar.' });
  }

  // Sanitizacao — mesmo padrao do cadastro
  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);

  const payload = {};
  if (nome        !== undefined) payload.nome        = san(nome, 100);
  if (cidade      !== undefined) payload.cidade      = san(cidade, 100);
  if (uf          !== undefined) payload.uf          = san(uf, 2).toUpperCase();
  if (endereco    !== undefined) payload.endereco    = san(endereco, 200);
  if (cep         !== undefined) payload.cep         = san(cep, 9);
  if (formacao    !== undefined) payload.formacao    = san(formacao, 50);
  if (experiencia !== undefined) payload.experiencia = san(experiencia, 800);
  if (bio         !== undefined) payload.bio         = san(bio, 800);
  if (instagram   !== undefined) payload.instagram   = san(instagram, 60).replace(/^@/, '');
  if (facebook    !== undefined) payload.facebook    = san(facebook, 100);
  if (linkedin    !== undefined) payload.linkedin    = san(linkedin, 100);
  if (sitePessoal !== undefined) payload.sitePessoal = san(sitePessoal, 150);
  if (raio        !== undefined) {
    const raioNum = parseInt(raio);
    if (!Number.isInteger(raioNum) || raioNum < 0 || raioNum > 9999) {
      return res.status(400).json({ erro: 'Raio de atendimento inválido.' });
    }
    payload.raio = raioNum;
  }

  if (payload.nome !== undefined && payload.nome.length < 2) {
    return res.status(400).json({ erro: 'Nome inválido.' });
  }
  if (payload.bio !== undefined && payload.bio.length < 10) {
    return res.status(400).json({ erro: 'Bio muito curta (mín. 10 caracteres).' });
  }
  if (payload.formacao !== undefined && payload.formacao.length < 2) {
    return res.status(400).json({ erro: 'Formação inválida.' });
  }
  if (payload.uf !== undefined && payload.uf.length !== 2) {
    return res.status(400).json({ erro: 'UF inválida.' });
  }

  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    if (!await Tecnicos.buscarPorId(idNum)) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    await Tecnicos.atualizarPerfilEstendido(idNum, payload);
    const tecnico = await Tecnicos.buscarPorId(idNum);
    console.log(`[tecnico/me/perfil] Perfil atualizado — técnico ${idNum}`);

    res.json({
      ok:          true,
      nome:        tecnico.nome,
      cidade:      tecnico.cidade,
      uf:          tecnico.uf,
      endereco:    tecnico.endereco,
      cep:         tecnico.cep,
      raio:        tecnico.raio_km,
      bio:         tecnico.bio,
      formacao:    tecnico.formacao,
      experiencia: tecnico.experiencia || null,
      redesSociais: {
        instagram: tecnico.instagram || null,
        facebook:  tecnico.facebook  || null,
        linkedin:  tecnico.linkedin  || null,
      },
      sitePessoal: tecnico.site_pessoal || null,
      mensagem:    'Perfil atualizado com sucesso.',
    });

  } catch (err) {
    console.error('[tecnico/me/perfil] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar perfil.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/especialidades
 * Substitui o array de especialidades do tecnico autenticado.
 * Remove entradas vazias e duplicadas. Limite: 20 itens.
 */
app.put('/api/v1/tecnico/me/especialidades', requireTecnico, async (req, res) => {
  const { especialidades } = req.body || {};

  if (!Array.isArray(especialidades)) {
    return res.status(400).json({ erro: 'Campo "especialidades" deve ser um array.' });
  }

  // Remove vazios, sanitiza, deduplica e limita a 20 itens
  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
  const lista = [...new Set(
    especialidades
      .map(e => san(String(e), 60))
      .filter(e => e.length > 0)
  )].slice(0, 20);

  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    if (!await Tecnicos.buscarPorId(idNum)) return res.status(404).json({ erro: 'Tecnico nao encontrado.' });

    await Tecnicos.atualizarEspecialidades(idNum, lista);
    console.log(`[tecnico/me/especialidades] Atualizado — tecnico ${idNum} — ${lista.length} item(s)`);

    res.json({
      ok:             true,
      especialidades: lista,
      total:          lista.length,
      mensagem:       'Especialidades atualizadas com sucesso.',
    });

  } catch (err) {
    console.error('[tecnico/me/especialidades] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar especialidades.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/servicos
 * Substitui o array de servicos oferecidos pelo tecnico autenticado.
 * Remove entradas vazias e duplicadas. Limite: 30 itens.
 */
app.put('/api/v1/tecnico/me/servicos', requireTecnico, async (req, res) => {
  const { servicos } = req.body || {};

  if (!Array.isArray(servicos)) {
    return res.status(400).json({ erro: 'Campo "servicos" deve ser um array.' });
  }

  // Remove vazios, sanitiza, deduplica e limita a 30 itens
  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
  const lista = [...new Set(
    servicos
      .map(s => san(String(s), 100))
      .filter(s => s.length > 0)
  )].slice(0, 30);

  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    if (!await Tecnicos.buscarPorId(idNum)) return res.status(404).json({ erro: 'Tecnico nao encontrado.' });

    await Tecnicos.atualizarServicos(idNum, lista);
    console.log(`[tecnico/me/servicos] Atualizado — tecnico ${idNum} — ${lista.length} item(s)`);

    res.json({
      ok:      true,
      servicos: lista,
      total:   lista.length,
      mensagem: 'Servicos atualizados com sucesso.',
    });

  } catch (err) {
    console.error('[tecnico/me/servicos] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar servicos.' });
  }
});

/**
 * POST /api/v1/tecnico/me/foto — envia/substitui a foto de perfil do
 * técnico autenticado. Guardada no bucket público do R2
 * (R2_BUCKET_AVATARS) — ver lib/storage-r2.js.
 */
app.post('/api/v1/tecnico/me/foto', requireTecnico, uploadAvatar.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhuma imagem enviada.' });

    const idNum = req.tecnicoSessao.tecnicoId;
    const ext   = path.extname(req.file.originalname).toLowerCase();
    const verificacao = await validarMagicBytes(req.file.buffer, req.file.mimetype, ext);
    if (!verificacao.valido) {
      return res.status(400).json({ erro: 'Imagem inválida. Use um JPG ou PNG de verdade.' });
    }

    const anterior = await Tecnicos.buscarPorId(idNum);
    const key = `avatar-${idNum}-${Date.now()}${ext}`;
    const fotoUrl = await storageR2.enviarAvatar(req.file.buffer, key, req.file.mimetype);

    await Tecnicos.atualizarFoto(idNum, key);

    // Remove a foto anterior do R2 só depois que a nova já foi salva
    // com sucesso — evita ficar sem nenhuma foto se a remoção falhar.
    if (anterior?.foto_path) {
      await storageR2.removerAvatar(anterior.foto_path);
    }

    console.log(`[tecnico/me/foto] Foto atualizada — técnico ${idNum}`);
    res.json({ ok: true, fotoUrl });
  } catch (err) {
    console.error('[tecnico/me/foto] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao enviar foto.' });
  }
});

/**
 * POST /api/v1/tecnico/me/documento — reenvia/substitui o documento
 * comprobatório usando a SESSÃO autenticada (em vez do uploadToken de
 * cadastro, que só existe logo após o cadastro inicial). Ao substituir
 * um documento já analisado, o status volta para 'pendente' — evita
 * que um documento novo seja considerado aprovado sem revisão.
 */
app.post('/api/v1/tecnico/me/documento', requireTecnico, upload.single('documento'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const idNum = req.tecnicoSessao.tecnicoId;
    const ext   = path.extname(req.file.originalname).toLowerCase();
    const verificacao = await validarMagicBytes(req.file.buffer, req.file.mimetype, ext);

    if (!verificacao.valido) {
      return res.status(400).json({ erro: 'Tipo de arquivo não permitido. Use PDF, JPG ou PNG.' });
    }

    const anterior = await Tecnicos.buscarPorId(idNum);
    const key = `doc-${idNum}-${Date.now()}${ext}`;
    await storageR2.enviarDocumento(req.file.buffer, key, req.file.mimetype);

    await Tecnicos.salvarDocumento(idNum, {
      docPath:         key,
      docOriginalName: req.file.originalname,
      docMime:         req.file.mimetype,
    });
    // Documento novo = precisa de nova análise. Não derruba um técnico
    // já ativo do ar — só marca a validação como pendente novamente.
    await Tecnicos.atualizarStatus(idNum, 'pendente', 'reenvio-tecnico');

    if (anterior?.doc_path) {
      await storageR2.removerDocumento(anterior.doc_path);
    }

    console.log(`[tecnico/me/documento] Documento reenviado — técnico ${idNum}`);
    res.json({ sucesso: true, mensagem: 'Documento recebido. Sua validação será reanalisada.' });
  } catch (err) {
    console.error('[tecnico/me/documento] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao enviar documento.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/contato
 * Atualiza telefone, whatsapp e/ou email do tecnico autenticado.
 * Campos nao enviados sao preservados. Campos nao permitidos sao ignorados.
 */
app.put('/api/v1/tecnico/me/contato', requireTecnico, async (req, res) => {
  const { whatsapp, telefone, email } = req.body || {};

  // Pelo menos um campo deve ser enviado
  if (whatsapp === undefined && telefone === undefined && email === undefined) {
    return res.status(400).json({ erro: 'Informe ao menos um campo: whatsapp, telefone ou email.' });
  }

  // Validações — mesmo padrão do cadastro
  const wppLimpo = whatsapp !== undefined ? String(whatsapp).replace(/\D/g, '').slice(0, 11) : undefined;
  if (wppLimpo !== undefined && wppLimpo.length < 10) {
    return res.status(400).json({ erro: 'WhatsApp inválido. Informe DDD + número (10 ou 11 dígitos).' });
  }

  const telLimpo = telefone !== undefined ? String(telefone).replace(/\D/g, '').slice(0, 11) : undefined;
  if (telLimpo !== undefined && telLimpo.length > 0 && telLimpo.length < 10) {
    return res.status(400).json({ erro: 'Telefone inválido. Informe DDD + número.' });
  }

  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
  // E-mail continua aceito aqui por compatibilidade, mas a troca "de
  // verdade" (com confirmação de senha) vive em PUT /me/email — ver
  // seção Segurança mais abaixo.
  const emailLimpo = email !== undefined ? san(email, 150).toLowerCase() : undefined;
  if (emailLimpo !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }

  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    if (!await Tecnicos.buscarPorId(idNum)) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    await Tecnicos.atualizarContato(idNum, { whatsapp: wppLimpo, telefone: telLimpo, email: emailLimpo });
    const tecnico = await Tecnicos.buscarPorId(idNum);
    console.log(`[tecnico/me/contato] Contato atualizado — técnico ${idNum}`);

    res.json({
      ok:       true,
      whatsapp: tecnico.whatsapp,
      telefone: tecnico.telefone || null,
      email:    tecnico.email,
      mensagem: 'Contato atualizado com sucesso.',
    });

  } catch (err) {
    console.error('[tecnico/me/contato] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar contato.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/email — troca segura de e-mail, exige a senha
 * atual para confirmar identidade (ação sensível, aba Segurança).
 */
app.put('/api/v1/tecnico/me/email', requireTecnico, async (req, res) => {
  const { novoEmail, senha } = req.body || {};
  if (!novoEmail || !senha) {
    return res.status(400).json({ erro: 'Novo e-mail e senha atual são obrigatórios.' });
  }
  const san = (v, max) => (v || '').trim().replace(/[<>"'`]/g, '').slice(0, max);
  const emailLimpo = san(novoEmail, 150).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }

  try {
    const idNum   = req.tecnicoSessao.tecnicoId;
    const tecnico = await Tecnicos.buscarPorId(idNum);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const senhaHash = crypto.createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev').update(senha).digest('hex');
    if (senhaHash !== tecnico.senha_hash) {
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Senha atual incorreta.' });
    }

    await Tecnicos.atualizarContato(idNum, { email: emailLimpo });
    console.log(`[tecnico/me/email] E-mail atualizado — técnico ${idNum}`);
    res.json({ ok: true, email: emailLimpo, mensagem: 'E-mail atualizado com sucesso.' });
  } catch (err) {
    console.error('[tecnico/me/email] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar e-mail.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/senha — troca de senha autenticada (exige a
 * senha atual). Diferente de POST /tecnico/senha, que é só para o
 * primeiro acesso via uploadToken, sem sessão.
 */
app.put('/api/v1/tecnico/me/senha', requireTecnico, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  if (!senhaAtual || !novaSenha) {
    return res.status(400).json({ erro: 'Senha atual e nova senha são obrigatórias.' });
  }
  if (novaSenha.length < 8) {
    return res.status(400).json({ erro: 'A nova senha deve ter no mínimo 8 caracteres.' });
  }

  try {
    const idNum   = req.tecnicoSessao.tecnicoId;
    const tecnico = await Tecnicos.buscarPorId(idNum);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const hashAtual = crypto.createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev').update(senhaAtual).digest('hex');
    if (hashAtual !== tecnico.senha_hash) {
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Senha atual incorreta.' });
    }

    const novoHash = crypto.createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev').update(novaSenha).digest('hex');
    await Tecnicos.atualizarSenha(idNum, novoHash);

    // Por segurança, encerra todas as OUTRAS sessões — mantém só a atual.
    const tokenAtual = req.cookies?.agro_tec_sess;
    if (tokenAtual) await TecnicoSessoes.revogarTodasExceto(idNum, tokenAtual);
    else await TecnicoSessoes.revogarTodasDoTecnico(idNum);

    console.log(`[tecnico/me/senha] Senha alterada — técnico ${idNum}`);
    res.json({ ok: true, mensagem: 'Senha alterada com sucesso. Outras sessões foram encerradas.' });
  } catch (err) {
    console.error('[tecnico/me/senha] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao alterar senha.' });
  }
});

/**
 * GET /api/v1/tecnico/me/sessoes — lista sessões ativas (aba Segurança,
 * "encerrar sessões abertas"). Nunca retorna o token em texto puro —
 * só um identificador derivado (hash truncado) e metadados.
 */
app.get('/api/v1/tecnico/me/sessoes', requireTecnico, async (req, res) => {
  try {
    const idNum       = req.tecnicoSessao.tecnicoId;
    const tokenAtual   = req.cookies?.agro_tec_sess;
    const sessoes      = await TecnicoSessoes.listarPorTecnico(idNum);

    res.json({
      sessoes: sessoes.map(s => ({
        // Identificador opaco — hash do token, nunca o token em si.
        id:        crypto.createHash('sha256').update(s.token).digest('hex').slice(0, 12),
        token:     s.token === tokenAtual ? s.token : undefined, // só a atual expõe o token (para poder se auto-revogar de outra aba, se quiser)
        atual:     s.token === tokenAtual,
        criadoEm:  s.criado_em,
        expiraEm:  s.expira_em,
      })),
    });
  } catch (err) {
    console.error('[tecnico/me/sessoes] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao listar sessões.' });
  }
});

/**
 * POST /api/v1/tecnico/me/sessoes/encerrar-todas — revoga todas as
 * sessões, exceto a atual (a que está fazendo a chamada).
 */
app.post('/api/v1/tecnico/me/sessoes/encerrar-todas', requireTecnico, async (req, res) => {
  try {
    const idNum      = req.tecnicoSessao.tecnicoId;
    const tokenAtual = req.cookies?.agro_tec_sess;
    if (tokenAtual) await TecnicoSessoes.revogarTodasExceto(idNum, tokenAtual);
    res.json({ ok: true, mensagem: 'Todas as outras sessões foram encerradas.' });
  } catch (err) {
    console.error('[tecnico/me/sessoes/encerrar-todas] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao encerrar sessões.' });
  }
});

/**
 * DELETE /api/v1/tecnico/me/sessoes/:token — revoga uma sessão
 * específica, só se pertencer ao próprio técnico autenticado.
 */
app.delete('/api/v1/tecnico/me/sessoes/:token', requireTecnico, async (req, res) => {
  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    await TecnicoSessoes.revogarSeDoTecnico(req.params.token, idNum);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tecnico/me/sessoes/:token] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao encerrar sessão.' });
  }
});

/**
 * GET /api/v1/tecnico/me/historico-login — histórico básico de login
 * (aba Segurança, "visualizar último acesso" / histórico).
 */
app.get('/api/v1/tecnico/me/historico-login', requireTecnico, async (req, res) => {
  try {
    const idNum   = req.tecnicoSessao.tecnicoId;
    const eventos = await TecnicoLoginHistorico.listarRecentes(idNum, 15);
    res.json({
      eventos: eventos.map(e => ({
        data:    e.criado_em,
        sucesso: !!e.sucesso,
      })),
    });
  } catch (err) {
    console.error('[tecnico/me/historico-login] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar histórico.' });
  }
});

/**
 * GET /api/v1/tecnico/me/pagamentos — histórico de pagamentos (aba
 * Premium, "histórico de pagamentos").
 */
app.get('/api/v1/tecnico/me/pagamentos', requireTecnico, async (req, res) => {
  try {
    const idNum      = req.tecnicoSessao.tecnicoId;
    const pagamentos = await Pagamentos.listarPorTecnico(idNum);
    res.json({
      pagamentos: pagamentos.map(p => ({
        plano:      p.plano,
        valor:      p.valor,
        metodo:     p.metodo,
        status:     p.status,
        criadoEm:   p.criado_em,
        aprovadoEm: p.aprovado_em,
      })),
    });
  } catch (err) {
    console.error('[tecnico/me/pagamentos] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao carregar pagamentos.' });
  }
});

/**
 * PUT /api/v1/tecnico/me/configuracoes — visibilidade pública e
 * preferências de notificação.
 */
app.put('/api/v1/tecnico/me/configuracoes', requireTecnico, async (req, res) => {
  const { visivel, notifEmail, notifWhatsapp } = req.body || {};
  if (visivel === undefined && notifEmail === undefined && notifWhatsapp === undefined) {
    return res.status(400).json({ erro: 'Informe ao menos uma configuração.' });
  }
  try {
    const idNum = req.tecnicoSessao.tecnicoId;
    if (!await Tecnicos.buscarPorId(idNum)) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    await Tecnicos.atualizarConfiguracoes(idNum, { visivel, notifEmail, notifWhatsapp });
    console.log(`[tecnico/me/configuracoes] Atualizado — técnico ${idNum}`);
    res.json({ ok: true, mensagem: 'Configurações atualizadas com sucesso.' });
  } catch (err) {
    console.error('[tecnico/me/configuracoes] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao atualizar configurações.' });
  }
});

/**
 * POST /api/v1/tecnico/me/excluir — exclui a própria conta (soft-
 * delete, exige senha para confirmar). O perfil some do ar
 * imediatamente; a linha permanece no banco durante a janela de
 * retenção descrita na Política de Privacidade.
 */
app.post('/api/v1/tecnico/me/excluir', requireTecnico, async (req, res) => {
  const { senha } = req.body || {};
  if (!senha) return res.status(400).json({ erro: 'Confirme sua senha para excluir a conta.' });

  try {
    const idNum   = req.tecnicoSessao.tecnicoId;
    const tecnico = await Tecnicos.buscarPorId(idNum);
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    const senhaHash = crypto.createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev').update(senha).digest('hex');
    if (senhaHash !== tecnico.senha_hash) {
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    await Tecnicos.marcarExcluido(idNum); // já revoga todas as sessões
    res.clearCookie('agro_tec_sess', { path: '/' });
    console.log(`[tecnico/me/excluir] Conta excluída (soft-delete) — técnico ${idNum}`);
    res.json({ ok: true, mensagem: 'Sua conta foi excluída. Sentiremos sua falta!' });
  } catch (err) {
    console.error('[tecnico/me/excluir] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao excluir conta.' });
  }
});

/**
 * POST /api/v1/tecnico/senha
 * Fluxo de PRIMEIRO ACESSO — define senha pela primeira vez.
 * Requer uploadToken como prova de posse (gerado no cadastro).
 * Após a senha ser criada, o uploadToken não pode mais ser usado
 * para alterá-la — novas alterações exigem autenticação via login.
 *
 * Body: { tecnicoId, uploadToken, senha }
 * Senha: mínimo 8 caracteres.
 * Hash: HMAC-SHA256 com HASH_SECRET (mesmo padrão do admin).
 */
app.post('/api/v1/tecnico/senha', limiterLogin, async (req, res) => {
  const { tecnicoId, uploadToken, senha } = req.body || {};

  if (!tecnicoId || !uploadToken || !senha) {
    return res.status(400).json({ erro: 'tecnicoId, uploadToken e senha são obrigatórios.' });
  }
  if (typeof senha !== 'string' || senha.length < 8) {
    return res.status(400).json({ erro: 'A senha deve ter no mínimo 8 caracteres.' });
  }

  try {
    const idNum = Number(tecnicoId);
    const tecnico = Number.isInteger(idNum) ? await Tecnicos.buscarPorId(idNum) : null;
    if (!tecnico) return res.status(404).json({ erro: 'Técnico não encontrado.' });

    // Prova de posse — uploadToken gerado no cadastro, conhecido apenas pelo técnico.
    // Checado ANTES da tentativa de gravação para não vazar, pela resposta 409,
    // se uma senha já existe a quem não provou posse do cadastro.
    if (!await Tecnicos.verificarUploadToken(idNum, uploadToken)) {
      return res.status(403).json({ erro: 'Token inválido.' });
    }

    // Hash HMAC-SHA256 — nunca armazena senha em texto puro
    const senhaHash = crypto
      .createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev')
      .update(senha)
      .digest('hex');

    const resultado = await Tecnicos.definirSenhaPrimeiroAcesso(idNum, senhaHash);
    if (!resultado.ok) {
      // Bloqueia se senha já foi definida — uploadToken só vale para o primeiro
      // acesso. Alterações posteriores devem ser feitas via sessão autenticada.
      return res.status(409).json({ erro: 'Senha já definida. Faça login para alterá-la.' });
    }

    // Invalida todas as sessões ativas do técnico — novo login obrigatório
    await TecnicoSessoes.revogarTodasDoTecnico(idNum);
    console.log(`[tecnico/senha] Primeiro acesso — senha definida para técnico ${tecnicoId}`);

    res.json({ ok: true, mensagem: 'Senha criada com sucesso. Use /api/v1/tecnico/login para entrar.' });

  } catch (err) {
    console.error('[tecnico/senha] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao salvar senha.' });
  }
});

/**
 * POST /api/v1/tecnico/login
 * Autentica o técnico por e-mail (ou whatsapp) + senha.
 * Identifica o registro pelo campo email ou whatsapp.
 * Gera cookie HttpOnly agro_tec_sess com TTL de 8 horas.
 *
 * Body: { identificador, senha }
 * identificador: e-mail ou WhatsApp cadastrado (sem máscara).
 */
app.post('/api/v1/tecnico/login', limiterLogin, async (req, res) => {
  const { identificador, senha, lembrarMe } = req.body || {};

  if (!identificador || !senha) {
    return res.status(400).json({ erro: 'Identificador e senha são obrigatórios.' });
  }

  try {
    const tecnico = await Tecnicos.buscarPorIdentificador(identificador);

    // Conta excluída (soft-delete) nunca deve autenticar, mesmo que a
    // linha ainda exista no banco durante a janela de retenção.
    if (tecnico?.excluido) {
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    if (!tecnico || !tecnico.senha_hash) {
      // Delay anti-brute-force — mesmo padrão do admin
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const senhaHash = crypto
      .createHmac('sha256', process.env.HASH_SECRET || 'agro-hash-dev')
      .update(senha)
      .digest('hex');

    if (senhaHash !== tecnico.senha_hash) {
      await new Promise(r => setTimeout(r, 500));
      await TecnicoLoginHistorico.registrar(tecnico.id, req.ip, false);
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    // "Lembrar-me": sessão de 30 dias em vez das 8 horas padrão.
    const ttlMs = lembrarMe ? 30 * 24 * 60 * 60 * 1000 : TECNICO_SESS_TTL;
    const { token, expiraEm } = await TecnicoSessoes.criar(tecnico.id, req.ip || '', ttlMs);

    // Cookie HttpOnly — não acessível via JavaScript
    res.cookie('agro_tec_sess', token, {
      httpOnly: true,
      secure:   IS_PRODUCTION,
      sameSite: 'strict',
      maxAge:   ttlMs,
      path:     '/',
    });

    await Promise.all([
      Tecnicos.atualizarUltimoAcesso(tecnico.id),
      TecnicoLoginHistorico.registrar(tecnico.id, req.ip, true),
    ]);

    console.log(`[tecnico/login] Login bem-sucedido — técnico ${tecnico.id} — IP: ${req.ip}${lembrarMe ? ' (lembrar-me)' : ''}`);
    res.json({
      ok:        true,
      tecnicoId: tecnico.id,
      publicId:  tecnico.public_id,
      nome:      tecnico.nome,
      expiraEm,
    });

  } catch (err) {
    console.error('[tecnico/login] Erro:', err?.message || err);
    res.status(500).json({ erro: 'Erro ao realizar login.' });
  }
});

// POST /api/v1/tecnico/logout
app.post('/api/v1/tecnico/logout', async (req, res) => {
  const token = req.cookies?.agro_tec_sess;
  if (token) await TecnicoSessoes.revogar(token);
  res.clearCookie('agro_tec_sess', { path: '/' });
  res.json({ ok: true });
});

// GET /api/v1/tecnico/verificar — frontend checa se sessão ainda é válida ao recarregar
app.get('/api/v1/tecnico/verificar', async (req, res) => {
  const token  = req.cookies?.agro_tec_sess;
  const sessao = token ? await TecnicoSessoes.validar(token) : null;
  res.json({ logado: !!sessao, tecnicoId: sessao ? sessao.tecnicoId : null });
});

// ══════════════════════════════════════════════════════════════════
// SITE ESTÁTICO — necessário no Render (processo único, sem Nginx
// separado servindo o HTML como no plano VPS). O server.js é uma API
// pura; esta é a única rota que entrega o front-end de fato.
// No VPS (nginx-agrotecnico.conf), o Nginx serve o HTML diretamente
// do disco e nem chega a repassar essa rota pro Node — as duas
// arquiteturas convivem sem conflito, cada uma servindo o mesmo
// arquivo do jeito apropriado à sua infraestrutura.
// ══════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'agrotecnico-final.html'));
});

// ── 404 ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

// ── Handler de erro global (DEVE ser o último app.use, com 4 args) ──
// Sem isso, qualquer erro lançado ANTES do handler da rota rodar —
// mais comumente o Multer rejeitando um upload (arquivo acima do
// limite, campo de formulário inesperado) — nunca passa pelo try/catch
// de dentro da rota (o Express pula direto pro error handler via
// next(err)) e cai no handler padrão do Express: HTML cru, e com stack
// trace exposto fora de produção. Descoberto na homologação final
// testando upload de avatar acima do limite de 2MB (500 em vez de 400).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const mensagens = {
      LIMIT_FILE_SIZE:  'Arquivo muito grande.',
      LIMIT_FILE_COUNT: 'Muitos arquivos enviados de uma vez.',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado.',
    };
    return res.status(400).json({ erro: mensagens[err.code] || 'Falha no upload do arquivo.' });
  }

  // Corpo JSON malformado (express.json())
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ erro: 'Corpo da requisição inválido.' });
  }

  console.error('[erro não tratado]', err?.message || err);
  res.status(err.status || 500).json({
    erro:    'Erro interno do servidor.',
    detalhe: NODE_ENV === 'development' ? (err?.message || String(err)) : undefined,
  });
});

// ── Rede de segurança de nível de processo ──────────────────────────
// Sem isso, qualquer exceção não capturada (síncrona) ou promise
// rejeitada sem .catch() em qualquer parte do código derruba o processo
// de forma abrupta: sem log estruturado apontando a causa, e sem dar
// chance de fechar o pool de conexões do Postgres — o que deixa
// conexões "penduradas" do lado do Neon até o timeout delas expirar.
// O comportamento do Node já é (corretamente) encerrar o processo
// nesses casos — não faz sentido continuar rodando em estado
// desconhecido. O que isto adiciona é: log claro do que aconteceu, e
// fechamento gracioso do pool antes de sair. O Render reinicia o
// processo automaticamente em seguida (comportamento padrão dele) —
// /health garante que só volta a receber tráfego quando estiver pronto.
function encerrarComErro(origem, err) {
  console.error(`[FATAL] ${origem}:`, err?.stack || err?.message || err);
  Promise.race([
    Promise.resolve(db.close()).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
}
process.on('uncaughtException',  (err) => encerrarComErro('uncaughtException', err));
process.on('unhandledRejection', (err) => encerrarComErro('unhandledRejection', err));

// ── Inicia com fallback automático de porta ───────────────────────
function iniciarServidor(porta) {
  const server = app.listen(porta, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  AgroTécnico Backend — porta ${porta}                  ║`);
    console.log(`╚══════════════════════════════════════════════════╝`);
    console.log(`\n  Health:           http://localhost:${porta}/health`);
    console.log(`  Preços (GET):     http://localhost:${porta}/api/v1/config/precos`);
    console.log(`  Criar Pix:        POST http://localhost:${porta}/api/v1/pagamentos/criar-pix`);
    console.log(`  Criar Pix Class.: POST http://localhost:${porta}/api/v1/pagamentos/criar-pix-classificado`);
    console.log(`  Webhook:          POST http://localhost:${porta}/api/v1/pagamentos/webhook`);
    console.log(`  Robots.txt:       http://localhost:${porta}/robots.txt`);
    console.log(`  Sitemap:          http://localhost:${porta}/sitemap.xml`);
    console.log(`\n  Configure o ngrok e registre a URL no painel MP → Webhooks\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const proxima = porta + 1;
      if (proxima > Number(PORT) + 10) { console.error('[servidor] Nenhuma porta disponível. Encerrando.'); process.exit(1); }
      console.warn(`[servidor] Porta ${porta} ocupada — tentando ${proxima}…`);
      iniciarServidor(proxima);
    } else {
      console.error('[servidor] Erro inesperado:', err.message);
      process.exit(1);
    }
  });
}

iniciarServidor(Number(PORT));
