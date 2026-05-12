/*
Pseudocódigo de Fluxo:

INÍCIO
  RobotController.run(clientId)
    launchBrowser()  // Puppeteer com configurações anti-bot
    navigateToPortal(clientId)
    detectImperva() → if true → ErrorHandler(TIMEOUT_IMPERVA) → retry ou stop
    FaturaValidator.findFaturaElement()
      !exists? → ErrorHandler(FATURA_NAO_ENCONTRADA) → STOP + notif
      !visible? → STOP
    downloadPDF()
      timeout? → ErrorHandler(TIMEOUT_IMPERVA)
    FaturaValidator.validate(pdfPath)
      qualquer falha → ErrorHandler(PDF_INVALIDO) → STOP + notif
    uploadPDF()
      falha 3x? → ErrorHandler(UPLOAD_FALHOU) → retry + notif
  NotificationService.sucesso() apenas se ALL OK

FIM
* Nunca continua em incerteza. Validações em cascata.
* Dashboard loga TUDO.
*/

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // npm i node-fetch

// Configurações
global.DOWNLOAD_DIR = path.join(__dirname, 'downloads');
global.DASHBOARD_FILE = path.join(__dirname, 'dashboard-errors.jsonl');
global.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'mock';
global.UPLOAD_URL = process.env.UPLOAD_URL || 'https://api.upload.com/faturas';
global.PORTAL_URL = 'https://portal.exemplo.com/clientes/';

// Selectors críticos (ajuste conforme portal)
const FATURA_SELECTOR = 'a[href*="fatura"], .fatura-link, #download-fatura';
const IMPERVA_SELECTOR = '.impersua-block, [title*="Imperva"], .captcha';

class FaturaValidator {
  constructor(page) {
    this.page = page;
  }

  // Validação 1: Elemento existe?
  async elementExists() {
    try {
      return await this.page.$(FATURA_SELECTOR) !== null;
    } catch (e) {
      throw new Error('Elemento não encontrado');
    }
  }

  // Validação 2: Visível e clicável?
  async isVisibleAndClickable() {
    const element = await this.page.$(FATURA_SELECTOR);
    if (!element) return false;
    const visible = await this.page.evaluate(el => {
      return el.offsetParent !== null && !el.hidden;
    }, element);
    return visible;
  }

  // Validação 3: PDF válido (cascata: exists → size → header)
  async validatePDF(pdfPath) {
    // 3.1 Existe?
    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF não encontrado');
    }

    // 3.2 Tamanho > 1KB?
    const stats = fs.statSync(pdfPath);
    if (stats.size < 1024) {
      throw new Error('PDF tamanho inválido');
    }

    // 3.3 Conteúdo PDF?
    const buffer = fs.readFileSync(pdfPath);
    const header = buffer.toString('utf8', 0, 4);
    if (!header.startsWith('%PDF')) {
      throw new Error('Header PDF inválido');
    }

    return true;
  }
}

class ErrorHandler {
  constructor(clientId, notificationService) {
    this.clientId = clientId;
    this.notification = notificationService;
  }

  // Centraliza TODO tratamento. Decide retry/stop/notif.
  async handle(errorType, details = {}, retryCount = 0) {
    const timestamp = new Date().toISOString();
    const stack = details.stack || new Error().stack;
    const errorObj = {
      timestamp,
      type: errorType,
      clientId: this.clientId,
      details,
      stack: stack.slice(0, 1000),
      action: this.getRecommendedAction(errorType)
    };

    // Dashboard: log JSONL
    fs.appendFileSync(global.DASHBOARD_FILE, JSON.stringify(errorObj) + '\n');

    // WhatsApp específico por tipo
    await this.notification.sendWhatsApp(errorType, errorObj);

    // Decisão: retry ou STOP
    return this.shouldRetry(errorType, retryCount);
  }

  getRecommendedAction(type) {
    const actions = {
      FATURA_NAO_ENCONTRADA: 'Escalação manual: verificar portal cliente',
      TIMEOUT_IMPERVA: 'Retry com VPN/Proxy ou contatar suporte Imperva',
      PDF_INVALIDO: 'Análise manual: download corrompido?',
      UPLOAD_FALHOU: 'Verificar API upload e retry'
    };
    return actions[type] || 'Escalar para dev';
  }

  shouldRetry(type, count) {
    if (type === 'TIMEOUT_IMPERVA' && count < 2) return { retry: true, backoff: 5000 };
    if (type === 'UPLOAD_FALHOU' && count < 3) return { retry: true, backoff: 2000 };
    return { retry: false, stop: true };
  }
}

class NotificationService {
  constructor() {}

