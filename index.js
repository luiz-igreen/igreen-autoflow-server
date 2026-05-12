const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { createWriteStream } = require('fs');

// Carrega configurações do .env
dotenv.config();

// Configurações
global.config = {
  equatorialUrl: 'https://al.equatorialenergia.com.br',
  user: process.env.EQUATORIAL_USER || '',
  pass: process.env.EQUATORIAL_PASS || '',
  cpf: process.env.CPF || '',
  iGreenUrl: process.env.IGREEN_UPLOAD_URL || '',
  whatsappWebhook: process.env.WHATSAPP_WEBHOOK || '',
  proxies: (process.env.PROXIES || '').split(',').filter(p => p),
  logFile: 'dashboard.jsonl',
  timeout: 30000,
  retries: 3,
  delays: { min: 100, max: 500 }
};

// Função para log estruturado JSONL
function logEvent(event, data = {}) {
  const log = { timestamp: new Date().toISOString(), event, data, success: event.includes('success') };
  fs.appendFileSync(global.config.logFile, JSON.stringify(log) + '\n');
  console.log(JSON.stringify(log));
}

// Função delay randômico
function randomDelay() {
  const delay = Math.floor(Math.random() * (global.config.delays.max - global.config.delays.min + 1)) + global.config.delays.min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Função para enviar WhatsApp
async function sendWhatsapp(message) {
  if (!global.config.whatsappWebhook) return;
  try {
    await axios.post(global.config.whatsappWebhook, { message });
  } catch (e) {
    console.error('Erro WhatsApp:', e.message);
  }
}

// Validação de PDF
async function validatePDF(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1024) return { valid: false, reason: 'Tamanho < 1KB' };
    const buffer = fs.readFileSync(filePath, 'utf8').slice(0, 4);
    if (!buffer.startsWith('%PDF')) return { valid: false, reason: 'Header inválido' };
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

class EquatorialScraper {
  constructor(proxy = null) {
    this.proxy = proxy;
    this.browser = null;
    this.page = null;
  }

  async init() {
    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(this.proxy ? [`--proxy-server=${this.proxy}`] : [])
      ],
      timeout: global.config.timeout
    };

    this.browser = await puppeteer.launch(launchOpts);
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1366, height: 768 });
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    });
  }

  async detectImperva() {
    const title = await this.page.title();
    const impervaSelectors = ['div[id*="imperva"], #bot-detection, .challenge-form'];
    for (const sel of impervaSelectors) {
      if (await this.page.$(sel)) return true;
    }
    if (title.includes('Imperva') || title.includes('Incapsula')) return true;
    return false;
  }

  async login() {
    await this.page.goto(global.config.equatorialUrl, { waitUntil: 'networkidle2', timeout: global.config.timeout });
    await randomDelay();

    // Seletores de login (ajustados para Equatorial AL)
    const loginSelectors = [
      'input[name="login"]', 'input[id="login"]', '#login', 'input[placeholder*="usuário"]',
      'input[placeholder*="CPF"]', '#usuario'
    ];
    const passSelectors = [
      'input[name="senha"]', 'input[id="senha"]', '#senha', 'input[type="password"]',
      '#password'
    ];
    const submitSelectors = [
      'button[type="submit"]', '#entrar', '.btn-login', 'input[type="submit"]'
    ];

    let loginInput = null;
    for (const sel of loginSelectors) {
      loginInput = await this.page.$(sel);
      if (loginInput) break;
      await randomDelay();
    }
    if (!loginInput) throw new Error('Login input não encontrado');

    let passInput = null;
    for (const sel of passSelectors) {
      passInput = await this.page.$(sel);
      if (passInput) break;
      await randomDelay();
    }
    if (!passInput) throw new Error('Senha input não encontrado');

    await loginInput.type(global.config.user, { delay: 50 });
    await randomDelay();
    await passInput.type(global.config.pass, { delay: 50 });
    await randomDelay();

    let submitBtn = null;
    for (const sel of submitSelectors) {
      submitBtn = await this.page.$(sel);
      if (submitBtn) break;
    }
    if (!submitBtn) throw new Error('Botão login não encontrado');

    await submitBtn.click();
    await randomDelay();

    // Aguarda login sucesso (verifica dashboard ou erro)
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: global.config.timeout });
    await randomDelay();

    if (await this.detectImperva()) throw new Error('Imperva detectado');

    // Verifica se login falhou (ajuste seletor de erro)
    const errorSelectors = ['.alert-danger', '.error', '[role="alert"]'];
    for (const sel of errorSelectors) {
      if (await this.page.$(sel)) throw new Error('Login falhou');
    }
  }

  async searchFatura() {
    // Navega para faturas (ajuste URL ou seletor)
    const faturaUrls = [
      '/minhas-faturas', '/faturas', '/acesso-fatura'
    ];
    for (const url of faturaUrls) {
      try {
        await this.page.goto(global.config.equatorialUrl + url, { waitUntil: 'networkidle2' });
        await randomDelay();
        break;
      } catch {}
    }

    // Busca por CPF
    const cpfSelectors = [
      'input[name="cpf"]', '#cpf', 'input[placeholder*="CPF"]', '.busca-cpf'
    ];
    const cpfInput = await this.page.waitForSelector(cpfSelectors.join(','), { timeout: 10000 });
    await cpfInput.type(global.config.cpf, { delay: 50 });
    await randomDelay();

    const searchBtns = ['button[type="submit"]', '.btn-buscar', '#buscar'];
    const searchBtn = await this.page.$(searchBtns.join(','));
    await searchBtn.click();
    await randomDelay();

    await this.page.waitForSelector('.fatura-list, table.faturas, .lista-boletos', { timeout: 15000 });
  }

  async downloadPDF() {
    const downloadSelectors = [
      'a[href*=".pdf"]', '.download-pdf', 'button[title*="baixar"]', '.btn-download'
    ];
    const pdfLink = await this.page.waitForSelector(downloadSelectors.join(','), { timeout: 10000 });

    // Intercepta download
    const client = await this.page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: './downloads' });

    await pdfLink.click();
    await this.page.waitForTimeout(5000);

    // Encontra o PDF mais recente
    const files = fs.readdirSync('./downloads').filter(f => f.endsWith('.pdf'));
    if (files.length === 0) throw new Error('PDF não baixado');
    const latestFile = files.sort((a, b) => fs.statSync(`./downloads/${b}`).mtime - fs.statSync(`./downloads/${a}`).mtime)[0];
    const filePath = path.join('./downloads', latestFile);

    const validation = await validatePDF(filePath);
    if (!validation.valid) {
      fs.unlinkSync(filePath);
      throw new Error(`PDF inválido: ${validation.reason}`);
    }

    return filePath;
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.browser) await this.browser.close();
  }
}

