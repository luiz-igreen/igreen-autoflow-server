const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// CHAVES DA Z-API CENTRALIZADAS
const ZAPI_INSTANCE = "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = "F177679f2434d425e9a3e58ddec1d4cf0S"; // A sua senha master

// Conexão segura com o Banco de Dados (Firestore)
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig) {
    if (admin.apps.length === 0) {
      admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    }
    console.log("✅ Banco de Dados conectado com sucesso!");
  } else {
    console.log("⚠️ Banco de Dados aguardando credenciais (FIREBASE_CONFIG).");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

// =========================================================================
// FUNÇÃO PARA SABER A HORA E DAR BOM DIA/BOA TARDE/BOA NOITE
// =========================================================================
function obterSaudacao() {
    const horaAtual = new Date().toLocaleString("pt-BR", { timeZone: "America/Maceio", hour: "numeric", hour12: false });
    const h = parseInt(horaAtual);
    if (h >= 5 && h < 12) return "Bom dia";
    if (h >= 12 && h < 18) return "Boa tarde";
    return "Boa noite";
}

app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  // IGNORA recibos chatos de entrega da Z-API
  if (data.type === 'ReceivedCallback' || data.type === 'DeliveryCallback' || data.type === 'ReadCallback' || data.type === 'MessageStatus' || data.type === 'PresenceCallback') {
      return; 
  }

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const isTexto = data.text && data.text.message;

  console.log(`\n=========================================`);
  
  // TRAVA DE LOOP: Se a mensagem foi enviada pelo próprio robô, ele ignora.
  if (data.fromMe) {
      console.log(`🛑 [IGNORADO] Mensagem de sincronização ou enviada por si mesmo (fromMe: true) no número ${phone}`);
      console.log(`=========================================\n`);
      return;
  }

  const saudacao = obterSaudacao(); // Pega o Bom dia/tarde/noite

  // CENÁRIO 1: O CLIENTE ENVIOU UM TEXTO ("Oi", "Olá", "Quero saber mais")
  if (isTexto && !isImage && !isPDF) {
      console.log(`💬 NOVA MENSAGEM DE TEXTO DE: ${phone} | Mensagem: "${data.text.message}"`);
      
      const txtBoasVindas = `${saudacao}! Seja muito bem-vindo à iGreen Energy! 🌿\n\nPara eu simular a sua economia hoje, preciso que me envie uma foto bem nítida ou o PDF da sua conta de luz mais recente.`;
      const vozBoasVindas = `${saudacao}! Seja muito bem-vindo à i Green Energy! Para começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o P D F da sua conta de luz.`;
      
      await enviarMensagem(phone, txtBoasVindas);
      await enviarAudio(phone, await gerarAudioGemini(vozBoasVindas));
      return;
  }
  
  // CENÁRIO 2: O CLIENTE ENVIOU A FATURA (IMAGEM/PDF)
  if (isImage || isPDF) {
    console.log(`📸 NOVA FATURA DETECTADA DE: ${phone}`);
    console.log(`Iniciando auditoria completa...`);
    
    const txtInicial = `${saudacao}! Recebi a sua fatura. 📄\n\nA nossa Inteligência Artificial está a fazer a auditoria completa dos seus dados para o sistema iGreen. Aguarde um instante...`;
    const vozInicial = `${saudacao}! Recebi a sua fatura. A nossa Inteligência Artificial está fazendo a auditoria completa dos seus dados para o sistema i Green. Aguarde só um instante.`;
    
    await enviarMensagem(phone, txtInicial);
    await enviarAudio(phone, await gerarAudioGemini(vozInicial));

    try {
      let mediaUrl = "";
      if (isImage && data.image && data.image.imageUrl) mediaUrl = data.image.imageUrl;
      else if (isPDF && data.document && data.document.documentUrl) mediaUrl = data.document.documentUrl;
      else if (data.link) mediaUrl = data.link;

      if (!mediaUrl) throw new Error("A Z-API não enviou o link do arquivo.");

      const downloadHeaders = {};
      if (ZAPI_CLIENT_TOKEN) downloadHeaders['Client-Token'] = ZAPI_CLIENT_TOKEN;

      const fileResponse = await axios.get(mediaUrl, { 
          responseType: 'arraybuffer',
          headers: downloadHeaders
      });
      const base64Data = Buffer.from(fileResponse.data, 'binary').toString('base64');
      const mimeType = isPDF ? "application/pdf" : "image/jpeg";

      const analise = await analisarComIA(base64Data, mimeType);
      console.log(`✅ AUDITORIA CONCLUÍDA:`, JSON.stringify(analise, null, 2));

      // SALVA NO BANCO DE DADOS
      if (analise.ELEGIVEL && admin.apps.length > 0) {
          const db = admin.firestore();
          const appId = process.env.RENDER_SERVICE_ID || 'igreen-autoflow-v4';
          
          await db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(phone).set({
              DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp(),
              STATUS_CADASTRO: 'NOVO',
              TELEFONE: phone,
              NOME_CLIENTE: analise.NOME_CLIENTE || "",
              CPF: analise.CPF || "",
              CNPJ: analise.CNPJ || "",
              CEP: analise.CEP || "",
              ENDERECO: analise.ENDERECO || "",
              ESTADO: analise.ESTADO || "",
              DISTRIBUIDORA: analise.DISTRIBUIDORA || "",
              TIPO_LIGACAO: analise.TIPO_LIGACAO || "",
              UC: analise.UC || "",
              VALOR_FATURA: analise.VALOR_FATURA || 0,
              ELEGIVEL: true,
              MEDIA_CONSUMO: analise.MEDIA_CONSUMO || 0,
              LINK_FATURA: mediaUrl,
              CONSUMO_MES_1: analise.CONSUMO_MES_1 || 0,
              CONSUMO_MES_2: analise.CONSUMO_MES_2 || 0,
              CONSUMO_MES_3: analise.CONSUMO_MES_3 || 0,
              CONSUMO_MES_4: analise.CONSUMO_MES_4 || 0,
              CONSUMO_MES_5: analise.CONSUMO_MES_5 || 0,
              CONSUMO_MES_6: analise.CONSUMO_MES_6 || 0
          }, { merge: true });
          console.log(`💾 Cliente ELEGÍVEL! Dados salvos no Cofre (Firestore) com sucesso!`);
      } else if (!analise.ELEGIVEL) {
          console.log(`❌ Cliente RECUSADO pelo motivo: ${analise.MOTIVO_RECUSA}. Os dados NÃO foram salvos.`);
      }

      // RESPOSTA FINAL AO CLIENTE (APROVADO / RECUSADO)
      const primeiroNome = analise.NOME_CLIENTE ? analise.NOME_CLIENTE.split(' ')[0] : "Cliente";

      if (analise.ELEGIVEL) {
        const txtAprovado = `🎉 *Parabéns, ${primeiroNome}!*\n\nA nossa IA concluiu a auditoria da sua UC (${analise.UC}). O seu consumo médio é de ${analise.MEDIA_CONSUMO} kWh.\n\nVocê foi *APROVADO* para receber o desconto na conta de luz da ${analise.DISTRIBUIDORA}! ⚡\n\nO consultor Luiz Jorge vai gerar o seu termo de adesão em breve.`;
        const vozAprovado = `Parabéns, ${primeiroNome}! A nossa Inteligência Artificial concluiu a auditoria da sua conta. O seu consumo médio é de ${analise.MEDIA_CONSUMO} quilowatts-hora. Você foi aprovado para receber o desconto na conta de luz da ${analise.DISTRIBUIDORA}! O consultor Luiz Jorge vai gerar o seu termo de adesão em breve.`;
        
        await enviarMensagem(phone, txtAprovado);
        await enviarAudio(phone, await gerarAudioGemini(vozAprovado));
      } else {
        const txtRecusado = `Olá ${primeiroNome},\n\nA nossa IA analisou a sua fatura. Infelizmente, no momento, ela não atende aos critérios da iGreen.\n\n*Motivo:* ${analise.MOTIVO_RECUSA}\n\nFicaremos com o seu contacto para futuras campanhas!`;
        const vozRecusado = `Olá, ${primeiroNome}. A nossa Inteligência Artificial analisou a sua fatura. Infelizmente, no momento, ela não atende aos critérios da i Green. O motivo é: ${analise.MOTIVO_RECUSA}. Ficaremos com o seu contato para futuras campanhas. Um grande abraço!`;
        
        await enviarMensagem(phone, txtRecusado);
        await enviarAudio(phone, await gerarAudioGemini(vozRecusado));
      }

    } catch (erro) {
      console.error("❌ ERRO NO PROCESSAMENTO:", erro.message);
      const txtErro = "Tive uma dificuldade em ler esta imagem. Pode tentar enviar uma foto mais nítida ou o PDF original, por favor?";
      const vozErro = "Puxa, tive uma dificuldade em ler esta imagem. Você poderia tentar enviar uma foto com mais luz ou o arquivo em P D F original, por favor?";
      
      await enviarMensagem(phone, txtErro);
      await enviarAudio(phone, await gerarAudioGemini(vozErro));
    }
  }
});

