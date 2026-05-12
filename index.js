const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');
require('dotenv').config();

const LOG_FILE = path.join(__dirname, 'logs.jsonl');

function logEvent(level, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
    pid: process.pid
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
  console.log(JSON.stringify(logEntry));
}

function randomDelay(min = 100, max = 500) {
  return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

class EquatorialScraper {
  constructor(proxies) {
    this.proxies = proxies || [];
    this.proxyIndex = 0;
    this.maxRetries = 3;
    this.currentBrowser = null;
    this.currentPage = null;
  }

  async initBrowser() {
    const proxy = this.proxies[this.proxyIndex % this.proxies.length];
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy}`);
    }

    this.currentBrowser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
      timeout: 30000
    });

    this.currentPage = await this.currentBrowser.newPage();
    await this.currentPage.setViewport({ width: 1920, height: 1080 });

    // Headers realistas
    await this.currentPage.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"'
    });

    logEvent('info', 'Browser inicializado', { proxy });
  }

  async detectImperva() {
    const title = await this.currentPage.title();
    const impervaSelectors = ['.imperva', '[id*="imperva"]', '.attention-required', 'text="Attention Required"'];
    for (const selector of impervaSelectors) {
      if (selector.startsWith('text=')) {
        const text = await this.currentPage.evaluate(() => document.body.innerText);
        if (text.includes('Attention Required') || text.includes('Imperva')) return true;
      } else {
        try {
          await this.currentPage.waitForSelector(selector, { timeout: 2000 });
          return true;
        } catch {}
      }
    }
    return title.includes('Imperva') || title.includes('Attention');
  }

  async gotoWithRetry(url, retries = this.maxRetries) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.currentPage.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await randomDelay();
        if (await this.detectImperva()) {
          throw new Error('Imperva detectado');
        }
        return true;
      } catch (err) {
        logEvent('warn', 'Falha no goto, retry', { attempt: i + 1, error: err.message });
        await this.rotateProxy();
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i))); // backoff exponencial
      }
    }
    throw new Error('Falha após max retries');
  }

  async rotateProxy() {
    this.proxyIndex++;
    await this.currentBrowser?.close();
    await this.initBrowser();
  }

  async findElement(selectors) {
    for (const selector of selectors) {
      try {
        const elem = await this.currentPage.waitForSelector(selector, { timeout: 5000, visible: true });
        if (await elem.boundingBox()) {
          return elem;
        }
      } catch {}
    }
    return null;
  }

  async login() {
    await this.gotoWithRetry('https://al.equatorialenergia.com.br/');
    await randomDelay();

    const userSelectors = ['#username', 'input[name="username"]', 'input[placeholder*="usuário"]', 'input[id*="user"]'];
    const passSelectors = ['#password', 'input[name="password"]', 'input[placeholder*="senha"]', 'input[type="password"]'];
    const submitSelectors = ['button[type="submit"]', '.btn-login', 'input[type="submit"]', '#login-btn'];

    const userField = await this.findElement(userSelectors);
    const passField = await this.findElement(passSelectors);
    const submitBtn = await this.findElement(submitSelectors);

    if (!userField || !passField || !submitBtn) {
      throw new Error('Campos de login não encontrados');
    }

    await userField.type(process.env.EQUATORIAL_USER, { delay: 50 });
    await randomDelay();
    await passField.type(process.env.EQUATORIAL_PASS, { delay: 50 });
    await randomDelay();

    await Promise.all([
      this.currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      submitBtn.click()
    ]);

    await randomDelay(1000, 2000);
    logEvent('info', 'Login realizado com sucesso');
  }

  async searchBill(cpf) {
    // Assumir que após login vai para dashboard, buscar fatura
    const searchSelectors = ['input[name="cpf"]', '#cpf', 'input[placeholder*="CPF"]', '.search-cpf'];
    const searchBtnSelectors = ['button#buscar', '.btn-buscar', 'input[type="submit"]', '#search-btn'];

    const cpfField = await this.findElement(searchSelectors);
    const searchBtn = await this.findElement(searchBtnSelectors);

    if (cpfField) {
      await cpfField.type(cpf.replace(/[^0-9]/g, ''), { delay: 50 });
      await randomDelay();
    }

    if (searchBtn) {
      await searchBtn.click();
      await this.currentPage.waitForTimeout(3000);
    }

    // Verificar se fatura não encontrada
    const noBillText = await this.currentPage.evaluate(() => {
      return document.body.innerText.includes('não encontrada') ||
             document.body.innerText.includes('sem faturas') ||
             document.body.innerText.includes('nenhum registro');
    });

    if (noBillText) {
      throw new Error('Fatura não encontrada - PARANDO');
    }

    logEvent('info', 'Busca de fatura realizada');
  }

  async downloadBill() {
    const downloadSelectors = [
      'a[href*=".pdf"]', 'a[title*="download"]', '.download-pdf',
      'button[onclick*="download"]', '.btn-download'
    ];

    const downloadLink = await this.findElement(downloadSelectors);
    if (!downloadLink) {
      throw new Error('Link de download não encontrado');
    }

    const client = await this.currentPage.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: './downloads' });

    const href = await downloadLink.getProperty('href');
    const url = await href.jsonValue();

    await downloadLink.click();
    await this.currentPage.waitForTimeout(5000);

    // Encontrar arquivo baixado mais recente
    const downloadDir = './downloads';
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const files = fs.readdirSync(downloadDir).filter(f => f.endsWith('.pdf'));
    if (files.length === 0) throw new Error('PDF não baixado');

    const latestFile = files.sort((a, b) => fs.statSync(path.join(downloadDir, b)).mtime - fs.statSync(path.join(downloadDir, a)).mtime)[0];
    const pdfPath = path.join(downloadDir, latestFile);
    const pdfBuffer = fs.readFileSync(pdfPath);

    // Validação PDF
    if (pdfBuffer.length < 1024 || !pdfBuffer.toString('utf8', 0, 4).startsWith('%PDF')) {
      throw new Error('PDF inválido - PARANDO');
    }

    fs.unlinkSync(pdfPath);
    logEvent('info', 'PDF baixado e validado', { size: pdfBuffer.length });
    return pdfBuffer;
  }

  async close() {
    await this.currentBrowser?.close();
  }
}

class iGreenUploader {
  async upload(pdfBuffer, cpf, billInfo = {}) {
    try {
      const base64Pdf = pdfBuffer.toString('base64');
      const payload = {
        cpf,
        file: base64Pdf,
        filename: `fatura_${cpf}_${Date.now()}.pdf`,
        ...billInfo
      };

      const response = await axios.post(process.env.IGREEN_UPLOAD_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.IGREEN_TOKEN || ''}` // assumindo token se necessário
        },
        timeout: 30000
      });

      logEvent('info', 'Upload para iGreen sucesso', { status: response.status });
      return true;
    } catch (err) {
      logEvent('error', 'Falha no upload iGreen', { error: err.message });
      throw err;
    }
  }
}

