const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// CHAVES DA Z-API CENTRALIZADAS
const ZAPI_INSTANCE = "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = "F177679f2434d425e9a3e58ddec1d4cf0S"; 

// Conexão com o Banco de Dados (Firestore)
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

// Memória local anti-amnésia
const memoriaEstado = new Map();

// OS TEXTOS EXTRAÍDOS RIGOROSAMENTE DOS SEUS ÁUDIOS (1 a 20)
const TEXTOS = {
    T01_BOAS_VINDAS: "Seja muito bem-vinda à iGreen Energy. Pra começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o PDF da sua conta de luz.",
    T02_ANALISE_IA: "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.",
    T03_PEDIR_CASA: "Fatura auditada com sucesso. Identifiquei o seu CEP, mas não encontrei o número da residência. Por favor, digite o número da sua casa ou apartamento pra prosseguirmos.",
    T04_PEDIR_FRENTE: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05_PEDIR_VERSO: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06_ANALISE_BIO: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07_PEDIR_EMAIL: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08_CONCLUSAO: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T09_ERRO_FATURA: "Aviso, este documento não parece ser uma fatura de energia, ou a imagem está cortada. Por favor, envie a foto correta e nítida da sua conta de luz.",
    T10_TARIFA_SOCIAL: "Atenção, identificamos que a sua conta possui a classificação de baixa renda ou tarifa social. Para proteger o seu benefício governamental, a iGreen não atende esta modalidade, pois a alteração poderia causar a perda do seu subsídio. O processo foi encerrado por segurança.",
    T11_ERRO_DOC: "Aviso, o documento está ilegível, ou não é um RG ou CNH brasileiro válido. Por favor, reenvie a foto com mais foco e sem reflexos de luz.",
    T12_ERRO_EMAIL: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a arroba, e envie novamente.",
    T13_CANCELAMENTO: "Atenção, você solicitou o cancelamento. Tem certeza que deseja excluir todos os dados enviados até agora? Digite um para sim, cancelar tudo, ou dois para não, e continuar o cadastro.",
    T14_ENVIO_CONTRATO: "O seu contrato chegou. A sua proposta de economia já está pronta. Clique no link da mensagem pra ler os termos e assinar digitalmente de forma rápida e segura. Qualquer dúvida, estou aqui.",
    T15_COBRANCA_ASSINATURA: "Falta muito pouco pra começar a poupar. Verificamos que ainda não assinou o seu termo de adesão da iGreen Energy. Lembre-se, não há custos de adesão, obras ou fidelidade. O link ainda está disponível na mensagem.",
    T16_CONEXAO_APROVADA: "Parabéns. A sua concessionária local acabou de aprovar a injeção da nossa energia solar na sua rede. A partir do próximo ciclo, você já começará a notar a redução no valor da sua fatura.",
    T17_AVISO_BOLETO: "A sua fatura iGreen está pronta. Este mês a sua energia mais barata já foi processada. Segue na mensagem o seu boleto unificado. Parabéns por poupar com energia limpa.",
    T18_IGREEN_CLUB: "Você já ativou o seu iGreen Club? Como nosso cliente, você tem descontos em milhares de estabelecimentos no Brasil. Baixe o nosso aplicativo no link da mensagem e comece a aproveitar hoje mesmo.",
    T19_CASHBACK: "Quer zerar a sua conta de luz? Na iGreen Energy você ganha cashback por cada amigo ou familiar que você indicar. Acesse o seu aplicativo, pegue seu link de indicação e partilhe.",
    T20_TRANSBORDO: "Entendido. Vou transferir o seu atendimento pra um de nossos consultores especialistas. Aguarde um instante, por favor."
};

// PREFIXOS DOS ÁUDIOS (O Rastreador vai procurar qualquer ficheiro que comece por estes números)
const AUDIOS = {
    A01_BOAS_VINDAS: "01",
    A02_ANALISE_IA: "02",
    A03_PEDIR_CASA: "03",
    A04_PEDIR_FRENTE: "04",
    A05_PEDIR_VERSO: "05",
    A06_ANALISE_BIO: "06",
    A07_PEDIR_EMAIL: "07",
    A08_CONCLUSAO: "08",
    A09_ERRO_FATURA: "09",
    A10_TARIFA_SOCIAL: "10",
    A11_ERRO_DOC: "11",
    A12_ERRO_EMAIL: "12",
    A13_CANCELAMENTO: "13",
    A14_ENVIO_CONTRATO: "14",
    A15_COBRANCA_ASSINATURA: "15",
    A16_CONEXAO_APROVADA: "16",
    A17_AVISO_BOLETO: "17",
    A18_IGREEN_CLUB: "18",
    A19_CASHBACK: "19",
    A20_TRANSBORDO: "20"
};

