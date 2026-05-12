const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const fsStat = promisify(fs.stat);
const fsReadFile = promisify(fs.readFile);
const fsReaddir = promisify(fs.readdir);
const fsOpen = promisify(fs.open);
const fsRead = promisify((fd, buffer, offset, length, position) => new Promise((resolve, reject) => fs.read(fd, buffer, offset, length, position, (err, bytes) => err ? reject(err) : resolve(bytes))));
const fsClose = promisify(fs.close);

// User-Agents humanizados

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'
];

// Utilitários

async function randomDelay(min = 100, max = 500) {
  const delay = min + Math.random() * (max - min);
  return new Promise(resolve => setTimeout(resolve, delay));
}

async function humanMouseMovements(page, duration = 2000) {
  // Simula movimentos de mouse humanos aleatórios
  const viewport = await page.viewport();
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * viewport.width;
    const y = Math.random() * viewport.height;
    await page.mouse.move(x, y);
    await randomDelay(50, 150);
  }
}

async function humanClick(page, selector) {
  await humanMouseMovements(page);
  await randomDelay();
  await page.click(selector, { delay: 100 + Math.random() * 200 });
}

async function humanType(page, selector, text) {
  await page.focus(selector);
  await page.type(selector, text, { delay: 50 + Math.random() * 50 });
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function isValidPDF(filePath) {
  // Validação de PDF: tamanho > 5KB e header %PDF
  try {
    const stats = await fsStat(filePath);
    if (stats.size < 5 * 1024) {
      console.log(`PDF inválido: tamanho ${stats.size} bytes < 5KB`);
      return false;
    }

    const fd = await fsOpen(filePath, 'r');
    const buffer = Buffer.alloc(4);
    await fsRead(fd.fd, buffer, 0, 4, 0);
    await fsClose(fd.fd);

    const header = buffer.toString();
    if (!header.startsWith('%PDF')) {
      console.log(`PDF inválido: header incorreto ${header}`);
      return false;
    }

    console.log(`PDF válido: ${path.basename(filePath)}, ${stats.size} bytes`);
    return true;
  } catch (error) {
    console.error(`Erro validando PDF ${filePath}:`, error.message);
    return false;
  }
}

function suggestSolution(errorMsg) {
  if (errorMsg.includes('Imperva') || errorMsg.includes('bot') || errorMsg.includes('challenge')) {
    return 'Bloqueio anti-bot (Imperva). Solução: Troque proxy/VPN, aguarde 5min ou use User-Agent diferente.';
  } else if (errorMsg.includes('timeout') || errorMsg.includes('net::ERR')) {
    return 'Timeout/conexão falhou. Solução: Verifique internet/proxy, aumente timeout ou use VPN.';
  } else if (errorMsg.includes('file') || errorMsg.includes('upload')) {
    return 'Falha no upload. Solução: Verifique PDF válido, seletores do site ou permissões de arquivo.';
  } else {
    return 'Erro desconhecido. Verifique logs e config.';
  }
}

async function waitForDownload(downloadDir, prefix) {
  // Aguarda download completar (tamanho estável)
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(async () => {
      try {
        const files = (await fsReaddir(downloadDir)).filter(f => f.startsWith(prefix) && f.endsWith('.pdf'));
        if (files.length > 0) {
          const filePath = path.join(downloadDir, files[0]);
          const stats1 = await fsStat(filePath);
          await randomDelay(1000, 2000);
          const stats2 = await fsStat(filePath);
          if (stats1.size === stats2.size) {
            clearInterval(checkInterval);
            resolve(filePath);
          }
        }
      } catch (e) {
        // continua
      }
    }, 500);

    setTimeout(() => {
      clearInterval(checkInterval);
      reject(new Error('Timeout no download'));
    }, 60000);
  });
}

class EquatorialScraperV2 {
  constructor(options = {}) {
    this.proxy = options.proxy;
    this.headless = options.headless ?? true;
    this.downloadDir = options.downloadDir || './downloads';
    this.browser = null;
    this.page = null;
  }

  async init() {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ];

    if (this.proxy) {
      launchArgs.push(`--proxy-server=${this.proxy}`);
    }

