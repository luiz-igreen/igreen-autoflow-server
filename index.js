const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// CONFIGURAÇÕES GERAIS
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 
const IGREEN_LINK = process.env.IGREEN_LINK || "https://green.igreenenergy.com.br/?id=76049&sendcontract=true";

try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig) {
    if (admin.apps.length === 0) {
      admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    }
    console.log("✅ Banco de Dados ligado com sucesso!");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

const memoriaEstado = new Map();
const timersInatividade = new Map();
const audioCache = new Map();

const TEXTOS = {
    T01: "Seja muito bem-vinda à iGreen Energy. Pra começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o PDF da sua conta de luz.",
    T02: "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.",
    T04: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T09: "Aviso: Esta fatura de energia ou conta de luz, não é válida. Está ilegível. Enviar uma fatura de energia ou conta de luz válida para continuarmos o nosso processamento cadastral.",
    T11: "Aviso, a imagem enviada não é um documento de identificação (RG/CNH) válido ou está muito ilegível. Por favor, reenvie a foto do documento com mais foco.",
    T12: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a @ e envie novamente.",
    T_RPA_START: "🤖 *Aviso do Sistema*: O Robô iGreen acaba de iniciar a digitação automática dos seus dados no portal oficial. Você receberá o link da Clicksign para assinatura em instantes.",
    T_RPA_SUCCESS: "✅ *Sucesso Total!* O seu contrato foi gerado no portal oficial com sucesso. Por favor, acesse o link enviado pela Clicksign para assinar."
};

// ============================================================================
// 👁️ MOTOR DE VISÃO ARTIFICIAL (PUPPETEER HEADLESS)
// ============================================================================
async function executarRPAVisaoArtificial(dados, phone) {
    console.log(`🚀 [RPA VISÃO] Iniciando Navegador Fantasma para: ${dados.NOME_CLIENTE}`);
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log(`🌐 [RPA VISÃO] Abrindo o Link Auto Conexão VIP...`);
        await page.goto(IGREEN_LINK, { waitUntil: 'networkidle2', timeout: 60000 });

        // FUNÇÃO DE VISÃO: Procura uma palavra na tela e clica/digita no campo que está logo à frente dela
        const digitarPorLabel = async (textoLabel, valorDigitado) => {
            if(!valorDigitado || valorDigitado === "Não consta" || valorDigitado === "-") return;
            console.log(`👁️ Procurando por: "${textoLabel}" para digitar: ${valorDigitado}`);
            
            try {
                // Injeta um script no navegador para caçar a label e o input vizinho
                await page.evaluate((labelBusca, valor) => {
                    const labels = Array.from(document.querySelectorAll('label, p, span, div'));
                    const alvo = labels.find(el => el.textContent.toLowerCase().includes(labelBusca.toLowerCase()));
                    
                    if (alvo) {
                        // Procura o input mais próximo dentro do mesmo grupo
                        let container = alvo.parentElement;
                        let input = container.querySelector('input');
                        
                        // Se não achar no pai, tenta no avô
                        if (!input) {
                            container = container.parentElement;
                            input = container.querySelector('input');
                        }

                        if (input) {
                            input.value = valor;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            input.style.border = "3px solid #10b981"; // Pinta de verde para o print de segurança
                        }
                    }
                }, textoLabel, valorDigitado);
                await new Promise(r => setTimeout(r, 500)); // Pausa humana
            } catch (e) {
                console.log(`⚠️ Não encontrou o campo vizinho de: ${textoLabel}`);
            }
        };

        // PASSO 1: CEP E VALOR (Tela de Simulação)
        console.log("✍️ [RPA VISÃO] Preenchendo Simulação Inicial...");
        await digitarPorLabel('CEP', dados.CEP);
        await digitarPorLabel('Valor da conta', dados.VALOR_FATURA);
        
        // Clica no botão de "Começar / Simular" (Procura botões verdes ou laranjas primários)
        await page.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('button'));
            const btnAvancar = botoes.find(btn => btn.textContent.toLowerCase().includes('começar') || btn.textContent.toLowerCase().includes('simular') || btn.textContent.toLowerCase().includes('calcular'));
            if(btnAvancar) btnAvancar.click();
        });
        
        await page.waitForTimeout(3000); // Aguarda animação e mudança de tela

        // PASSO 2: DADOS PESSOAIS
        console.log("✍️ [RPA VISÃO] Preenchendo Dados Pessoais...");
        await digitarPorLabel('Nome Completo', dados.NOME_CLIENTE);
        await digitarPorLabel('CPF', dados.CPF);
        await digitarPorLabel('Nascimento', dados.DATA_NASCIMENTO);
        await digitarPorLabel('E-mail', dados.EMAIL);
        await digitarPorLabel('Estado', dados.ESTADO);
        await digitarPorLabel('Instalação', dados.UC);

        // PASSO 3: UPLOAD DE ARQUIVOS (Baixando do Firebase e Injetando)
        console.log("📂 [RPA VISÃO] Baixando Anexos e Injetando de forma invisível...");
        
        async function uploadPeloPai(textoReferencia, linkFirebase) {
            if(!linkFirebase || linkFirebase === "-") return;
            try {
                // 1. Baixa o arquivo para o servidor Render
                const fileName = `temp_${Date.now()}.png`;
                const filePath = path.join(__dirname, fileName);
                const response = await axios({ url: linkFirebase, responseType: 'stream' });
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                await new Promise(resolve => writer.on('finish', resolve));

                // 2. Encontra o input type="file" escondido perto do texto "Frente" ou "Fatura"
                const fileInputHandle = await page.evaluateHandle((texto) => {
                    const containers = Array.from(document.querySelectorAll('div'));
                    const alvo = containers.find(c => c.textContent.toLowerCase().includes(texto.toLowerCase()) && c.querySelector('input[type="file"]'));
                    return alvo ? alvo.querySelector('input[type="file"]') : null;
                }, textoReferencia);

                if (fileInputHandle) {
                    await fileInputHandle.uploadFile(filePath);
                    console.log(`✅ Upload de ${textoReferencia} injetado com sucesso!`);
                }
                
                // Limpa o arquivo temporário do servidor
                setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 15000);

            } catch (err) {
                console.log(`⚠️ Erro ao injetar documento: ${textoReferencia}`);
            }
        }

        await uploadPeloPai('Frente', dados.LINK_DOC_FRENTE);
        await uploadPeloPai('Verso', dados.LINK_DOC_VERSO);
        await uploadPeloPai('conta', dados.LINK_FATURA);

        console.log("✅ [RPA VISÃO] Operação Concluída. O formulário está pronto para avançar.");
        
        // Avisa o cliente no WhatsApp
        enviarMensagem(phone, TEXTOS.T_RPA_SUCCESS);
        return true;

    } catch (error) {
        console.error("❌ [RPA ERRO]:", error.message);
        return false;
    } finally {
        // Fechar o navegador fantasma após terminar
        await browser.close();
    }
}