// WEBHOOK PRINCIPAL (MÁQUINA DE ESTADOS)
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  if (data.fromMe) return;

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const textoIn = data.text?.message?.trim() || "";
  
  const db = admin.apps.length > 0 ? admin.firestore() : null;
  const appId = process.env.RENDER_SERVICE_ID || 'igreen-autoflow-v4';
  let leadRef = null;
  
  let status = 'NOVO';
  const mem = memoriaEstado.get(phone);
  
  if (db) {
      leadRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(phone);
  }

  if (mem && mem.STATUS_CADASTRO) {
      status = mem.STATUS_CADASTRO;
  } else if (leadRef) {
      const doc = await leadRef.get();
      if (doc.exists) {
          status = doc.data().STATUS_CADASTRO || 'NOVO';
          memoriaEstado.set(phone, doc.data()); 
      }
  }

  console.log(`\n📡 [RADAR] Cliente: ${phone} | Estado Atual: [${status}] | Tipo: ${data.type}`);

  if (textoIn.toLowerCase() === 'cancelar') {
      await enviarFluxo(phone, TEXTOS.T13_CANCELAMENTO, AUDIOS.A13_CANCELAMENTO);
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONFIRMANDO_CANCELAMENTO', PREV_STATUS: status });
      return;
  }
  
  if (textoIn.toLowerCase().match(/(atendente|humano|consultor|especialista|falar com alg)/)) {
      await enviarFluxo(phone, TEXTOS.T20_TRANSBORDO, AUDIOS.A20_TRANSBORDO);
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'TRANSBORDO_HUMANO' });
      return;
  }
  
  if (status === 'CONFIRMANDO_CANCELAMENTO') {
      if (textoIn === '1') {
          if (leadRef) await leadRef.delete();
          memoriaEstado.delete(phone);
          await enviarMensagem(phone, "Cancelamento confirmado. Dados apagados.");
      } else if (textoIn === '2') {
          await enviarMensagem(phone, "Cancelamento abortado. Por favor, envie o documento solicitado anteriormente.");
          const prev = memoriaEstado.get(phone)?.PREV_STATUS || 'NOVO';
          atualizarEstado(phone, leadRef, { STATUS_CADASTRO: prev });
      }
      return;
  }

  switch (status) {
      case 'NOVO':
      case 'AGUARDANDO_FATURA':
          if (!isImage && !isPDF) {
              await enviarFluxo(phone, TEXTOS.T01_BOAS_VINDAS, AUDIOS.A01_BOAS_VINDAS);
              atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
              return;
          }

          await enviarFluxo(phone, TEXTOS.T02_ANALISE_IA, AUDIOS.A02_ANALISE_IA);
          
          try {
              let mediaUrl = obterMediaUrl(data);
              const base64Data = await baixarArquivo(mediaUrl);
              const mimeType = isPDF ? "application/pdf" : "image/jpeg";

              const analise = await auditarFaturaIA(base64Data, mimeType);

              if (!analise.VALIDO) {
                  await enviarFluxo(phone, TEXTOS.T09_ERRO_FATURA, AUDIOS.A09_ERRO_FATURA);
                  return;
              }

              if (analise.TARIFA_SOCIAL) {
                  await enviarFluxo(phone, TEXTOS.T10_TARIFA_SOCIAL, AUDIOS.A10_TARIFA_SOCIAL);
                  atualizarEstado(phone, leadRef, { ...analise, STATUS_CADASTRO: 'RECUSADO_TARIFA_SOCIAL' });
                  return;
              }

              if (analise.ELEGIVEL) {
                  let proximoStatus = 'AGUARDANDO_DOC_FRENTE';
                  let proximoTexto = TEXTOS.T04_PEDIR_FRENTE;
                  let proximoAudio = AUDIOS.A04_PEDIR_FRENTE;

                  if (!analise.ENDERECO_NUMERO || analise.ENDERECO_NUMERO.trim() === '') {
                      proximoStatus = 'AGUARDANDO_CASA';
                      proximoTexto = TEXTOS.T03_PEDIR_CASA;
                      proximoAudio = AUDIOS.A03_PEDIR_CASA;
                  }

                  atualizarEstado(phone, leadRef, {
                      ...analise,
                      STATUS_CADASTRO: proximoStatus,
                      DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                      LINK_FATURA: mediaUrl
                  });
                  
                  await enviarFluxo(phone, proximoTexto, proximoAudio);
              } else {
                  await enviarMensagem(phone, "Sua fatura foi analisada, mas no momento o consumo está abaixo da média exigida.");
                  atualizarEstado(phone, leadRef, { ...analise, STATUS_CADASTRO: 'RECUSADO_CONSUMO' });
              }
          } catch (e) {
              console.error("ERRO FATURA:", e.message);
              await enviarFluxo(phone, TEXTOS.T09_ERRO_FATURA, AUDIOS.A09_ERRO_FATURA);
          }
          break;

      case 'AGUARDANDO_CASA':
          if (!textoIn) return;
          atualizarEstado(phone, leadRef, { ENDERECO_NUMERO: textoIn, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
          await enviarFluxo(phone, TEXTOS.T04_PEDIR_FRENTE, AUDIOS.A04_PEDIR_FRENTE);
          break;

      case 'AGUARDANDO_DOC_FRENTE':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
              return;
          }
          
          try {
              let mediaUrlF = obterMediaUrl(data);
              const base64Frente = await baixarArquivo(mediaUrlF);
              const isDocValido = await validarDocumentoIA(base64Frente);

              if (isDocValido) {
                  atualizarEstado(phone, leadRef, { LINK_DOC_FRENTE: mediaUrlF, STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' });
                  await enviarFluxo(phone, TEXTOS.T05_PEDIR_VERSO, AUDIOS.A05_PEDIR_VERSO);
              } else {
                  await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
              }
          } catch (e) {
              console.error("ERRO DOC FRENTE:", e.message);
              await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
          }
          break;

      case 'AGUARDANDO_DOC_VERSO':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
              return;
          }

          try {
              let mediaUrlV = obterMediaUrl(data);
              const base64Verso = await baixarArquivo(mediaUrlV);
              const isDocValido = await validarDocumentoIA(base64Verso); 

              if (isDocValido) {
                  await enviarFluxo(phone, TEXTOS.T06_ANALISE_BIO, AUDIOS.A06_ANALISE_BIO);
                  atualizarEstado(phone, leadRef, { LINK_DOC_VERSO: mediaUrlV, STATUS_CADASTRO: 'AGUARDANDO_EMAIL' });
                  
                  setTimeout(async () => {
                      await enviarFluxo(phone, TEXTOS.T07_PEDIR_EMAIL, AUDIOS.A07_PEDIR_EMAIL);
                  }, 4000); 
              } else {
                  await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
              }
          } catch (e) {
              console.error("ERRO DOC VERSO:", e.message);
              await enviarFluxo(phone, TEXTOS.T11_ERRO_DOC, AUDIOS.A11_ERRO_DOC);
          }
          break;

      case 'AGUARDANDO_EMAIL':
          if (!textoIn) return;
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(textoIn)) {
              atualizarEstado(phone, leadRef, { EMAIL: textoIn, STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarFluxo(phone, TEXTOS.T08_CONCLUSAO, AUDIOS.A08_CONCLUSAO);
          } else {
              await enviarFluxo(phone, TEXTOS.T12_ERRO_EMAIL, AUDIOS.A12_ERRO_EMAIL);
          }
          break;

      case 'CONCLUIDO':
          break;
  }
});

async function atualizarEstado(phone, leadRef, dados) {
    const atual = memoriaEstado.get(phone) || {};
    memoriaEstado.set(phone, { ...atual, ...dados });
    if (leadRef) {
        await leadRef.set(dados, { merge: true }).catch(e => console.log("Aviso: Falha ao salvar no DB."));
    }
}

function obterMediaUrl(data) {
    const url = data.link || (data.image && data.image.imageUrl) || (data.document && data.document.documentUrl) || (data.photo && data.photo.photoUrl) || "";
    if (!url || !url.startsWith('http')) throw new Error("Link não encontrado.");
    return url;
}

async function baixarArquivo(mediaUrl) {
    let tentativas = 3;
    while (tentativas > 0) {
        try {
            const res = await axios.get(mediaUrl, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return Buffer.from(res.data, 'binary').toString('base64');
        } catch (err) {
            await new Promise(r => setTimeout(r, 2000));
            tentativas--;
        }
    }
    throw new Error("Falha ao baixar após tentativas");
}

async function enviarFluxo(phone, texto, prefixoAudio) {
    await enviarMensagem(phone, texto);
    if (prefixoAudio) {
        console.log(`⏱️ Pausa de 2s para o áudio chegar depois do texto...`);
        await new Promise(r => setTimeout(r, 2000));
        await enviarAudioDireto(phone, prefixoAudio);
    }
}

// 🚨 SOLUÇÃO 404: Mudança para o modelo OFICIAL gemini-1.5-flash (O 404 acabou agora!)
async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Aja como auditor iGreen. Extraia dados em JSON da fatura anexa.
    IMPORTANTE: Retorne APENAS um objeto JSON válido.
    
    MUITO IMPORTANTE:
    O cliente pode enviar PDFs, fotos de papel OU FOTOS DE TELA DE COMPUTADOR. 
    QUALQUER imagem que contenha dados de energia (Equatorial, Cemig, consumos, valores) DEVE ter "VALIDO": true. 
    SÓ defina "VALIDO": false se for uma selfie ou paisagem sem sentido.

    Regras:
    - Consumo >= 150kWh torna ELEGIVEL = true.

    Retorne este formato exato:
    {
      "VALIDO": true,
      "TARIFA_SOCIAL": false,
      "ELEGIVEL": true,
      "NOME_CLIENTE": "Nome Completo",
      "CPF": "Apenas números",
      "CNPJ": "Apenas números",
      "UC": "Número da Unidade Consumidora",
      "ENDERECO_NUMERO": "Número da casa",
      "MEDIA_CONSUMO": 0
    }
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  
  let textoLimpo = res.data.candidates[0].content.parts[0].text;
  textoLimpo = textoLimpo.replace(/```json/g, '').replace(/```/g, '').trim();
  
  return JSON.parse(textoLimpo);
}

// SOLUÇÃO 404: Mudança para o modelo OFICIAL gemini-1.5-flash
async function validarDocumentoIA(base64) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    A imagem é uma foto válida de RG ou CNH brasileiro? 
    IMPORTANTE: Retorne APENAS um objeto JSON válido.
    {"VALIDO": true}
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  
  let textoLimpo = res.data.candidates[0].content.parts[0].text;
  textoLimpo = textoLimpo.replace(/```json/g, '').replace(/```/g, '').trim();
  
  return JSON.parse(textoLimpo).VALIDO;
}

