import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

// Configurar plugin stealth para evitar detecção
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// Constantes de ambiente

const CONFIG = {
  ZAPI: {
    INSTANCE: process.env.ZAPI_INSTANCE,
    TOKEN: process.env.ZAPI_TOKEN,
    CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  },
  GEMINI: {
    API_KEY: process.env.GEMINI_API_KEY,
  },
  IGREEN: {
    LOGIN_URL: 'https://escritorio.igreenenergy.com.br',
    MAPA_URL: 'https://escritorio.igreenenergy.com.br/mapa-clientes',
    USER: process.env.IGREEN_USER,
    PASS: process.env.IGREEN_PASS,
  },
  EQUATORIAL_AL_URL: 'https://al.equatorialenergia.com.br/siteantigo',
  APP_ID: 'igreen-autoflow-v4',
  PORT: process.env.PORT || 10000,
};

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-blink-features=AutomationControlled',
  '--ignore-certificate-errors',
];

const TEXTOS = {
  // Exemplo de textos - substitua pelos originais completos
  saudacao: 'Olá! Bem-vindo ao iGreen AutoFlow.',
  erroGenerico: 'Ocorreu um erro. Tente novamente.',
  faturaAnalisada: 'Análise da fatura concluída.',
  // Adicione todos os textos originais aqui
};

const memoriaEstado = new Map();

// Inicialização do Firebase
let db;
async function initFirebase() {
  try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig && admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig),
      });
      db = admin.firestore();
      console.log('✅ Banco de Dados Cloud ligado!');
    }
  } catch (error) {
    console.error('Erro ao inicializar Firebase:', error.message);
  }
}

// Funções Utilitárias
const Utils = {
  limparDadosVazios(dados) {
    if (!dados || typeof dados !== 'object') return {};
    const limpo = {};
    for (const [key, value] of Object.entries(dados)) {
      if (value !== null && value !== undefined && value !== '') {
        limpo[key] = value;
      }
    }
    return limpo;
  },

  formatPhone(phone) {
    return phone.replace(/[^0-9]/g, '').replace(/^(\d{2})(\d{5})(\d{4})$/, '$1$2-$3');
  },

  logError(context, error) {
    console.error(`❌ [${context}] Erro:`, error.message);
  },
};