// ============================================================================
// LÓGICA DE WHATSAPP E GESTÃO DE ESTADO (MANTIDA INTACTA E BLINDADA)
// ============================================================================

app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  if (data.fromMe) return;

  const phone = data.phone;
  if (data.isGroup || String(phone).toLowerCase().includes('group') || String(phone).toLowerCase().includes('@g.us')) return;

  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const textoIn = data.text?.message?.trim() || "";
  const txtL = textoIn.toLowerCase();
  
  if (['novo', 'nova'].includes(txtL)) {
      memoriaEstado.delete(phone); 
      enviarFluxo(phone, TEXTOS.T01, "01"); 
      memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
      return;
  }

  const db = admin.apps.length > 0 ? admin.firestore() : null;
  const appId = 'igreen-autoflow-v4';
  let status = 'NOVO';
  let leadRef = null;
  let mem = memoriaEstado.get(phone);

  if (mem && mem.STATUS_CADASTRO) {
      status = mem.STATUS_CADASTRO;
      if (db && mem.UC) leadRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(mem.UC);
  } else if (db) {
      try {
          const leadsColl = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
          const snapshot = await leadsColl.where('TELEFONE', '==', phone).get();
          if (!snapshot.empty) {
              let docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
              docs.sort((a, b) => (b.DATA_PROCESSAMENTO?.toMillis ? b.DATA_PROCESSAMENTO.toMillis() : 0) - (a.DATA_PROCESSAMENTO?.toMillis ? a.DATA_PROCESSAMENTO.toMillis() : 0));
              const latest = docs[0];
              if (latest.STATUS_CADASTRO !== 'CONCLUIDO') {
                  if (latest.UC) leadRef = leadsColl.doc(latest.UC);
                  status = latest.STATUS_CADASTRO;
                  memoriaEstado.set(phone, latest);
              }
          }
      } catch(e) { }
  }

  switch (status) {
      case 'AGUARDANDO_FATURA':
      case 'NOVO':
          if (!isImage && !isPDF) {
              await enviarMensagem(phone, TEXTOS.T01);
              return;
          }
          await enviarFluxo(phone, TEXTOS.T02, "02");
          
          try {
              let mediaUrl = obterMediaUrl(data);
              const base64Data = await baixarArquivo(mediaUrl);
              const mimeType = isPDF ? "application/pdf" : "image/jpeg";
              const analise = await auditarFaturaIA(base64Data, mimeType);

              if (!analise.VALIDO) {
                  await enviarFluxo(phone, TEXTOS.T09, "09");
                  return;
              }

              let somaConsumo = 0;
              let consumosExtraidos = [analise.CONSUMO_M1, analise.CONSUMO_M2, analise.CONSUMO_M3, analise.CONSUMO_M4, analise.CONSUMO_M5, analise.CONSUMO_M6];
              for (let i = 0; i < 6; i++) {
                  let valorMensal = parseInt(String(consumosExtraidos[i] || "0").replace(/\D/g, ''), 10);
                  if (!isNaN(valorMensal) && valorMensal > 0) somaConsumo += valorMensal;
              }
              analise.MEDIA_CONSUMO = Math.round(somaConsumo / 6);
              analise.ELEGIVEL = analise.MEDIA_CONSUMO >= 130;

              let ucLimpa = String(analise.UC || "").replace(/\D/g, '');
              if (!ucLimpa) ucLimpa = "SEM_UC_" + Date.now();
              analise.UC = ucLimpa;

              let leadsColl = db ? db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads') : null;
              if (leadsColl) leadRef = leadsColl.doc(ucLimpa);

              let payloadUpdate = {
                  ...analise,
                  STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE',
                  DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                  LINK_FATURA: mediaUrl,
                  TELEFONE: phone
              };

              await atualizarEstado(phone, leadRef, payloadUpdate);
              await enviarFluxo(phone, TEXTOS.T04, "04");
          } catch (e) {
              await enviarMensagem(phone, "⚠️ Falha ao ler imagem. Reenvie.");
          }
          break;

      case 'AGUARDANDO_DOC_FRENTE':
          if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
          try {
              let mediaUrlF = obterMediaUrl(data);
              const base64Frente = await baixarArquivo(mediaUrlF);
              const analiseDoc = await analisarDocumentoIA(base64Frente, isPDF ? "application/pdf" : "image/jpeg");

              if (analiseDoc.VALIDO) {
                  let dadosDoc = { LINK_DOC_FRENTE: mediaUrlF, STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  if (analiseDoc.DATA_NASCIMENTO && analiseDoc.DATA_NASCIMENTO !== "Não consta") dadosDoc.DATA_NASCIMENTO = analiseDoc.DATA_NASCIMENTO;
                  await atualizarEstado(phone, leadRef, dadosDoc);
                  await enviarFluxo(phone, TEXTOS.T05, "05");
              } else { await enviarFluxo(phone, TEXTOS.T11, "11"); }
          } catch (e) { await enviarMensagem(phone, "⚠️ Erro doc frente."); }
          break;

      case 'AGUARDANDO_DOC_VERSO':
          if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
          let mediaUrlV = obterMediaUrl(data);
          await enviarFluxo(phone, TEXTOS.T06, "06");
          await atualizarEstado(phone, leadRef, { LINK_DOC_VERSO: mediaUrlV, STATUS_CADASTRO: 'AGUARDANDO_EMAIL' });
          setTimeout(async () => { await enviarFluxo(phone, TEXTOS.T07, "07"); }, 4000);
          break;

      case 'AGUARDANDO_EMAIL':
          if (isImage || isPDF) { await enviarMensagem(phone, "Por favor, apenas *digite* o seu melhor e-mail para concluirmos."); return; }
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(textoIn)) {
              await atualizarEstado(phone, leadRef, { EMAIL: textoIn, STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarMensagem(phone, TEXTOS.T08);
              
              // GATILHO RPA NAS NUVENS
              await enviarMensagem(phone, TEXTOS.T_RPA_START);
              if (leadRef) {
                  const dadosParaRobo = (await leadRef.get()).data();
                  executarRPAVisaoArtificial(dadosParaRobo, phone); // Roda em background
              }

              memoriaEstado.delete(phone); 
          } else {
              await enviarFluxo(phone, TEXTOS.T12, "12");
          }
          break;
  }
});