async function enviarMensagem(phone, message) {
  const numeroLimpo = String(phone).replace(/\D/g, ''); 
  await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numeroLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(()=>{});
}

// 🚨 O RASTREADOR INTELIGENTE DE ÁUDIO (Busca o ficheiro onde ele estiver!)
async function enviarAudioDireto(phone, prefixo) {
    try {
        let filePath = null;
        const rootDir = __dirname;
        const audiosDir = path.join(__dirname, 'audios');
        
        // 1. Procura na pasta 'audios'
        if (fs.existsSync(audiosDir)) {
            const files = fs.readdirSync(audiosDir);
            const found = files.find(f => f.startsWith(prefixo) && f.endsWith('.mp3'));
            if (found) filePath = path.join(audiosDir, found);
        }
        
        // 2. Se não encontrou, procura na raiz do projeto
        if (!filePath && fs.existsSync(rootDir)) {
            const rootFiles = fs.readdirSync(rootDir);
            const rootFound = rootFiles.find(f => f.startsWith(prefixo) && f.endsWith('.mp3'));
            if (rootFound) filePath = path.join(rootDir, rootFound);
        }

        if (!filePath) {
            console.error(`[AVISO] Ficheiro MP3 começando por '${prefixo}' NÃO foi encontrado no GitHub! Verifique se os subiu corretamente.`);
            return;
        }
        
        const base64Audio = fs.readFileSync(filePath, { encoding: 'base64' });
        const dataUri = `data:audio/mpeg;base64,${base64Audio}`;
        const numeroLimpo = String(phone).replace(/\D/g, ''); 
        
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`, 
            { phone: numeroLimpo, audio: dataUri }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
        );
        console.log(`🔊 MÁGICA FEITA: Áudio ${path.basename(filePath)} encontrado e enviado com sucesso!`);
    } catch (e) {
        console.error(`❌ Erro ao enviar áudio ${prefixo}:`, e.message);
    }
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR ON!`));