class iGreenUploader {
  async upload(pdfPath) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(pdfPath));
    formData.append('cpf', global.config.cpf);

    const response = await axios.post(global.config.iGreenUrl, formData, {
      headers: formData.getHeaders(),
      timeout: 30000
    });

    if (response.status !== 200) throw new Error('Upload falhou');
    return response.data;
  }
}

class AutomacaoCompleta {
  async run() {
    let proxyIndex = 0;
    const maxRetries = global.config.retries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const proxy = global.config.proxies[proxyIndex % global.config.proxies.length];
      proxyIndex++;

      try {
        logEvent('starting_attempt', { attempt, proxy });

        const scraper = new EquatorialScraper(proxy);
        await scraper.init();

        await scraper.login();
        logEvent('login_success');

        await scraper.searchFatura();
        logEvent('fatura_search_success');

        const pdfPath = await scraper.downloadPDF();
        logEvent('pdf_download_success', { pdfPath });

        await scraper.close();

        const uploader = new iGreenUploader();
        const uploadResult = await uploader.upload(pdfPath);
        logEvent('upload_success', uploadResult);

        fs.unlinkSync(pdfPath); // Limpa

        await sendWhatsapp(`✅ Sucesso iGreen: Fatura ${global.config.cpf} processada!`);
        return true;

      } catch (error) {
        logEvent('attempt_failed', { attempt, error: error.message });

        if (error.message.includes('Imperva') || error.message.includes('timeout')) {
          // Retry com backoff
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        } else if (error.message.includes('não encontrado') || error.message.includes('PDF inválido')) {
          // Para em falhas críticas
          await sendWhatsapp(`❌ Erro crítico: ${error.message}`);
          return false;
        }

        await scraper?.close();
      }
    }

    await sendWhatsapp(`❌ Falha após ${maxRetries} tentativas`);
    logEvent('all_attempts_failed');
    return false;
  }
}

// Main CLI
async function main() {
  if (!global.config.user || !global.config.pass || !global.config.cpf || !global.config.iGreenUrl) {
    console.error('❌ Configure .env: EQUATORIAL_USER, EQUATORIAL_PASS, CPF, IGREEN_UPLOAD_URL');
    process.exit(1);
  }

  // Cria pasta downloads
  if (!fs.existsSync('./downloads')) fs.mkdirSync('./downloads');

  const automacao = new AutomacaoCompleta();
  const success = await automacao.run();
  process.exit(success ? 0 : 1);
}

// Executa se arquivo principal
if (require.main === module) {
  main().catch(console.error);
}

// NOTAS:
// 1. Instale deps: npm i puppeteer dotenv axios form-data
// 2. Crie .env com creds
// 3. Ajuste seletores se site mudar (use DevTools)
// 4. Proxies: PROXIES=proxy1:port,proxy2:port
// 5. iGreen: URL de upload multipart/form-data
// 6. WhatsApp: webhook que aceita POST {message}
