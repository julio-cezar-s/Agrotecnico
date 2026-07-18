#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AgroTécnico — Gerador de .env de produção                       ║
 * ║                                                                    ║
 * ║  Rode este script DIRETO NO SERVIDOR de produção (Hostinger VPS,  ║
 * ║  Railway, Render...), nunca no seu computador pessoal compartilhado ║
 * ║  nem cole o resultado em chat, e-mail ou ticket de suporte.       ║
 * ║  Os segredos gerados aqui só devem existir em dois lugares:       ║
 * ║  o arquivo .env do servidor e o seu cofre de senhas.              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * USO:
 *   node scripts/gerar-secrets.js > .env
 *
 * Depois, edite o .env gerado e preencha manualmente os campos que
 * este script deixa em branco (MP_ACCESS_TOKEN, DATABASE_URL, etc.)
 * — são credenciais de contas externas que só você tem acesso.
 *
 * Rodar de novo gera um conjunto TOTALMENTE NOVO de segredos — não
 * reaproveite chaves antigas achando que está "atualizando", isso
 * invalida sessões ativas e, no caso de CONTATO_ENC_KEY, torna
 * ILEGÍVEIS os contatos de demandas já cifrados com a chave anterior
 * (ver "Rotação de chave" em lib/cripto-contato.js antes de trocar
 * essa em produção).
 */

'use strict';
const crypto = require('crypto');

function hex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function base64(bytes) { return crypto.randomBytes(bytes).toString('base64'); }

/** Senha forte legível — evita caracteres ambíguos (0/O, 1/l/I). */
function senhaForte(tamanho = 20) {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  return Array.from(crypto.randomFillSync(new Uint8Array(tamanho)))
    .map(b => alfabeto[b % alfabeto.length])
    .join('');
}

const HASH_SECRET     = hex(32);        // 64 chars hex — HMAC de senhas e hashes sensíveis
const CONTATO_ENC_KEY = base64(32);     // 32 bytes base64 — EXATAMENTE o formato exigido por lib/cripto-contato.js
const ADMIN_SENHA     = senhaForte(20); // senha do painel /api/admin/login

const env = `# ═══════════════════════════════════════════════════════════
# AgroTécnico — .env de produção
# Gerado em: ${new Date().toISOString()}
# ⚠️  NÃO versionar este arquivo. NÃO colar em chat/e-mail/ticket.
# ═══════════════════════════════════════════════════════════

# ── Mercado Pago (produção — NÃO usar credenciais de sandbox) ──
# Painel MP → Suas integrações → Credenciais de produção
MP_ACCESS_TOKEN=
# Painel MP → Suas integrações → Webhooks → chave de assinatura.
# OBRIGATÓRIA em produção (scripts/deploy.sh recusa subir sem ela) —
# sem ela, o webhook não valida a origem via HMAC. As travas de
# valor/status/método continuam protegendo mesmo assim, mas essa
# camada extra não deve ser pulada num site em produção de verdade.
MP_WEBHOOK_SECRET=

# ── Banco de dados ──────────────────────────────────────────
# Deixe em branco para usar SQLite (MVP). Para produção, use a
# connection string do Postgres gerenciado (Neon/Supabase/Railway):
# postgresql://usuario:senha@host:5432/banco?sslmode=require
DATABASE_URL=
# A maioria dos Postgres gerenciados EXIGE SSL — sem isso a conexão
# falha. Só relevante se DATABASE_URL estiver preenchida.
DB_SSL=true

# ── Segredos gerados automaticamente por este script ────────
HASH_SECRET=${HASH_SECRET}
CONTATO_ENC_KEY=${CONTATO_ENC_KEY}
ADMIN_SENHA=${ADMIN_SENHA}

# ── Acesso ao painel admin ───────────────────────────────────
ADMIN_EMAIL=admin@agrotecnico.com.br
# Desativa o fallback Bearer legado — em produção só cookie de sessão
ADMIN_LEGACY_BEARER=false

# ── Domínio e webhook (ajuste para o domínio real) ───────────
SITE_URL=https://www.agrotecnico.com.br
WEBHOOK_URL=https://www.agrotecnico.com.br/api/v1/pagamentos/webhook
FRONTEND_ORIGIN=https://www.agrotecnico.com.br

PORT=3000
NODE_ENV=production
`;

process.stdout.write(env);

// Aviso vai para stderr — não polui o .env se o usuário redirecionar stdout
console.error('\n✅ .env gerado com HASH_SECRET, CONTATO_ENC_KEY e ADMIN_SENHA novos.');
console.error('   Preencha manualmente: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, DATABASE_URL.');
console.error('   Guarde a ADMIN_SENHA gerada em um cofre de senhas — ela não é reexibida.');