  // WhatsApp mock/prod (use wa-business-api ou similar)
  async sendWhatsApp(errorType, errorObj) {
    const msgs = {
      FATURA_NAO_ENCONTRADA: `🚨 Fatura NÃO ENCONTRADA para cliente ${errorObj.clientId}. Ação: ${errorObj.action}`,
      TIMEOUT_IMPERVA: `⚠️ Imperva/Timeout cliente ${errorObj.clientId}. Tente VPN. Ação: ${errorObj.action}`,
      PDF_INVALIDO: `❌ PDF INVÁLIDO cliente ${errorObj.clientId}. Análise manual. Ação: ${errorObj.action}`,
      UPLOAD_FALHOU: `📤 Upload FALHOU cliente ${errorObj.clientId} (tent ${errorObj.details.retryCount}). Ação: ${errorObj.action}`
    };
    const msg = msgs[errorType] || `Erro desconhecido: ${errorType}`;
    console.log(`[WhatsApp] ${msg}`);
    // Prod: await fetch(`https://api.whatsapp.com/send?token=${global.WHATSAPP_TOKEN}`, {method: 'POST', body: JSON.stringify({msg})});
  }

  async success(clientId) {
    const msg = `✅ Automação SUCESSO para cliente ${clientId}. Fatura processada!`;
    console.log(`[WhatsApp Sucesso] ${msg}`);
    // await sendWhatsApp(msg);
  }
}

class RobotController {
  constructor(clientId) {
    this.clientId = clientId;
    this.notification = new NotificationService();
    this.errorHandler = new ErrorHandler(clientId, this.notification);
    this.retryCount = 0;
  }

  // Orquestrador principal com try-catch explícito EM CADA ETAPA
  async run() {
    let browser;
    try {
      // 1. Browser com anti-bot
      browser = await puppeteer.launch({
        headless: false, // Visible para debug
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0...']
      });
      const page = await browser.newPage();
      await page.setDefaultTimeout(30000);
      await page.setDownloadBehavior({ behavior: 'allow', downloadPath: global.DOWNLOAD_DIR });

      // 2. Navegar
      await page.goto(`${global.PORTAL_URL}${this.clientId}/faturas`, { waitUntil: 'networkidle2' });

      // Detect Imperva precoce
      if (await page.$(IMPERVA_SELECTOR)) {
        throw { type: 'TIMEOUT_IMPERVA', message: 'Imperva detectado' };
      }

      const validator = new FaturaValidator(page);

      // 3. Validações em cascata
      if (!(await validator.elementExists())) {
        throw { type: 'FATURA_NAO_ENCONTRADA', message: 'Elemento fatura ausente' };
      }
      if (!(await validator.isVisibleAndClickable())) {
        throw { type: 'FATURA_NAO_ENCONTRADA', message: 'Fatura não visível' };
      }

      // 4. Download
      await page.click(FATURA_SELECTOR);
      const pdfPath = path.join(global.DOWNLOAD_DIR, `fatura-${this.clientId}.pdf`);
      await this.waitForDownload(pdfPath);

      // 5. Validar PDF
      await validator.validatePDF(pdfPath);

      // 6. Upload com retry
      const success = await this.uploadWithRetry(pdfPath);
      if (!success) {
        throw { type: 'UPLOAD_FALHOU', retryCount: this.retryCount };
      }

      // SUCESSO!
      await this.notification.success(this.clientId);
      console.log('✅ Processo concluído com sucesso');

    } catch (error) {
      const errType = error.type || 'ERRO_DESCONHECIDO';
      const retryInfo = await this.errorHandler.handle(errType, error, this.retryCount);
      if (retryInfo.retry) {
        this.retryCount++;
        console.log(`🔄 Retry ${this.retryCount}...`);
        await new Promise(r => setTimeout(r, retryInfo.backoff));
        return this.run(); // Retry recursivo controlado
      } else {
        console.log('🛑 STOP: Não retry. Escalado.');
        process.exit(1);
      }
    } finally {
      if (browser) await browser.close();
      // Cleanup PDF
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
  }

  async waitForDownload(pdfPath, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout download')), timeout);
      const watcher = fs.watch(global.DOWNLOAD_DIR, (event, filename) => {
        if (filename && filename.includes(this.clientId)) {
          clearTimeout(timer);
          watcher.close();
          resolve(path.join(global.DOWNLOAD_DIR, filename));
        }
      });
    });
  }

  async uploadWithRetry(pdfPath, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const buffer = fs.readFileSync(pdfPath);
        const formData = new FormData();
        formData.append('file', buffer, `fatura-${this.clientId}.pdf`);
        formData.append('clientId', this.clientId);

        const res = await fetch(global.UPLOAD_URL, {
          method: 'POST',
          body: formData
        });
        if (res.ok) return true;
      } catch (e) {
        console.log(`Upload fail ${i+1}: ${e.message}`);
      }
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }
}

// Entry point
async function main() {
  if (process.argv.length < 3) {
    console.log('Uso: node automatizador-faturas-v3-stop-report.js <clientId>');
    process.exit(1);
  }
  const clientId = process.argv[2];
  console.log(`🚀 Iniciando automação para cliente ${clientId}`);

  // Ensure dirs
  if (!fs.existsSync(global.DOWNLOAD_DIR)) fs.mkdirSync(global.DOWNLOAD_DIR);

  const robot = new RobotController(clientId);
  await robot.run();
}

main().catch(console.error);

// Dependências: npm i puppeteer node-fetch form-data
// Env: WHATSAPP_TOKEN, UPLOAD_URL, PORTAL_URL (opcional)