class AutomacaoCompleta {
  constructor() {
    this.scraper = null;
    this.uploader = new iGreenUploader();
    this.proxies = (process.env.PROXIES || '').split(',').map(p => p.trim()).filter(Boolean);
  }

  async run(cpf) {
    try {
      this.scraper = new EquatorialScraper(this.proxies);
      await this.scraper.initBrowser();

      await this.scraper.login();
      await this.scraper.searchBill(cpf);
      const pdfBuffer = await this.scraper.downloadBill();

      await this.uploader.upload(pdfBuffer, cpf);

      await this.notifyWhatsApp(`✅ Sucesso: Fatura ${cpf} processada!`);
      logEvent('info', 'Fluxo completo executado com sucesso');
    } catch (err) {
      logEvent('error', 'Erro crítico no fluxo', { error: err.message });
      await this.notifyWhatsApp(`❌ Erro: ${err.message}`);
      throw err;
    } finally {
      await this.scraper?.close();
    }
  }

  async notifyWhatsApp(message) {
    if (!process.env.WHATSAPP_WEBHOOK) return;
    try {
      await axios.post(process.env.WHATSAPP_WEBHOOK, { message });
    } catch (err) {
      logEvent('warn', 'Falha no WhatsApp', { error: err.message });
    }
  }
}

function parseCLI() {
  const args = process.argv.slice(2);
  const cpf = args.find(arg => arg.startsWith('--cpf='))?.split('=')[1] || process.env.CPF;
  if (!cpf) {
    console.error('CPF obrigatório via --cpf=xxx ou env CPF');
    process.exit(1);
  }
  return cpf.replace(/[^0-9]/g, '');
}

async function main() {
  const cpf = parseCLI();
  const automacao = new AutomacaoCompleta();
  await automacao.run(cpf);
}

// Executar se arquivo principal
if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { EquatorialScraper, iGreenUploader, AutomacaoCompleta };
  
