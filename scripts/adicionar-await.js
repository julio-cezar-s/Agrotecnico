'use strict';
const fs = require('fs');

const ARQUIVO = process.argv[2] || 'server.js';
const REPOS = [
  'Tecnicos', 'TecnicoSessoes', 'Pagamentos', 'Avaliacoes', 'Denuncias',
  'Demandas', 'Classificados', 'Configuracoes', 'Avisos', 'AdminSessoes',
  'PedidosTecnico', 'Produtores',
];

const linhas = fs.readFileSync(ARQUIVO, 'utf-8').split('\n');
let totalSubstituicoes = 0;
const linhasAlteradas = [];

const regexes = REPOS.map(nome => ({
  nome,
  // (?<!await ) — não duplica await se já presente
  // \b Nome\.metodo\( — a chamada em si
  re: new RegExp(`(?<!await )\\b(${nome}\\.[a-zA-Z]+\\()`, 'g'),
}));

for (let i = 0; i < linhas.length; i++) {
  const linha = linhas[i];
  const trimmed = linha.trim();

  // Pula linhas de comentário puro (// ...) e continuação de JSDoc (* ...)
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) {
    continue;
  }

  let novaLinha = linha;
  let mudou = false;
  for (const { re } of regexes) {
    re.lastIndex = 0;
    if (re.test(novaLinha)) {
      re.lastIndex = 0;
      novaLinha = novaLinha.replace(re, 'await $1');
      mudou = true;
    }
  }

  if (mudou) {
    totalSubstituicoes++;
    linhasAlteradas.push({ numero: i + 1, antes: linha, depois: novaLinha });
    linhas[i] = novaLinha;
  }
}

fs.writeFileSync(ARQUIVO, linhas.join('\n'), 'utf-8');

console.log(`Total de linhas alteradas: ${totalSubstituicoes}\n`);
linhasAlteradas.forEach(l => {
  console.log(`L${l.numero}:`);
  console.log(`  - ${l.antes.trim()}`);
  console.log(`  + ${l.depois.trim()}`);
});
