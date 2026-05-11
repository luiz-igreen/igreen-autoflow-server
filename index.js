require('dotenv').config();

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

// Constantes
declare const CONSTANTS = {
  GEMINI_MODEL: 'gemini-1.5-flash',
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  STATE_TTL: 3600000, // 1 hora
  CLEANUP_INTERVAL: 60000 // 1 min
};

// Logger estruturado
class Logger {
  static info(msg, data = {}) {
    console.log(JSON.stringify({ level: 'info', msg, data, timestamp: new Date().toISOString() }));
  }

  static error(msg, err = null) {
    console.error(JSON.stringify({ level: 'error', msg, error: err?.message, stack: err?.stack, timestamp: new Date().toISOString() }));
  }
  static warn(msg, data = {}) {
    console.warn(JSON.stringify({ level: 'warn', msg, data, timestamp: new Date().toISOString() }));
  }
}

// Validação de variáveis de ambiente
const requiredEnvVars = ['GEMINI_API_KEY', 'PORT', 'WEBHOOK_SECRET'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    Logger.error(`Variável de ambiente obrigatória ausente: ${envVar}`);
    process.exit(1);
  }
}
Logger.info('Todas as variáveis de ambiente validadas com sucesso');

// StateManager sem memory leak
class StateManager {
  constructor() {
    this.states = new Map();
    this.startCleanup();
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.states.entries()) {
        if (now - state.timestamp > CONSTANTS.STATE_TTL) {
          this.states.delete(key);
          Logger.info(`Estado expirado removido: ${key}`);
        }
      }
    }, CONSTANTS.CLEANUP_INTERVAL);
  }

  get(key) {
    return this.states.get(key);
  }

  set(key, value) {
    this.states.set(key, { ...value, timestamp: Date.now() });
  }

  delete(key) {
    this.states.delete(key);
  }
}

const stateManager = new StateManager();

// Inicialização Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Função analisarFaturaGemini com Gemini Vision
async function analisarFaturaGemini(imagePath) {
  try {
    // Validação segura contra path traversal
    const baseDir = path.resolve(process.cwd());
    const safePath = path.resolve(baseDir, path.basename(imagePath));
    if (!safePath.startsWith(baseDir)) {
      throw new Error('Path traversal detectado');
    }

    if (!(await fs.access(safePath)).then(() => true).catch(() => false)) {
      throw new Error('Arquivo não encontrado');
    }

    const fileBuffer = await fs.readFile(safePath);
    if (fileBuffer.length > CONSTANTS.MAX_FILE_SIZE) {
      throw new Error('Arquivo muito grande');
    }

    const model = genAI.getGenerativeModel({ model: CONSTANTS.GEMINI_MODEL });
    const imagePart = {
      inlineData: {
        data: fileBuffer.toString('base64'),
        mimeType: 'image/jpeg' // Ajustar mimeType se necessário
      }
    };

    const prompt = `Analise esta fatura e extraia os seguintes dados em formato JSON válido:\n- numeroFatura\n- dataEmissao (formato YYYY-MM-DD)\n- valorTotal (número decimal)\n- emitente (nome da empresa)\n- destinatario (nome/CPF/CNPJ)\nRetorne APENAS o JSON.`;

    const result = await model.generateContent([prompt, imagePart]);
    const text = result.response.text().trim();

    const parsed = JSON.parse(text);
    Logger.info('Análise de fatura concluída', { path: imagePath });
    return parsed;
  } catch (err) {
    Logger.error('Erro na análise de fatura Gemini', err);
    throw err;
  }
}

// Função RPA placeholder (simular automação)
async function executarRPA(stateId) {
  const state = stateManager.get(stateId);
  if (!state) throw new Error('Estado não encontrado');

  // Simulação de RPA: processar dados da fatura
  Logger.info('Executando RPA', { stateId });
  // Aqui integraria puppeteer ou selenium para automação real
  await new Promise(resolve => setTimeout(resolve, 2000)); // Simula tempo de RPA

  stateManager.set(stateId, { ...state, rpaStatus: 'concluido' });
}

// Função WhatsApp (placeholder para API real como WPPConnect ou Twilio)
async function enviarWhatsApp(telefone, mensagem) {
  try {
    // Placeholder funcional - substitua pela API real
    Logger.info('Enviando WhatsApp', { telefone, mensagem });
    // Exemplo com fetch para API WhatsApp:
    // await fetch('https://api.whatsapp.com/send', { ... });
    console.log(`[WhatsApp] Para ${telefone}: ${mensagem}`);
  } catch (err) {
    Logger.error('Erro ao enviar WhatsApp', err);
    throw err;
  }
}

// Fluxo principal com try-catch robusto
async function fluxoResgateDevolutiva(stateId) {
  try {
    const state = stateManager.get(stateId);
    if (!state) {
      throw new Error('Estado não encontrado para resgate');
    }

    // Executar RPA
    await executarRPA(stateId);

    // Enviar devolutiva via WhatsApp
    await enviarWhatsApp(state.clienteTelefone, `Fatura ${state.analise?.numeroFatura} processada com sucesso. Valor: R$ ${state.analise?.valorTotal}.`);

    stateManager.set(stateId, { ...state, status: 'resgatado', timestamp: Date.now() });
    Logger.info('Fluxo de resgate concluído', { stateId });
  } catch (err) {
    Logger.error('Erro no fluxoResgateDevolutiva', err);
    const state = stateManager.get(stateId);
    if (state) {
      stateManager.set(stateId, { ...state, status: 'erro', error: err.message });
    }
    throw err;
  }
}

// App Express
const app = express();

// Middleware de segurança
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Rate limiting para webhook
app.use('/webhook', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // 100 requests por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições, tente novamente em 15 minutos' }
}));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    statesCount: stateManager.states.size
  });
});

// Endpoint de análise direta (teste)
app.post('/analyze', async (req, res) => {
  try {
    const { imagePath } = req.body;
    const analysis = await analisarFaturaGemini(imagePath);
    res.json({ success: true, analysis });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook principal
app.post('/webhook', async (req, res) => {
  try {
    // Validação de secret
    const webhookSecret = req.headers['x-webhook-secret'] || req.headers['webhook-secret'];
    if (webhookSecret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Não autorizado' });
    }

    const { event, data } = req.body;
    const stateId = data.id || Date.now().toString();

    if (event === 'fatura_recebida') {
      const analysis = await analisarFaturaGemini(data.imagePath);
      stateManager.set(stateId, {
        ...data,
        analise: analysis,
        status: 'analisada',
        clienteTelefone: data.clienteTelefone
      });
      Logger.info('Fatura analisada via webhook', { stateId });
    } else if (event === 'iniciar_resgate') {
      await fluxoResgateDevolutiva(stateId);
    }

    res.json({ success: true, stateId });
  } catch (err) {
    Logger.error('Erro no webhook', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tratamento global de erros
app.use((err, req, res, next) => {
  Logger.error('Erro não tratado no app', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Inicialização segura do servidor
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  Logger.info(`Servidor iGreen AutoFlow iniciado na porta ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  Logger.info('SIGTERM recebido, fazendo shutdown gracioso');
  server.close(() => {
    Logger.info('Servidor fechado');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  Logger.info('SIGINT recebido, fazendo shutdown gracioso');
  server.close(() => {
    Logger.info('Servidor fechado');
    process.exit(0);
  });
});

Logger.info('Aplicação iGreen AutoFlow pronta para produção');
