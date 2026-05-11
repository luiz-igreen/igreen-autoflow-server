#!/usr/bin/env node

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');

// Validação de credenciais
if (!process.env.EQUATORIAL_USER || !process.env.EQUATORIAL_PASS || !process.env.IGREEN_USER || !process.env.IGREEN_PASS) {
  console.error('❌ Credenciais obrigatórias ausentes no .env');
  process.exit(1);
}

const proxies = JSON.parse(process.env.PROXIES || '[]');

async function withRetry(fn, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === maxRetries) throw error;
      console.log(`Retry ${i + 1}/${maxRetries} em ${baseDelay * Math.pow(2, i)}ms`);
      await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
    }
  }
}

async function sendWhatsApp(phone, apikey, msg) {
  return new Promise((resolve, reject) => {
    const data = `phone=${phone}&text=${encodeURIComponent(msg)}&apikey=${apikey}`;
    const req = https.request({
      hostname: 'api.callmebot.com',
      path: '/whatsapp.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class EquatorialScraper {
  constructor() {
    this.proxyIndex = 0;
  }

  async launchBrowser(proxy = null) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ];
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }
    return puppeteer.launch({
      headless: 'new',
      args
    });
  }

  async login(page) {
    await page.goto('https://equatorialpi.equatorialenergia.com.br/sel/login', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('#usuario', process.env.EQUATORIAL_USER);
    await page.type('#senha', process.env.EQUATORIAL_PASS);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // Verifica login inválido
    const errorEl = await page.$('.erro-login, .alert-danger, [class*="error"]');
    if (errorEl) {
      throw new Error('Login inválido');
    }

    // Verifica Imperva ou bot detection
    try {
      await page.waitForSelector('#imperva-challenge, .bot-challenge', { timeout: 5000 });
      throw new Error('Imperva detectado (Error 16)');
    } catch (e) {
      // OK
    }
  }

  async scrape(month) {
    const cacheDir = path.join(__dirname, 'cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${month}.pdf`);

    if (fs.existsSync(cachePath)) {
      console.log(`✅ PDF em cache: ${cachePath}`);
      return cachePath;
    }

    const numProxies = proxies.length;
    for (let attempt = 0; attempt < numProxies + 1; attempt++) {
      const useProxy = attempt > 0;
      const proxy = useProxy ? proxies[this.proxyIndex % numProxies] : null;
      if (useProxy) this.proxyIndex++;

      let browser;
      try {
        browser = await this.launchBrowser(proxy);
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });

        // Login com retry interno
        await withRetry(() => this.login(page), 3);

        // Navega para faturas
        await page.goto('https://equatorialpi.equatorialenergia.com.br/faturas', { waitUntil: 'networkidle2' });

        // Seleciona mês de referência (ajuste selector conforme portal)
        await page.evaluate((m) => {
          const sel = document.querySelector('select[name="mesRef"], #mes-ref');
          if (sel) sel.value = m;
        }, month);
        await page.click('#buscar, button[type="submit"]', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // Procura link PDF
        const pdfLink = await page.$eval('a[href*=".pdf"], .download-pdf', (el) => el.href).catch(() => null);
        let pdfPath;

        if (pdfLink) {
          // Download direto
          const pdfBuffer = await page.evaluate(async (href) => {
            const response = await fetch(href);
            return await response.arrayBuffer();
          }, pdfLink);
          pdfPath = cachePath;
          await fsp.writeFile(pdfPath, Buffer.from(pdfBuffer));
        } else {
          // Gera PDF da tela
          const tempPath = path.join(__dirname, `temp-${uuidv4()}.pdf`);
          await page.pdf({
            path: tempPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', bottom: '20px' }
          });
          pdfPath = tempPath;
          console.log('📄 PDF gerado via printToPDF');
        }

        await browser.close();
        console.log(`✅ PDF baixado: ${pdfPath}`);
        return pdfPath;

      } catch (error) {
        console.log(`⚠️ Tentativa ${attempt + 1} falhou: ${error.message}`);
        if (browser) await browser.close();
        if (attempt === numProxies) throw error;
      }
    }
    throw new Error('Falha após todos os proxies');
  }
}

class iGreenUploader {
  async upload(pdfPath, devolutivaId) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.goto(process.env.IGREEN_URL || 'https://igreen.com.br', { waitUntil: 'networkidle2' });

      // Login iGreen (ajuste selectors)
      await page.type('#usuario, input[name="email"], #email', process.env.IGREEN_USER);
      await page.type('#senha, input[name="password"]', process.env.IGREEN_PASS);
      await page.click('#login-btn, button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });

      // Vai para devolutiva
      await page.goto(`/devolutiva/${devolutivaId}/editar`);
      await page.waitForSelector('form, #anexo-form');

      // Upload arquivo
      const fileInput = await page.$('input[type="file"], #anexo, #arquivo');
      await fileInput.uploadFile(pdfPath);
      await page.click('#upload-btn, #salvar, button[type="submit"]');
      await page.waitForSelector('.success-msg, .alert-success', { timeout: 10000 });

      console.log('✅ Upload realizado');
    } finally {
      await browser.close();
    }
  }
}

class AutomacaoFaturas {
  constructor() {
    this.scraper = new EquatorialScraper();
    this.uploader = new iGreenUploader();
    this.logs = [];
    this.success = false;
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${msg}`;
    this.logs.push(logEntry);
    console.log(logEntry);
  }

  async sendNotification(msg) {
    const phone = process.env.PHONE_NOTIFY;
    const apikey = process.env.CALLMEBOT_APIKEY;
    if (!phone || !apikey) {
      this.log('ℹ️ WhatsApp não configurado (PHONE_NOTIFY e CALLMEBOT_APIKEY)');
      return;
    }
    try {
      await sendWhatsApp(phone, apikey, msg);
      this.log('📱 Notificação WhatsApp enviada');
    } catch (e) {
      this.log(`❌ WhatsApp falhou: ${e.message}`);
    }
  }

  async generateReport(month) {
    const report = {
      success: this.success,
      month,
      logs: this.logs,
      timestamp: new Date().toISOString()
    };
    const reportPath = path.join(__dirname, `relatorio-${month}.json`);
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
    this.log(`📊 Relatório salvo: ${reportPath}`);
  }

  async run(month, devolutivaId) {
    if (!month.match(/^\d{4}-\d{2}$/)) {
      throw new Error('Mês inválido. Use YYYY-MM');
    }
    if (!devolutivaId) {
      throw new Error('Devolutiva ID obrigatória');
    }

    this.log(`🚀 Iniciando automação para fatura ${month} / devolutiva ${devolutivaId}`);
    let pdfPath;

    try {
      pdfPath = await withRetry(() => this.scraper.scrape(month));

      await withRetry(() => this.uploader.upload(pdfPath, devolutivaId));

      this.success = true;
      await this.sendNotification(`✅ Fatura ${month} automatizada com sucesso!`);
    } catch (error) {
      this.success = false;
      this.log(`💥 Erro final: ${error.message}`);
      await this.sendNotification(`❌ Erro automação ${month}: ${error.message}`);

      // Salva PDF em failed se disponível
      if (pdfPath && fs.existsSync(pdfPath)) {
        const failedDir = path.join(__dirname, 'failed');
        await fsp.mkdir(failedDir, { recursive: true });
        const failedPath = path.join(failedDir, `${month}.pdf`);
        await fsp.copyFile(pdfPath, failedPath);
        this.log(`💾 PDF salvo em failed: ${failedPath}`);
      }

      throw error;
    } finally {
      await this.generateReport(month);

      // Cleanup temp (não cache)
      if (pdfPath && !pdfPath.includes('cache') && fs.existsSync(pdfPath)) {
        await fsp.unlink(pdfPath).catch(() => {});
        this.log('🧹 Temp PDF removido');
      }
    }
  }
}

// CLI
if (require.main === module) {
  const [, , month, devolutivaId] = process.argv;
  if (!month || !devolutivaId) {
    console.log('Usage: node automatizador-faturas.js <YYYY-MM> <devolutivaId>');
    console.log('Ex: node automatizador-faturas.js 2024-01 12345');
    process.exit(1);
  }

  const automacao = new AutomacaoFaturas();
  automacao.run(month, devolutivaId).catch((err) => {
    console.error('FALHA TOTAL:', err.message);
    process.exit(1);
  });
}

module.exports = AutomacaoFaturas;