// Serviços de ZAPI (WhatsApp)
const ZapiService = {
  async enviarMensagem(phone, message) {
    try {
      if (!CONFIG.ZAPI.INSTANCE || !CONFIG.ZAPI.TOKEN) {
        throw new Error('Configurações ZAPI não definidas');
      }
      const response = await axios.post(`https://${CONFIG.ZAPI.INSTANCE}/send-message`, {
        phone: Utils.formatPhone(phone),
        message,
      }, {
        headers: {
          Authorization: `Bearer ${CONFIG.ZAPI.TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data;
    } catch (error) {
      Utils.logError('ZapiService.enviarMensagem', error);
      throw error;
    }
  },
};

// Serviços Firebase
const FirebaseService = {
  async buscarNoBanco(docId) {
    try {
      if (!db) throw new Error('Firebase não inicializado');
      const doc = await db.collection('igreen').doc(docId).get();
      return doc.exists ? doc.data() : null;
    } catch (error) {
      Utils.logError('FirebaseService.buscarNoBanco', error);
      throw error;
    }
  },

  async salvarNoBanco(docId, phone, dadosExtras) {
    try {
      if (!db) throw new Error('Firebase não inicializado');
      const dadosLimpos = Utils.limparDadosVazios(dadosExtras);
      await db.collection('igreen').doc(docId).set({
        phone,
        ...dadosLimpos,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      Utils.logError('FirebaseService.salvarNoBanco', error);
      throw error;
    }
  },
};

// Serviço Gemini
async function analisarFaturaGemini(mediaUrl, mimeType) {
  try {
    if (!CONFIG.GEMINI.API_KEY) throw new Error('Chave Gemini não definida');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${CONFIG.GEMINI.API_KEY}`,
      {
        contents: [{
          parts: [{
            text: 'Analise esta fatura de energia e extraia: consumo kWh, valor total, data, cliente. Responda em JSON.'
          }, {
            inline_data: {
              mime_type: mimeType,
              data: mediaUrl.split(',')[1], // assume base64
            },
          }],
        }],
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const analysis = JSON.parse(response.data.candidates[0].content.parts[0].text);
    return analysis;
  } catch (error) {
    Utils.logError('analisarFaturaGemini', error);
    throw error;
  }
}

// Serviço de Scraping com Puppeteer
let browser;
async function initBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: CHROME_ARGS,
    defaultViewport: null,
  });
  return browser;
}

const ScraperService = {
  async loginIgreen(page) {
    await page.goto(CONFIG.IGREEN.LOGIN_URL);
    await page.type('#username', CONFIG.IGREEN.USER);
    await page.type('#password', CONFIG.IGREEN.PASS);
    await page.click('#login-button');
    await page.waitForNavigation();
  },

  // Adicione outras funções de scraping conforme lógica original
};

// Fluxo principal (preservar 100% lógica original - adapte o corpo conforme necessário)
async function fluxoResgateDevolutiva(phone, docId, mediaUrl, mimeType) {
  try {
    // Lógica original aqui: scrape, analyze, etc.
    const dados = await FirebaseService.buscarNoBanco(docId);
    if (!dados) {
      await ZapiService.enviarMensagem(phone, TEXTOS.erroGenerico);
      return;
    }

    const analysis = await analisarFaturaGemini(mediaUrl, mimeType);
    await FirebaseService.salvarNoBanco(docId, phone, analysis);

    await ZapiService.enviarMensagem(phone, TEXTOS.faturaAnalisada);

    // Scraping iGreen e Equatorial se necessário
    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();
    await ScraperService.loginIgreen(page);
    // ... resto da lógica de scraping original
    await page.close();
  } catch (error) {
    Utils.logError('fluxoResgateDevolutiva', error);
    await ZapiService.enviarMensagem(phone, TEXTOS.erroGenerico);
  }
}

// Motor recorrente (preservar lógica original)
function iniciarMotorRecorrente() {
  setInterval(async () => {
    try {
      // Lógica original do motor: poll banco, processar pendentes, etc.
      console.log('🔄 Motor recorrente executando...');
    } catch (error) {
      Utils.logError('iniciarMotorRecorrente', error);
    }
  }, 60000); // Exemplo: a cada 1min
}

// Rotas da API
app.get('/', (req, res) => res.status(200).send('Sistema iGreen Online e Blindado!'));

app.post('/webhook/igreen', async (req, res) => {
  try {
    const { phone, message, mediaUrl, mimeType } = req.body;
    const docId = phone; // ou lógica original

    // Gerenciar estado
    const estado = memoriaEstado.get(phone) || {};
    memoriaEstado.set(phone, { ...estado, lastMessage: message });

    // Executar fluxo
    await fluxoResgateDevolutiva(phone, docId, mediaUrl, mimeType);

    res.status(200).send('OK');
  } catch (error) {
    Utils.logError('webhook/igreen', error);
    res.status(500).send('Erro interno');
  }
});

app.get('/ultima-fatura', async (req, res) => {
  try {
    const { docId } = req.query;
    const dados = await FirebaseService.buscarNoBanco(docId);
    res.json(Utils.limparDadosVazios(dados));
  } catch (error) {
    Utils.logError('ultima-fatura', error);
    res.status(500).json({ error: 'Erro ao buscar fatura' });
  }
});

// Inicializações
async function initApp() {
  await initFirebase();
  iniciarMotorRecorrente();
  await initBrowser(); // Valida browser
}

// Iniciar servidor
initApp().then(() => {
  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando a 100% na porta ${CONFIG.PORT} via Docker (0.0.0.0)`);
  });
}).catch((error) => {
  console.error('Falha na inicialização:', error);
  process.exit(1);
});