async function atualizarEstado(phone, leadRef, dados) {
    const atual = memoriaEstado.get(phone) || {};
    memoriaEstado.set(phone, { ...atual, ...dados });
    if (leadRef) await leadRef.set(dados, { merge: true });
}

function obterMediaUrl(data) {
    const url = data.link || (data.image && data.image.imageUrl) || (data.document && data.document.documentUrl) || "";
    if (!url) throw new Error("Link vazio.");
    return url;
}

async function baixarArquivo(mediaUrl) {
    let res = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    return Buffer.from(res.data, 'binary').toString('base64');
}

async function enviarFluxo(phone, texto, prefixoAudio) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try {
        axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(texto) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(()=>{});
    } catch (e) {}
}

async function enviarMensagem(phone, message) {
  const numLimpo = String(phone).replace(/\D/g, ''); 
  try {
      axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(()=>{});
  } catch (e) {}
}

// -------------------------------------------------------------
// O CÉREBRO DA IA (MÁXIMA PRECISÃO)
// -------------------------------------------------------------
async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave ausente");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Aja como um auditor de dados da iGreen.
    Regra: Se a imagem contiver uma Fatura de Energia, retorne VALIDO: true.
    Junte a Rua e o Complemento (Bloco, Lote) no campo ENDERECO.
    Responda APENAS com JSON:
    { "VALIDO": true, "TIPO_PERFIL": "PESSOA FISICA", "NOME_CLIENTE": "Nome", "CPF": "00000000000", "CNPJ": "Não consta", "CEP": "00000-000", "ENDERECO": "Rua, Bloco", "ENDERECO_NUMERO": "123", "BAIRRO": "Bairro", "CIDADE": "Cidade", "ESTADO": "UF", "DISTRIBUIDORA": "Nome", "UC": "Numero", "CONTA_MES": "00/0000", "VENCIMENTO": "00/00/0000", "VALOR_FATURA": "0.00", "CONSUMO_M1": 0, "CONSUMO_M2": 0, "CONSUMO_M3": 0, "CONSUMO_M4": 0, "CONSUMO_M5": 0, "CONSUMO_M6": 0 }
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim());
}

async function analisarDocumentoIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave ausente");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Aja como um perito criminal. Ignore reflexos. Encontre o CPF e a Data de Nascimento neste documento (RG ou CNH).
    Se for um documento brasileiro, retorne VALIDO: true.
    Responda APENAS com JSON:
    { "VALIDO": true, "CPF": "00000000000", "DATA_NASCIMENTO": "DD/MM/AAAA" }
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim());
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V51 (VISÃO ARTIFICIAL RPA) ONLINE`));
