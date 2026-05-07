import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IGREEN_LOGIN_URL = "https://escritorio.igreenenergy.com.br/login";
const IGREEN_MAPA_URL = "https://escritorio.igreenenergy.com.br/mapa-clientes";
const IGREEN_USER = process.env.IGREEN_USER || "jorgeluizhouse@hotmail.com";
const IGREEN_PASS = process.env.IGREEN_PASS || "@@Lkjdsa12345";
const APP_ID = 'igreen-autoflow-v4';

// MODELO GEMINI CORRIGIDO: gemini-1.5-pro (não gemini-pro)
const GEMINI_MODEL = "gemini-1.5-pro";

// Validação de chaves críticas na inicialização
if (!GEMINI_API_KEY) {
  console.error("[INIT] ❌ ERRO FATAL: GEMINI_API_KEY não definida. Defina a variável de ambiente.");
  process.exit(1);
}

// ==========================================
// INICIALIZAÇÃO FIREBASE
// ==========================================
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("[FIREBASE] ✅ Banco de Dados Cloud ligado!");
  }
} catch (e) {
  console.error("[FIREBASE] ⚠️ Erro ao inicializar DB:", e.message);
}

// ==========================================
// GERENCIAMENTO DE ESTADO (FIRESTORE)
// ==========================================
// Em produção (Render serverless), usar Firestore em vez de Map() em memória
// Map() perde dados entre requisições. Firestore persiste.
async function obterEstado(phone) {
  if (admin.apps.length === 0) {
    // Fallback: Map em memória se Firebase não estiver disponível
    return global.memoriaEstado?.get(phone) || { STATUS_CADASTRO: 'NOVO' };
  }
  try {
    const db = admin.firestore();
    const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('estados').doc(phone).get();
    return doc.exists ? doc.data() : { STATUS_CADASTRO: 'NOVO' };
  } catch (e) {
    console.warn("[ESTADO] ⚠️ Erro ao ler estado:", e.message);
    return { STATUS_CADASTRO: 'NOVO' };
  }
}

async function salvarEstado(phone, estado) {
  if (admin.apps.length === 0) {
    // Fallback: Map em memória
    if (!global.memoriaEstado) global.memoriaEstado = new Map();
    global.memoriaEstado.set(phone, estado);
    return;
  }
  try {
    const db = admin.firestore();
    await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('estados').doc(phone).set(
      { ...estado, ATUALIZADO_EM: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.error("[ESTADO] ❌ Erro ao salvar estado:", e.message);
  }
}

// ==========================================
// TEXTOS COM MENU INTERATIVO
// ==========================================
const TEXTOS = {
  T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nEscolha uma das opções abaixo enviando apenas o número:\n\n" +
    "1️⃣ *Novo Cadastro* (Ler fatura e preparar contrato)\n" +
    "2️⃣ *Guardar Fatura* (Apenas salvar no Banco de Dados)\n" +
    "3️⃣ *Resgatar Dados* (Puxar dados do portal iGreen)\n\n" +
    "_(Digite *0* a qualquer momento para cancelar e voltar a este menu)_",
  T01: "Opção 1️⃣ selecionada! 🌿 \nPara prepararmos o seu desconto e gerar o contrato, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
  T02: "Recebemos a sua fatura! 📄 A nossa Inteligência Artificial está a extrair os dados neste exato momento. Um momento...",
  T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \n*Módulo de Extração* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Robson Carlos ou 1119032):",
  T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma iniciou a varredura profunda no *Escritório Virtual iGreen*...",
  T_RESGATE_FAIL: "⚠️ O Robô varreu o código-fonte da iGreen, mas o cliente não possui CPF registrado na tabela ou a busca falhou.",
  T_GUARDAR_START: "Opção 2️⃣ selecionada! 💾 \n*Módulo de Pré-Cadastro* ativado! Envie apenas a foto ou PDF da *Fatura de Energia*. Eu vou extrair os dados e guardar no banco sem acionar o Robô RPA."
};

// ==========================================
// CONFIGURAÇÕES PUPPETEER (ANTI-BOT)
// ==========================================
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--single-process",
  "--no-zygote",
  "--js-flags=--expose-gc",
  "--disable-blink-features=AutomationControlled" // Anti-detecção
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

function obterUserAgentAleatorio() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ==========================================
// FUNÇÕES AUXILIARES (Z-API & FIREBASE)
// ==========================================

/**
 * Envia mensagem via Z-API com retry automático
 * @param {string} phone - Número do telefone
 * @param {string} message - Mensagem a enviar
 * @param {number} tentativas - Número de tentativas (padrão: 3)
 */
async function enviarMensagem(phone, message, tentativas = 3) {
  const numLimpo = String(phone).replace(/\D/g, '');

  for (let i = 1; i <= tentativas; i++) {
    try {
      console.log(`[Z-API] 📤 Enviando mensagem para ${numLimpo}... (tentativa ${i}/${tentativas})`);

      // CORREÇÃO: Usar template string corretamente com backticks
      const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

      await axios.post(
        url,
        { phone: numLimpo, message: String(message) },
        {
          headers: {
            'Client-Token': ZAPI_CLIENT_TOKEN,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      console.log(`[Z-API] ✅ Mensagem enviada com sucesso para ${numLimpo}!`);
      return true;
    } catch (e) {
      console.error(`[Z-API] ❌ Erro na tentativa ${i}: ${e.message}`);

      // Retry com backoff exponencial
      if (i < tentativas) {
        const delay = Math.pow(2, i) * 1000; // 2s, 4s, 8s
        console.log(`[Z-API] ⏳ Aguardando ${delay}ms antes de retry...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error(`[Z-API] ❌ FALHA FINAL: Não consegui enviar mensagem para ${numLimpo} após ${tentativas} tentativas.`);
  return false;
}

/**
 * Salva dados no Firestore com validação
 * @param {string} phone - Número do telefone
 * @param {object} dados - Dados a salvar
 */
async function salvarNoBanco(phone, dados) {
  if (admin.apps.length === 0) {
    console.warn("[FIREBASE] ⚠️ Firebase não inicializado. Dados não serão persistidos.");
    return;
  }

  try {
    const db = admin.firestore();
    const docRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone);

    await docRef.set(
      {
        ...dados,
        TELEFONE: phone,
        DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    console.log(`[FIREBASE] ✅ Dados salvos com sucesso para ${phone}`);
  } catch (e) {
    console.error(`[FIREBASE] ❌ Erro ao salvar: ${e.message}`);
    throw e;
  }
}

// ==========================================
// MÓDULO 1: MOTOR DE INTELIGÊNCIA (GEMINI)
// ==========================================

/**
 * Limpa resposta JSON do Gemini removendo markdown
 * @param {string} texto - Texto bruto da resposta
 * @returns {string} JSON limpo
 */
function limparJsonGemini(texto) {
  // Remove blocos de código markdown
```json ...
