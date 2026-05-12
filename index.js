#!/usr/bin/env node
const http = require('http');
const https = require('https');
const fsp = require('fs/promises');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

const clients = [
  { id: 1, name: 'João Silva', cpf: '123.456.789-00' },
  { id: 2, name: 'Maria Oliveira', cpf: '987.654.321-00' },
  { id: 3, name: 'Pedro Santos', cpf: '111.222.333-44' },
  { id: 4, name: 'Ana Costa', cpf: '555.666.777-88' },
  { id: 5, name: 'Carlos Lima', cpf: '999.888.777-66' },
];

async function log(level, msg, extra = {}) {
  const ts = new Date().toISOString();
  const logObj = { ts, level, msg, ...extra };
  await fsp.appendFile('dashboard.jsonl', JSON.stringify(logObj) + '\n');

  let color = colors.reset;
  switch (level) {
    case 'success': color = colors.green; break;
    case 'error': color = colors.red; break;
    case 'warn': color = colors.yellow; break;
    default: color = colors.bright;
  }
  console.log(`${color}${msg}${colors.reset}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      await log('warn', `Tentativa ${attempt}/${maxRetries} falhou: ${e.message}`);
      if (attempt === maxRetries) throw e;
      await sleep(baseDelay * attempt);
    }
  }
}

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout de requisição (30s)'));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const portArg = args.find(a => a.startsWith('--port=')).split('=')[1] || '3000';
  const hostArg = args.find(a => a.startsWith('--host=')).split('=')[1] || 'localhost';
  const useHttps = args.some(a => a === '--https');
  const stopOnFail = args.includes('--stop-on-fail');
  const retriesArg = args.find(a => a.startsWith('--retries=')).split('=')[1] || '3';

  const baseUrl = `${useHttps ? 'https' : 'http'}://${hostArg}:${portArg}`;
  const maxRetries = parseInt(retriesArg, 10);

  await log('info', `Iniciando testes em ${baseUrl} | Retries: ${maxRetries} | Stop on fail: ${stopOnFail}`);

  const results = [];
  let stoppedEarly = false;

  for (const client of clients) {
    const clientRes = {
      client: client.id,
      name: client.name,
      steps: [],
      status: 'pass',
    };

    try {
      await log('info', `Testando cliente ${client.name} (${client.id})`, { clientId: client.id });

      // Passo 1: Validar HTML e elemento
      const htmlUrl = `${baseUrl}/cliente/${client.id}`;
      const htmlResp = await withRetry(() => fetchUrl(htmlUrl), maxRetries);

      if (htmlResp.status !== 200) {
        throw new Error(`Status HTTP ${htmlResp.status}`);
      }
      const htmlCt = htmlResp.headers['content-type'] || '';
      if (!htmlCt.includes('text/html')) {
        throw new Error(`Content-Type inválido: ${htmlCt}`);
      }
      const html = htmlResp.body.toString('utf8');

      // Elemento existe
      if (!/id=["']client-details["']/i.test(html)) {
        throw new Error('Elemento #client-details não encontrado');
      }
      clientRes.steps.push({ step: 'html_element_exists', status: 'pass' });

      // Visibilidade (regex para atributos hidden/display:none no elemento)
      const hiddenRegex = /id=["']client-details["'][^>]*?(?:style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']|class=["'][^"']*?\bhidden\b[^"']*["'])/i;
      if (hiddenRegex.test(html)) {
        throw new Error('Elemento #client-details não visível');
      }
      clientRes.steps.push({ step: 'html_element_visible', status: 'pass' });

      // Passo 2: Validar PDF
      const pdfUrl = `${baseUrl}/cliente/${client.id}/pdf`;
      const pdfResp = await withRetry(() => fetchUrl(pdfUrl), maxRetries);

      if (pdfResp.status !== 200) {
        throw new Error(`Status HTTP PDF ${pdfResp.status}`);
      }
      const pdfCt = pdfResp.headers['content-type'] || '';
      if (!pdfCt.includes('application/pdf')) {
        throw new Error(`Content-Type PDF inválido: ${pdfCt}`);
      }
      const pdfSize = pdfResp.body.length;
      if (pdfSize < 10240) { // 10KB min
        throw new Error(`Tamanho PDF insuficiente: ${pdfSize} bytes`);
      }
      const pdfHeader = pdfResp.body.toString('utf8', 0, 5);
      if (!pdfHeader.startsWith('%PDF-')) {
        throw new Error(`Header PDF inválido: ${pdfHeader}`);
      }

      clientRes.steps.push({ step: 'pdf_size', status: 'pass', size: pdfSize });
      clientRes.steps.push({ step: 'pdf_header', status: 'pass', header: pdfHeader });

      await log('success', `✅ Cliente ${client.name} aprovado`, { clientId: client.id });

    } catch (e) {
      clientRes.status = 'fail';
      clientRes.error = e.message;
      await log('error', `❌ Falha no cliente ${client.name}: ${e.message}`, { clientId: client.id });
      if (stopOnFail) {
        stoppedEarly = true;
        break;
      }
    }

    results.push(clientRes);
  }

  const passCount = results.filter(r => r.status === 'pass').length;
  const failCount = results.length - passCount;
  const summary = {
    total: clients.length,
    pass: passCount,
    fail: failCount,
    stoppedEarly,
    baseUrl,
    timestamp: new Date().toISOString(),
  };
  const report = { summary, results };

  await fsp.writeFile('report.json', JSON.stringify(report, null, 2));

  const finalColor = failCount > 0 ? colors.red : colors.green;
  await log('info', `${finalColor}Resumo final: ${passCount}/${clients.length} aprovados${colors.reset} | Arquivos: dashboard.jsonl, report.json`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  await log('error', `Erro fatal: ${err.message}`, { fatal: true });
  process.exit(1);
});