    this.browser = await puppeteer.launch({
      headless: this.headless,
      args: launchArgs
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(getRandomUserAgent());
    await this.page.setViewport({ width: 1920, height: 1080 });

    // Config download
    const client = await this.page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloadDir
    });

    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  async login(creds, selectors) {
    try {
      console.log('> Navegando para Equatorial...');
      await this.page.goto(selectors.url, { waitUntil: 'networkidle2', timeout: 60000 });
      await randomDelay();
      await humanMouseMovements(this.page);

      // Login
      await humanClick(this.page, selectors.loginButton);
      await randomDelay();

      await humanType(this.page, selectors.userField, creds.user);
      await randomDelay(500, 1000);

      await humanType(this.page, selectors.passField, creds.pass);
      await randomDelay();

      await humanClick(this.page, selectors.submitButton);
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
      await randomDelay();

      console.log('✓ Login Equatorial realizado');
    } catch (error) {
      throw new Error(`Falha no login Equatorial: ${error.message}`);
    }
  }

  async downloadFaturas(selectors, numFaturas = 1) {
    const pdfs = [];
    try {
      console.log('> Baixando faturas...');
      await this.page.goto(selectors.faturasUrl, { waitUntil: 'networkidle2' });
      await randomDelay();

      for (let i = 0; i < numFaturas; i++) {
        await humanClick(this.page, selectors.downloadButton);
        const pdfPath = await waitForDownload(this.downloadDir, 'fatura');
        if (await isValidPDF(pdfPath)) {
          pdfs.push(pdfPath);
        } else {
          fs.unlinkSync(pdfPath); // Remove inválido
        }
        await randomDelay(2000, 4000);
      }

      console.log(`✓ ${pdfs.length} faturas baixadas e validadas`);
      return pdfs;
    } catch (error) {
      throw new Error(`Falha no download: ${error.message}`);
    }
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.browser) await this.browser.close();
  }
}

class iGreenUploaderV2 {
  constructor(options = {}) {
    this.proxy = options.proxy;
    this.headless = options.headless ?? true;
    this.browser = null;
    this.page = null;
  }

  async init() {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ];

    if (this.proxy) {
      launchArgs.push(`--proxy-server=${this.proxy}`);
    }

    this.browser = await puppeteer.launch({ headless: this.headless, args: launchArgs });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(getRandomUserAgent());
    await this.page.setViewport({ width: 1920, height: 1080 });
  }

  async login(creds, selectors) {
    try {
      console.log('> Navegando para iGreen...');
      await this.page.goto(selectors.url, { waitUntil: 'networkidle2', timeout: 60000 });
      await randomDelay();
      await humanMouseMovements(this.page);

      await humanType(this.page, selectors.userField, creds.user);
      await randomDelay();

      await humanType(this.page, selectors.passField, creds.pass);
      await randomDelay();

      await humanClick(this.page, selectors.submitButton);
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

      console.log('✓ Login iGreen realizado');
    } catch (error) {
      throw new Error(`Falha no login iGreen: ${error.message}`);
    }
  }

  async uploadPDF(pdfPath, selectors, maxRetries = 3) {
    for (let retry = 1; retry <= maxRetries; retry++) {
      try {
        console.log(`> Upload PDF (tentativa ${retry}): ${path.basename(pdfPath)}`);
        await this.page.goto(selectors.uploadUrl || selectors.url, { waitUntil: 'networkidle2' });
        await randomDelay(2000);

        // Múltiplos seletores para input file
        const fileSelectors = [
          selectors.fileInput,
          'input[type="file"]',
          '#file-upload',
          '[name="file"]',
          '.upload-input'
        ];

        let inputFound = false;
        for (const selector of fileSelectors) {
          try {
            await this.page.waitForSelector(selector, { visible: true, timeout: 60000 });
            await humanClick(this.page, selector);
            await this.page.waitForTimeout(1000); // Aguardar file dialog
            await this.page.setInputFiles(selector, pdfPath);
            inputFound = true;
            console.log(`✓ Input file encontrado: ${selector}`);
            break;
          } catch (e) {
            console.log(`Selector ${selector} não encontrado, tentando próximo...`);
          }
        }

        if (!inputFound) {
          throw new Error('Nenhum input file encontrado');
        }

        await randomDelay(1000, 2000);
        await humanClick(this.page, selectors.submitUpload);
        await this.page.waitForSelector(selectors.successSelector || '.success', { timeout: 60000 });

        console.log('✓ Upload realizado com sucesso!');
        return true;
      } catch (error) {
        console.error(`Falha no upload (tentativa ${retry}): ${error.message}`);
        if (retry === maxRetries) {
          throw error;
        }
        await randomDelay(3000, 5000);
      }
    }
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.browser) await this.browser.close();
  }
}

