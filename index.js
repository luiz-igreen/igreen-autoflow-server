// package.json (instale com: npm install)
{
  "name": "igreen-autoflow",
  "version": "1.0.0",
  "description": "iGreen AutoFlow - Automação WhatsApp + Análise Fatura Gemini",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.2.1",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "joi": "^17.11.0",
    "pino": "^8.20.0",
    "pino-pretty": "^10.2.0",
    "puppeteer": "^21.5.2",
    "validator": "^13.11.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}

// .env.example (copie para .env e preencha)
GEMINI_API_KEY=your_gemini_api_key
PHONE_NUMBER=+5511999999999
WEBHOOK_SECRET=your_secret
PUPPETEER_TIMEOUT=30000
STATE_TIMEOUT=86400000
LOG_LEVEL=info
PORT=3000

// config/config.js
const dotenv = require('dotenv');
const Joi = require('joi');
const path = require('path');

dotenv.config();

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  GEMINI_API_KEY: Joi.string().required(),
  PHONE_NUMBER: Joi.string().required(),
  WEBHOOK_SECRET: Joi.string().optional(),
  PUPPETEER_TIMEOUT: Joi.number().default(30000),
  STATE_TIMEOUT: Joi.number().default(86400000),
  LOG_LEVEL: Joi.string().default('info')
});

const { error, value: config } = envSchema.validate(process.env, { abortEarly: false });

if (error) {
  console.error('Erro de validação de configuração:', error.details.map(d => d.message).join(', '));
  process.exit(1);
}

module.exports = config;

// utils/logger.js
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['*.key', '*.secret'],
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      levelFirst: true
    }
  } : undefined
});

module.exports = logger;

// utils/validators.js
const validator = require('validator');
const path = require('path');

function validatePhone(phone) {
  return validator.isMobilePhone(phone.toString(), ['pt-BR']);
}

function sanitizeInput(input) {
  if (!input) return '';
  return input.toString().trim().replace(/[<>]/g, '');
}

function validateURL(urlStr) {
  try {
    new URL(urlStr);
    return true;
  } catch {
    return false;
  }
}

function safePath(baseDir, relPath) {
  if (!relPath) return null;
  const fullPath = path.join(baseDir, relPath);
  const resolvedBase = path.resolve(baseDir);
  const resolvedFull = path.resolve(fullPath);
  return resolvedFull.startsWith(resolvedBase) ? resolvedFull : null;
}

module.exports = {
  validatePhone,
  sanitizeInput,
  validateURL,
  safePath
};

// middleware/errorHandler.js
const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
  logger.error(err, { url: req.url, method: req.method });
  res.status(err.status || 500).json({
    error: 'Erro interno do servidor'
  });
};

// services/puppeteerService.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const config = require('../config/config');

