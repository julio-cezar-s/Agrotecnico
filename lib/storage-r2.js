'use strict';

/**
 * ══════════════════════════════════════════════════════════════════
 * Cliente Cloudflare R2 (API compatível com S3) — substitui o disco
 * local (uploads/ e uploads/avatars/) como destino de avatares e
 * documentos comprobatórios.
 *
 * Por quê: o filesystem do Render (free tier) é efêmero — qualquer
 * redeploy apaga tudo que foi salvo em uploads/. Isso quebra
 * silenciosamente em produção (upload "funciona" na hora, mas some
 * no próximo deploy). R2 tem 10GB grátis, sem taxa de egress, e usa
 * o mesmo SDK do S3 (@aws-sdk/client-s3).
 *
 * Dois buckets, dois níveis de acesso:
 *   - R2_BUCKET_AVATARS     → público (acesso via r2.dev ou domínio
 *                             próprio configurado em R2_PUBLIC_URL_AVATARS)
 *   - R2_BUCKET_DOCUMENTOS  → privado — nunca exposto publicamente;
 *                             leitura futura só via URL assinada de
 *                             curta duração (urlAssinadaDocumento).
 * ══════════════════════════════════════════════════════════════════
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_AVATARS,
  R2_BUCKET_DOCUMENTOS,
  R2_PUBLIC_URL_AVATARS,
} = process.env;

/**
 * Verifica se todas as variáveis obrigatórias para o R2 estão
 * presentes. Usado no boot (server.js) para falhar cedo em produção
 * em vez de descobrir a ausência só no primeiro upload de um usuário
 * real.
 */
function configurado() {
  return !!(
    R2_ACCOUNT_ID &&
    R2_ACCESS_KEY_ID &&
    R2_SECRET_ACCESS_KEY &&
    R2_BUCKET_AVATARS &&
    R2_BUCKET_DOCUMENTOS &&
    R2_PUBLIC_URL_AVATARS
  );
}

function variaveisFaltando() {
  const faltando = [];
  if (!R2_ACCOUNT_ID)          faltando.push('R2_ACCOUNT_ID');
  if (!R2_ACCESS_KEY_ID)       faltando.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY)   faltando.push('R2_SECRET_ACCESS_KEY');
  if (!R2_BUCKET_AVATARS)      faltando.push('R2_BUCKET_AVATARS');
  if (!R2_BUCKET_DOCUMENTOS)   faltando.push('R2_BUCKET_DOCUMENTOS');
  if (!R2_PUBLIC_URL_AVATARS)  faltando.push('R2_PUBLIC_URL_AVATARS');
  return faltando;
}

let clienteSingleton = null;

function getClient() {
  if (clienteSingleton) return clienteSingleton;
  clienteSingleton = new S3Client({
    region:   'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return clienteSingleton;
}

// ── Avatares (bucket público) ───────────────────────────────────────

/**
 * Envia o buffer da foto de perfil para o bucket público e retorna a
 * URL pronta para uso no frontend.
 */
async function enviarAvatar(buffer, key, mimetype) {
  await getClient().send(new PutObjectCommand({
    Bucket:      R2_BUCKET_AVATARS,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype,
  }));
  return urlPublicaAvatar(key);
}

/** Remove um avatar antigo do bucket público. Nunca lança — upload de
 * substituição não deve falhar por causa de limpeza de lixo. */
async function removerAvatar(key) {
  if (!key) return;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET_AVATARS, Key: key }));
  } catch (err) {
    console.warn(`[storage-r2] Falha ao remover avatar antigo (${key}):`, err?.message || err);
  }
}

/** Monta a URL pública de um avatar a partir da key salva no banco. */
function urlPublicaAvatar(key) {
  if (!key) return null;
  return `${R2_PUBLIC_URL_AVATARS.replace(/\/$/, '')}/${key}`;
}

// ── Documentos comprobatórios (bucket privado) ──────────────────────

/**
 * Envia o buffer do documento para o bucket privado. Retorna a key —
 * NUNCA uma URL pública, pois o bucket de documentos não tem acesso
 * público configurado.
 */
async function enviarDocumento(buffer, key, mimetype) {
  await getClient().send(new PutObjectCommand({
    Bucket:      R2_BUCKET_DOCUMENTOS,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype,
  }));
  return key;
}

async function removerDocumento(key) {
  if (!key) return;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET_DOCUMENTOS, Key: key }));
  } catch (err) {
    console.warn(`[storage-r2] Falha ao remover documento antigo (${key}):`, err?.message || err);
  }
}

/**
 * Gera uma URL assinada de curta duração para leitura de um documento
 * privado — uso futuro previsto para uma tela de revisão do admin
 * (hoje não existe rota nenhuma que sirva os documentos de volta;
 * ver observação no chat).
 */
async function urlAssinadaDocumento(key, segundosValidade = 300) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET_DOCUMENTOS, Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: segundosValidade });
}

module.exports = {
  configurado,
  variaveisFaltando,
  enviarAvatar,
  removerAvatar,
  urlPublicaAvatar,
  enviarDocumento,
  removerDocumento,
  urlAssinadaDocumento,
};