class AutomacaoV2 {
  constructor(config) {
    this.config = config;
    this.proxies = config.proxies || [];
    this.maxRetriesProxy = config.maxRetriesProxy || 3;
    this.vpnRetries = 0;
  }

  async tryWithProxy(fn, proxyIndex = 0) {
    const proxy = this.proxies[proxyIndex];
    console.log(`Tentando com proxy: ${proxy || 'sem proxy'}`);

    try {
      return await fn(proxy);
    } catch (error) {
      console.error(`Falha com proxy ${proxy}: ${error.message}`);
      console.error(error.stack);
      console.log('Sugestão:', suggestSolution(error.message));

      if (proxyIndex + 1 < this.proxies.length) {
        await randomDelay(5000);
        return await this.tryWithProxy(fn, proxyIndex + 1);
      } else {
        throw error;
      }
    }
  }

  async scrapeEquatorial() {
    return await this.tryWithProxy(async (proxy) => {
      const scraper = new EquatorialScraperV2({ proxy, headless: this.config.headless });
      try {
        await scraper.init();
        await scraper.login(this.config.equatorial.creds, this.config.equatorial.selectors);
        const pdfs = await scraper.downloadFaturas(this.config.equatorial.selectors, this.config.equatorial.numFaturas || 1);
        return pdfs;
      } finally {
        await scraper.close();
      }
    });
  }

  async uploadToIGreen(pdfs) {
    return await this.tryWithProxy(async (proxy) => {
      const uploader = new iGreenUploaderV2({ proxy, headless: this.config.headless });
      try {
        await uploader.init();
        await uploader.login(this.config.igreen.creds, this.config.igreen.selectors);

        for (const pdf of pdfs) {
          await uploader.uploadPDF(pdf, this.config.igreen.selectors);
        }

        return true;
      } finally {
        await uploader.close();
      }
    });
  }

  async run() {
    try {
      console.log('🚀 Iniciando Automatizador Faturas v2');

      // Scraping
      const pdfs = await this.scrapeEquatorial();
      if (pdfs.length === 0) {
        throw new Error('Nenhuma fatura válida baixada');
      }

      // Upload
      await this.uploadToIGreen(pdfs);

      console.log('🎉 Automação concluída com sucesso!');
    } catch (error) {
      console.error('❌ Erro crítico:', error.message);
      console.error(error.stack);
      console.log('Sugestão:', suggestSolution(error.message));

      this.vpnRetries++;
      if (this.vpnRetries >= 3) {
        console.log('🔄 FALHAS PERSISTENTES: Tente ativar VPN manualmente e execute novamente!');
      }

      throw error;
    }
  }
}

// Exemplo de uso / Configuração (AJUSTE AQUI!)
if (require.main === module) {
  const config = {
    headless: false, // true para produção
    proxies: [
      // 'http://user:pass@ip:port',
      // 'http://ip:port'
    ],
    equatorial: {
      creds: { user: 'seu_usuario', pass: 'sua_senha' },
      selectors: {
        url: 'https://equatorial.com.br/login', // Ajuste URL
        loginButton: '#btn-login',
        userField: '#username',
        passField: '#password',
        submitButton: '#submit',
        faturasUrl: 'https://equatorial.com.br/faturas',
        downloadButton: '.download-pdf'
      },
      numFaturas: 1
    },
    igreen: {
      creds: { user: 'user_igreen', pass: 'pass_igreen' },
      selectors: {
        url: 'https://igreen.com.br/login',
        userField: '#email',
        passField: '#senha',
        submitButton: '#entrar',
        uploadUrl: 'https://igreen.com.br/upload',
        fileInput: '#arquivo',
        submitUpload: '#upload-btn',
        successSelector: '.mensagem-sucesso'
      }
    }
  };

  new AutomacaoV2(config).run().catch(console.error);
}

module.exports = AutomacaoV2;
