/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AgroTécnico — Criptografia dos Dados de Contato das Demandas     ║
 * ║                                                                    ║
 * ║  Por que existe: o mural de demandas guarda WhatsApp/e-mail do    ║
 * ║  produtor, mas esse contato só pode ser lido por um técnico       ║
 * ║  Premium que pagou para desbloqueá-lo (POST /demandas/:id/        ║
 * ║  desbloquear). Guardar em texto puro no banco expõe o dado a      ║
 * ║  qualquer vazamento de backup, dump ou acesso indevido ao banco   ║
 * ║  — por isso ele é cifrado em repouso com AES-256-GCM.             ║
 * ║                                                                    ║
 * ║  Formato de armazenamento (colunas do schema.sql):                ║
 * ║    demandas.contato_enc = base64( ciphertext || authTag )         ║
 * ║    demandas.contato_iv  = base64( iv de 12 bytes )                ║
 * ║                                                                    ║
 * ║  GCM foi escolhido em vez de CBC porque autentica o conteúdo:     ║
 * ║  qualquer alteração do texto cifrado (ou tentativa de trocar o    ║
 * ║  IV) faz a decriptação falhar alto e explícito, em vez de         ║
 * ║  retornar lixo silenciosamente.                                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * VARIÁVEL DE AMBIENTE NECESSÁRIA:
 *   CONTATO_ENC_KEY=<32 bytes em base64>
 *
 * Para gerar uma chave nova:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Guarde essa chave como segredo (mesmo cofre do MP_ACCESS_TOKEN).
 * Trocar a chave em produção torna ILEGÍVEIS todos os registros já
 * cifrados com a chave anterior — ver seção "Rotação de chave" abaixo.
 */

'use strict';

const crypto = require('crypto');

const ALGORITMO   = 'aes-256-gcm';
const TAMANHO_IV  = 12; // 96 bits — recomendado pelo NIST para GCM
const TAMANHO_TAG = 16; // 128 bits — tag de autenticação do GCM

/**
 * Carrega e valida a chave de criptografia a partir do ambiente.
 * Lança erro claro na inicialização em vez de falhar silenciosamente
 * depois, em produção, na primeira demanda publicada.
 *
 * @returns {Buffer} chave de 32 bytes
 */
function carregarChave() {
  const chaveB64 = process.env.CONTATO_ENC_KEY;

  if (!chaveB64) {
    throw new Error(
      '[cripto-contato] CONTATO_ENC_KEY não definida no .env. Gere uma com: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const chave = Buffer.from(chaveB64, 'base64');

  if (chave.length !== 32) {
    throw new Error(
      `[cripto-contato] CONTATO_ENC_KEY inválida — esperado 32 bytes (base64), recebido ${chave.length} bytes.`
    );
  }

  return chave;
}

// Carregada uma única vez por processo — evita reler/revalidar a cada chamada.
// Lazy: só valida quando a primeira função de fato for usada, para não
// derrubar o server.js inteiro se essa lib for importada sem ser usada
// ainda (ex.: antes da migração da rota de demandas estar pronta).
let _chaveCache = null;
function obterChave() {
  if (!_chaveCache) _chaveCache = carregarChave();
  return _chaveCache;
}

/**
 * Cifra um objeto de contato (ex: { wpp, email, canal }).
 *
 * @param {object} dadosContato - objeto serializável em JSON
 * @returns {{ contato_enc: string, contato_iv: string }} valores prontos
 *          para gravar nas colunas contato_enc / contato_iv do schema.sql
 */
function cifrarContato(dadosContato) {
  if (dadosContato == null || typeof dadosContato !== 'object') {
    throw new Error('[cripto-contato] cifrarContato espera um objeto.');
  }

  const chave = obterChave();
  const iv    = crypto.randomBytes(TAMANHO_IV); // IV novo a cada chamada — nunca reutilizar

  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);

  const textoClaro = Buffer.from(JSON.stringify(dadosContato), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(textoClaro), cipher.final()]);
  const tag        = cipher.getAuthTag(); // 16 bytes — precisa ser guardada junto do ciphertext

  // Concatena ciphertext + tag num único blob — simplifica o schema
  // (uma coluna só para o conteúdo cifrado) sem perder a autenticação.
  const blob = Buffer.concat([ciphertext, tag]);

  return {
    contato_enc: blob.toString('base64'),
    contato_iv:  iv.toString('base64'),
  };
}

/**
 * Decifra um contato previamente cifrado com cifrarContato().
 * Lança erro se o conteúdo foi adulterado ou a chave/IV não conferem
 * — GCM detecta violação de integridade automaticamente.
 *
 * @param {string} contatoEnc - base64( ciphertext || authTag )
 * @param {string} contatoIv  - base64( iv )
 * @returns {object} o objeto original passado para cifrarContato()
 */
function decifrarContato(contatoEnc, contatoIv) {
  if (!contatoEnc || !contatoIv) {
    throw new Error('[cripto-contato] contato_enc e contato_iv são obrigatórios para decifrar.');
  }

  const chave = obterChave();
  const iv    = Buffer.from(contatoIv, 'base64');
  const blob  = Buffer.from(contatoEnc, 'base64');

  if (blob.length <= TAMANHO_TAG) {
    throw new Error('[cripto-contato] contato_enc corrompido ou incompleto.');
  }

  // Separa ciphertext e tag do final do blob
  const tag        = blob.subarray(blob.length - TAMANHO_TAG);
  const ciphertext = blob.subarray(0, blob.length - TAMANHO_TAG);

  const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(tag);

  // Se a tag não bater (dado adulterado ou chave errada), decipher.final()
  // lança "Unsupported state or unable to authenticate data" — propositalmente
  // não capturado aqui, para que a rota que chamou saiba que algo está errado
  // em vez de silenciosamente devolver contato vazio/incorreto.
  const textoClaro = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(textoClaro.toString('utf-8'));
}

module.exports = {
  cifrarContato,
  decifrarContato,
  // Exportado para permitir teste de configuração em scripts de deploy
  // (ex.: "node -e \"require('./lib/cripto-contato').verificarConfiguracao()\"")
  verificarConfiguracao: carregarChave,
};

/**
 * ── ROTAÇÃO DE CHAVE ──────────────────────────────────────────────
 * Se CONTATO_ENC_KEY precisar ser trocada (ex.: suspeita de vazamento):
 *
 *   1. Antes de trocar, decifre TODOS os registros de `demandas` com a
 *      chave antiga e re-cifre com a chave nova (script de migração
 *      one-off, fora deste módulo).
 *   2. Só então atualize CONTATO_ENC_KEY no .env e reinicie o processo.
 *   3. Trocar a chave sem migrar os registros existentes torna
 *      irreversível a leitura de todo contato já salvo — o erro de
 *      autenticação do GCM vai aparecer em toda tentativa de desbloqueio.
 */