class PuppeteerService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isInitialized = false;
    this.userDataDir = path.join(os.tmpdir(), 'igreen-whatsapp');
    fs.mkdirSync(this.userDataDir, { recursive: true });
  }

  /**
   * Inicializa o browser Puppeteer se necessário
   */
  async init() {
    if (this.isInitialized) return;

    try {
      this.browser = await puppeteer.launch({
        headless: false, // Mude para 'new' após login manual inicial
        userDataDir: this.userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1366, height: 768 });

      logger.info('Acessando WhatsApp Web...');
      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle0',
        timeout: config.PUPPETEER_TIMEOUT
      });

      // Aguarda login (QR code manual na primeira vez)
      await this.page.waitForSelector('[data-testid="chat-list"]', { timeout: 60000 }).catch(() => {
        logger.warn('Login manual pode ser necessário. Verifique o browser.');
      });

      this.isInitialized = true;
      logger.info('Puppeteer inicializado com sucesso.');
    } catch (error) {
      logger.error('Falha ao inicializar Puppeteer:', error);
      throw error;
    }
  }

  /**
   * Envia mensagem via WhatsApp Web
   * @param {string} phone - Número com código país
   * @param {string} message - Mensagem a enviar
   */
  async sendMessage(phone, message) {
    await this.init();

    const cleanPhone = phone.replace(/[^\d]/g, '');
    if (cleanPhone.length < 10) {
      throw new Error('Número de telefone inválido');
    }

    logger.debug(`Enviando mensagem para ${phone}: ${message.substring(0, 50)}...`);

    try {
      await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}`, {
        waitUntil: 'networkidle0',
        timeout: config.PUPPETEER_TIMEOUT
      });

      // Selector para caixa de texto (pode variar, adapte se necessário)
      const inputSelector = 'div[contenteditable="true"][data-tab="10"], [data-testid="msg-input"]';
      await this.page.waitForSelector(inputSelector, { timeout: 10000 });

      await this.page.type(inputSelector, message, { delay: 30 });

      const sendSelector = 'button[data-testid="compose-btn-send"], span[data-icon="send"]';
      await this.page.click(sendSelector, { timeout: 5000 });

      // Aguarda envio
      await this.page.waitForTimeout(2000);

      logger.debug('Mensagem enviada com sucesso');
    } catch (error) {
      logger.error('Erro ao enviar mensagem:', error);
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.isInitialized = false;
      logger.info('Puppeteer fechado');
    }
  }
}

module.exports = new PuppeteerService();

// services/stateService.js (adicionei para gerenciar estado sem leak)
const config = require('../config/config');

class StateManager {
  constructor(timeoutMs) {
    this.states = new Map();
    this.timeoutMs = timeoutMs;
    this.cleanupInterval = setInterval(() => this._cleanup(), 3600000); // Limpa a cada 1h
  }

  set(key, value) {
    this.states.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  get(key) {
    const entry = this.states.get(key);
    if (!entry || (Date.now() - entry.timestamp > this.timeoutMs)) {
      this.states.delete(key);
      return null;
    }
    return entry.value;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.states.entries()) {
      if (now - entry.timestamp > this.timeoutMs) {
        this.states.delete(key);
      }
    }
  }

  close() {
    clearInterval(this.cleanupInterval);
    this.states.clear();
  }
}

module.exports = new StateManager(config.STATE_TIMEOUT);

// services/whatsappService.js
const puppeteerService = require('./puppeteerService');
const stateManager = require('./stateService');
const logger = require('../utils/logger');

/**
 * Envia mensagem via WhatsApp
 */
async function sendMessage(phone, message) {
  try {
    await puppeteerService.sendMessage(phone, message);
  } catch (error) {
    logger.error('Erro no WhatsAppService:', error);
    throw error;
  }
}

module.exports = {
  sendMessage,
  stateManager
};

// services/faturaAnalysisService.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const config = require('../config/config');
const { safePath } = require('../utils/validators');

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

const TMP_BASE_DIR = path.join(os.tmpdir(), 'igreen-tmp');

const mimeTypes = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

/**
 * Analisa fatura usando Gemini AI
 * @param {string} filePath - Caminho seguro para arquivo
 * @param {string} [prompt] - Prompt customizado
 * @returns {Promise<string>} Análise textual
 */
async function analisarFaturaGemini(filePath, prompt = 'Analise esta fatura e extraia: emitente, CNPJ, data emissão, valor total, itens principais. Formate em JSON se possível.') {
  try {
    const safeFilePath = safePath(TMP_BASE_DIR, filePath);
    if (!safeFilePath || !fs.existsSync(safeFilePath)) {
      throw new Error('Arquivo inválido ou não encontrado');
    }

    const ext = path.extname(safeFilePath).toLowerCase();
    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error('Formato de arquivo não suportado (apenas PDF e imagens)');
    }

    const fileData = fs.readFileSync(safeFilePath);
    const base64Data = fileData.toString('base64');

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-exp" });
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType
        }
      }
    ]);

    const response = await result.response;
    return response.text();
  } catch (error) {
    logger.error('Erro na análise Gemini:', error);
    throw new Error(`Falha na análise: ${error.message}`);
  }
}

module.exports = { analisarFaturaGemini };

// controllers/webhookController.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

const logger = require('../utils/logger');
const config = require('../config/config');
const { sendMessage, stateManager } = require('../services/whatsappService');
const { analisarFaturaGemini } = require('../services/faturaAnalysisService');
const { validatePhone, sanitizeInput, validateURL } = require('../utils/validators');

const TMP_DIR = path.join(os.tmpdir(), 'igreen-tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const rateLimits = new Map();

async function downloadMedia(url, phone) {
  if (!validateURL(url)) throw new Error('URL inválida');

  return new Promise((resolve, reject) => {
    const safeName = phone.replace(/[^a-z0-9]/gi, '');
    const filename = path.join(TMP_DIR, `fatura_${Date.now()}_${safeName}.${Date.now() % 1000}.jpg`);
    const file = fs.createWriteStream(filename);

    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`Falha download: ${res.statusCode}`));
      }
      res.pipe(file);
    });

    file.on('finish', () => {
      file.close(resolve(filename));
    });

    req.on('error', reject);
    file.on('error', reject);
  });
}

/**
 * Webhook para mensagens WhatsApp
 * Body esperado: { phone, message, mediaUrl?, type? }
 */
router.post('/', async (req, res) => {
  let tempFile = null;
  try {
    // Rate limiting simples (20 req/min por IP)
    const ip = req.ip;
    const now = Date.now();
    let calls = rateLimits.get(ip) || [];
    calls = calls.filter((t) => now - t < 60000);
    if (calls.length >= 20) {
      return res.status(429).json({ error: 'Limite de taxa excedido' });
    }
    calls.push(now);
    rateLimits.set(ip, calls);

    // Validação secret
    if (config.WEBHOOK_SECRET && req.get('x-webhook-secret') !== config.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Não autorizado' });
    }

    const { phone, message = '', mediaUrl, type = 'text' } = req.body;
    const cleanPhone = sanitizeInput(phone);

    if (!validatePhone(cleanPhone)) {
      logger.warn(`Telefone inválido: ${cleanPhone}`);
      return res.json({ status: 'ok' });
    }

    const currentState = stateManager.get(cleanPhone);
    let reply = 'Olá! Digite "fatura" para analisar uma fatura.';
    let analysis = '';

    if (message.toLowerCase().includes('fatura') || currentState?.waitingFatura) {
      if (mediaUrl && (type === 'image' || type === 'document')) {
        tempFile = await downloadMedia(mediaUrl, cleanPhone);
        analysis = await analisarFaturaGemini(path.relative(TMP_DIR, tempFile));
        reply = `Análise da fatura:\n\n${analysis}`;
        stateManager.set(cleanPhone, { analyzed: true });
      } else {
        stateManager.set(cleanPhone, { waitingFatura: true });
        reply = 'Envie a imagem ou PDF da fatura para análise.';
      }
    }

    await sendMessage(cleanPhone, reply);
    logger.info(`Resposta enviada para ${cleanPhone}`);

    res.json({ status: 'ok', processed: true });
  } catch (error) {
    logger.error('Erro no webhook:', error);
    if (tempFile) fs.unlink(tempFile, () => {});
    res.status(500).json({ error: 'Erro no processamento' });
  }
});

module.exports = router;

// index.js (arquivo principal)
const express = require('express');
const cors = require('cors');
const config = require('./config/config');
const logger = require('./utils/logger');
const webhookController = require('./controllers/webhookController');
const errorHandler = require('./middleware/errorHandler');
const puppeteerService = require('./services/puppeteerService');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/webhook', webhookController);

app.use(errorHandler);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const server = app.listen(config.PORT, () => {
  logger.info(`iGreen AutoFlow rodando na porta ${config.PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Fechando servidor...');
  await puppeteerService.close();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recebido');
  await puppeteerService.close();
  process.exit(0);
});

logger.info('Servidor iniciado com sucesso!');
