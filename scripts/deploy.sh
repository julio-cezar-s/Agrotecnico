#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  AgroTécnico — Script de Deploy                                  ║
# ║                                                                    ║
# ║  Roda no servidor de produção após um `git pull` (ou upload dos   ║
# ║  arquivos novos). Idempotente — pode rodar quantas vezes precisar. ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# USO:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh

set -euo pipefail  # para no primeiro erro — evita deploy pela metade

echo "── 1/6 · Verificando .env ──────────────────────────────────"
if [ ! -f .env ]; then
  echo "❌ .env não encontrado. Rode primeiro: node scripts/gerar-secrets.js > .env"
  echo "   e preencha MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET e DATABASE_URL."
  exit 1
fi

# Confirma que os campos obrigatórios não estão vazios (sem exibir os valores)
for VAR in MP_ACCESS_TOKEN MP_WEBHOOK_SECRET HASH_SECRET CONTATO_ENC_KEY ADMIN_SENHA; do
  if ! grep -q "^${VAR}=.\+" .env; then
    echo "❌ Variável ${VAR} está vazia no .env — preencha antes de continuar."
    if [ "$VAR" = "MP_WEBHOOK_SECRET" ]; then
      echo "   (painel Mercado Pago → Suas integrações → Webhooks → chave de assinatura)"
      echo "   Sem ela, o webhook não valida a origem da notificação via HMAC —"
      echo "   as travas de valor/status/método continuam ativas, mas essa é uma"
      echo "   camada extra de defesa que vale a pena não pular em produção."
    fi
    exit 1
  fi
done
echo "✅ .env presente e com os campos obrigatórios preenchidos."

echo ""
echo "── 2/6 · Instalando dependências (produção) ────────────────"
npm ci --omit=dev
echo "✅ Dependências instaladas."

echo ""
echo "── 3/6 · Validando sintaxe dos arquivos principais ─────────"
node --check server.js
node --check db.js
node --check lib/cripto-contato.js
echo "✅ Sintaxe OK."

echo ""
echo "── 4/6 · Testando boot do servidor (dry-run, 3s) ────────────"
# Sobe o processo por 3 segundos só para confirmar que os requires,
# a conexão com o banco e a validação de CONTATO_ENC_KEY passam —
# sem isso, um erro de configuração só apareceria depois do PM2
# já ter marcado o deploy como "no ar".
set +e
timeout 3 node server.js > /tmp/agrotecnico-dryrun.log 2>&1
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 124 ]; then
  # 124 = timeout normal (processo ficou rodando os 3s, matou por TTL — esperado)
  echo "❌ O servidor falhou ao subir. Log:"
  cat /tmp/agrotecnico-dryrun.log
  rm -f /tmp/agrotecnico-dryrun.log
  exit 1
fi
rm -f /tmp/agrotecnico-dryrun.log
echo "✅ Servidor sobe sem erros."

echo ""
echo "── 5/6 · Publicando o site estático para o Nginx ────────────"
# O server.js é uma API pura — quem serve agrotecnico-final.html é o
# Nginx, direto do disco (ver nginx-agrotecnico.conf). Este passo
# copia a versão mais recente do HTML para lá a cada deploy.
STATIC_DIR="${STATIC_DIR:-/var/www/agrotecnico/public}"
if [ -f agrotecnico-final.html ]; then
  sudo mkdir -p "$STATIC_DIR"
  sudo cp agrotecnico-final.html "$STATIC_DIR/index.html"
  echo "✅ HTML publicado em ${STATIC_DIR}/index.html"
else
  echo "⚠️  agrotecnico-final.html não encontrado no diretório atual — pulei este passo."
  echo "   Se o site já estava publicado antes, a versão anterior continua no ar."
fi

echo ""
echo "── 6/6 · Iniciando/reiniciando via PM2 ──────────────────────"
mkdir -p logs
if pm2 describe agrotecnico > /dev/null 2>&1; then
  pm2 restart ecosystem.config.js --env production
  echo "✅ Processo reiniciado."
else
  pm2 start ecosystem.config.js --env production
  pm2 save
  echo "✅ Processo iniciado e salvo para sobreviver a reboot."
  echo "   Se ainda não configurou, rode: pm2 startup"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "Deploy concluído. Verifique:"
echo "  pm2 status"
echo "  pm2 logs agrotecnico --lines 50"
echo "  curl -s https://SEU_DOMINIO/health          # API respondendo"
echo "  curl -s -o /dev/null -w '%{http_code}\n' https://SEU_DOMINIO/   # site estático (deve ser 200)"
echo "═══════════════════════════════════════════════════════════"