async function analisarComIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave do Gemini não configurada!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    Aja como um auditor sênior de contas de energia.
    Leia a fatura anexa e extraia todos os dados abaixo.
    Devolva APENAS um JSON válido, usando exatamente estas chaves. Se não achar algo, use string vazia "" ou número 0.
    
    {
      "NOME_CLIENTE": "Nome completo do titular da conta",
      "CPF": "Apenas números do CPF (se for pessoa física)",
      "CNPJ": "Apenas números do CNPJ (se for empresa)",
      "CEP": "Apenas números do CEP da instalação",
      "ENDERECO": "Rua, Número, Bairro, Cidade",
      "ESTADO": "Sigla do estado (Ex: AL, MG, SP)",
      "DISTRIBUIDORA": "Nome da concessionária (Ex: EQUATORIAL, CEMIG)",
      "TIPO_LIGACAO": "MONOFÁSICO, BIFÁSICO ou TRIFÁSICO",
      "UC": "Número da Unidade Consumidora / Instalação / Código do Cliente",
      "VALOR_FATURA": 0.00 (Total a pagar em formato numérico),
      "MEDIA_CONSUMO": 0 (Média de consumo em kWh do histórico),
      "CONSUMO_MES_1": 0 (Consumo em kWh do mês mais recente no histórico),
      "CONSUMO_MES_2": 0 (Consumo em kWh do mês anterior),
      "CONSUMO_MES_3": 0 (Consumo em kWh de 3 meses atrás),
      "CONSUMO_MES_4": 0,
      "CONSUMO_MES_5": 0,
      "CONSUMO_MES_6": 0,
      "ELEGIVEL": true ou false,
      "MOTIVO_RECUSA": "Se ELEGIVEL for false, diga o motivo de forma curta. Se true, deixe vazio."
    }

    REGRAS RÍGIDAS PARA "ELEGIVEL" ser true (Deve passar em TODAS):
    1. Consumo/Média: Monofásico >= 130 kWh, Bifásico >= 150 kWh, Trifásico >= 200 kWh.
    2. Titularidade: O nome NÃO pode conter "ESPÓLIO", "FALECIDO", "SUCESSÃO" ou "HERDEIROS".
    3. Tarifa Social: NÃO pode ter benefício de Tarifa Social / Baixa Renda.
    4. Grupo Tarifário: DEVE ser Grupo B (Baixa Tensão).
    5. Geração Própria: NÃO pode ter Geração Distribuída (energia injetada).
  `;

  const payload = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64 } }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const resposta = await axios.post(url, payload);
  return JSON.parse(resposta.data.candidates[0].content.parts[0].text);
}

async function gerarAudioGemini(texto) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: texto }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
    },
    model: "gemini-2.5-flash-preview-tts"
  };

  try {
    const resposta = await axios.post(url, payload);
    const pcmBase64 = resposta.data.candidates[0].content.parts[0].inlineData.data;
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer, 24000);
    return `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
  } catch (error) {
    console.error("❌ ERRO NA GERAÇÃO DE VOZ:", error.message);
    return null;
  }
}

function pcmToWav(pcmDataBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmDataBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); 
  buffer.writeUInt16LE(1, 20); 
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmDataBuffer.copy(buffer, 44);

  return buffer;
}

async function enviarMensagem(phone, message) {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

    try {
        const numeroLimpo = String(phone).replace(/\D/g, ''); 
        await axios.post(url, { phone: numeroLimpo, message: String(message) }, { headers });
    } catch (e) { 
        console.error("[Z-API ERRO TEXTO]:", e.response ? JSON.stringify(e.response.data) : e.message); 
    }
}

async function enviarAudio(phone, base64Audio) {
    if (!base64Audio) return; 
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`;
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

    try {
        const numeroLimpo = String(phone).replace(/\D/g, ''); 
        await axios.post(url, { phone: numeroLimpo, audio: base64Audio }, { headers });
        console.log(`[Z-API] 🔊 Áudio enviado com sucesso!`);
    } catch (e) { 
        console.error("[Z-API ERRO ÁUDIO]:", e.response ? JSON.stringify(e.response.data) : e.message); 
    }
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`\n🚀 SERVIDOR IGREEN IA COM SAUDAÇÕES LIGADO NA PORTA ${port}!`);
});
