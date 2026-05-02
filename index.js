const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 

const IGREEN_USER = process.env.IGREEN_USER || "";
const IGREEN_PASS = process.env.IGREEN_PASS || "";

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
    T03: "Fatura auditada com sucesso. Identifiquei o seu CEP, mas não encontrei o número da residência. Por favor, digite o número da sua casa ou apartamento pra prosseguirmos.",
    T04: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T09: "Aviso: Esta fatura de energia ou conta de luz, não é válida. Está ilegível. Enviar uma fatura de energia ou conta de luz válida para continuarmos o nosso processamento cadastral.",
    T10: "Atenção, identificamos que a sua conta possui a classificação de baixa renda ou tarifa social. Para proteger o seu benefício governamental, a iGreen não atende esta modalidade, pois a alteração poderia causar a perda do seu subsídio. O processo foi encerrado por segurança. Agradecemos o seu contacto!",
    T11: "Aviso, a imagem enviada não é um documento de identificação (RG/CNH) válido ou está muito ilegível. Por favor, reenvie a foto do documento com mais foco.",
    T12: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a @ e envie novamente.",
    T13: "Atenção, você solicitou o cancelamento. Tem certeza que deseja excluir todos os dados enviados até agora? Digite um para sim, cancelar tudo, ou dois para não, e continuar o cadastro.",
    T20: "Entendido. Vou transferir o seu atendimento pra um de nossos consultores especialistas. Aguarde um instante, por favor.",
    T21: "Devido à falta de resposta por um longo período, o seu pré-cadastro foi cancelado por medida de segurança.\n\nQuando estiver com os seus documentos em mãos, basta enviar a palavra *NOVO* para recomeçarmos o processo. A iGreen agradece!",
    T25: "Olá! Agradecemos muito o seu interesse. 💚\n\nApós analisar a sua fatura, verificamos que a sua média de consumo está abaixo do mínimo exigido no momento para a sua região.\n\nPor isso, não poderemos prosseguir com o cadastro agora. Guardaremos o seu contacto para o avisar em futuras oportunidades!",
    T29: "Operação cancelada com sucesso! ✅\n\nO sistema está livre para o próximo atendimento.\nA iGreen Energy agradece o seu contato e a sua confiança! Tenha um excelente dia! 💚",
    T_RPA_START: "🤖 *Aviso do Sistema*: O Robô iGreen acaba de iniciar a digitação automática dos seus dados no portal oficial. O seu contrato será gerado em instantes.",
    T_RPA_SUCCESS: "✅ *Sucesso Total!* O seu contrato foi gerado no portal oficial com sucesso. Você receberá o link da Clicksign para assinatura em instantes no seu e-mail e aqui no WhatsApp."
};

// =========================================================================
// O MOTOR RPA (PUPPETEER) - O ROBÔ QUE NAVEGA NAS NUVENS
// =========================================================================
async function executarRPAIgreen(dados) {
    console.log(`🚀 [RPA] A iniciar navegação fantasma para: ${dados.NOME_CLIENTE}`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        console.log("🔑 [RPA] Acedendo ao login...");
        await page.goto('https://mundoigreen.com.br/login', { waitUntil: 'networkidle2' });
        
        if (await page.$('#email')) {
            await page.type('#email', IGREEN_USER);
            await page.type('#password', IGREEN_PASS);
            await page.click('button[type="submit"]');
            await page.waitForNavigation();
            console.log("🔑 [RPA] Login efetuado com sucesso.");
        }

        console.log("📂 [RPA] Indo para Nova Conexão...");
        await page.goto('https://mundoigreen.com.br/dashboard/conexao-green/novo', { waitUntil: 'networkidle2' });

        console.log("✍️ [RPA] Injetando dados do cliente...");
        const camposTexto = {
            'input[name="nome"]': dados.NOME_CLIENTE || "",
            'input[name="cpf"]': dados.CPF || dados.MASCARA_CPF || "",
            'input[name="email"]': dados.EMAIL || "",
            'input[name="whatsapp"]': dados.TELEFONE || ""
        };

        for (const [seletor, valor] of Object.entries(camposTexto)) {
            const campo = await page.$(seletor);
            if (campo) await page.type(seletor, valor);
        }
        
        if (dados.LINK_FATURA) {
            console.log("📄 [RPA] A fazer upload da fatura original...");
            const faturaPath = path.join(__dirname, `temp_fatura_${Date.now()}.pdf`);
            const response = await axios({ url: dados.LINK_FATURA, responseType: 'stream' });
            const writer = fs.createWriteStream(faturaPath);
            response.data.pipe(writer);
            
            await new Promise((resolve) => writer.on('finish', resolve));
            const inputUpload = await page.$('input[name="fatura_file"]');
            if (inputUpload) await inputUpload.uploadFile(faturaPath);
            
            setTimeout(() => { if (fs.existsSync(faturaPath)) fs.unlinkSync(faturaPath); }, 10000);
        }

        console.log("✅ [RPA] Operação de injeção concluída com sucesso!");
        return true;

    } catch (error) {
        console.error("❌ [RPA ERRO]:", error.message);
        return false;
    } finally {
        await browser.close();
    }
}

function obterSaudacao() {
    const horaAtual = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"})).getHours();
    if (horaAtual >= 5 && horaAtual < 12) return "Bom dia";
    if (horaAtual >= 12 && horaAtual < 18) return "Boa tarde";
    return "Boa noite";
}

function cancelarTimeout(phone) {
    if (timersInatividade.has(phone)) {
        clearTimeout(timersInatividade.get(phone));
        timersInatividade.delete(phone);
    }
}

function configurarTimeoutInatividade(phone, ucInacabada = null) {
    cancelarTimeout(phone); 
    const timeoutId = setTimeout(async () => {
        await enviarFluxo(phone, TEXTOS.T21, "21");
        if (ucInacabada) {
            const db = admin.apps.length > 0 ? admin.firestore() : null;
            if (db) {
                await db.collection('artifacts').doc('igreen-autoflow-v4').collection('public').doc('data').collection('leads').doc(ucInacabada).delete().catch(()=>{});
            }
        }
        memoriaEstado.delete(phone);
        timersInatividade.delete(phone);
    }, 15 * 60 * 1000); 
    timersInatividade.set(phone, timeoutId);
}

// ==========================================
// WEBHOOK PRINCIPAL Z-API
// ==========================================
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
  
  cancelarTimeout(phone);
  
  const chamadasMenu = ['oi', 'olá', 'ola', 'menu', 'iniciar'];
  const chamadasNovo = ['novo', 'nova'];
  
  if (!isImage && !isPDF) {
      if (chamadasMenu.includes(txtL)) {
          const saudacao = obterSaudacao();
          const menuText = `${saudacao}! Aqui é o assistente virtual da iGreen Energy 💚\n\nInforme qual a opção que você deseja iniciar:\n\n1️⃣ - Novo Cadastro\n2️⃣ - Atualizar Cadastro\n3️⃣ - Cancelar Cadastro que Iniciei`;
          enviarMensagem(phone, menuText); 
          memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_OPCAO_MENU', TELEFONE: phone });
          configurarTimeoutInatividade(phone, null);
          return; 
      }
      if (chamadasNovo.includes(txtL)) {
          memoriaEstado.delete(phone); 
          enviarFluxo(phone, TEXTOS.T01, "01"); 
          memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
          configurarTimeoutInatividade(phone, null);
          return;
      }
  }

  const db = admin.apps.length > 0 ? admin.firestore() : null;
  const appId = 'igreen-autoflow-v4';
  
  let status = 'NOVO';
  let leadRef = null;
  let mem = memoriaEstado.get(phone);
  let leadData = mem || {};

  if (mem && mem.STATUS_CADASTRO) {
      status = mem.STATUS_CADASTRO;
      if (db && mem.UC) leadRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(mem.UC);
  } else if (db) {
      try {
          const leadsColl = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
          const snapshot = await leadsColl.where('TELEFONE', '==', phone).get();
          if (!snapshot.empty) {
              let docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
              docs.sort((a, b) => {
                  const ta = a.DATA_PROCESSAMENTO?.toMillis ? a.DATA_PROCESSAMENTO.toMillis() : 0;
                  const tb = b.DATA_PROCESSAMENTO?.toMillis ? b.DATA_PROCESSAMENTO.toMillis() : 0;
                  return tb - ta; 
              });
              const latest = docs[0];
              if (!['CONCLUIDO', 'RECUSADO_CONSUMO', 'RECUSADO_TARIFA_SOCIAL', 'NOME_DIVERGENTE', 'CONFIRMANDO_CANCELAMENTO'].includes(latest.STATUS_CADASTRO)) {
                  if (latest.UC) leadRef = leadsColl.doc(latest.UC);
                  status = latest.STATUS_CADASTRO;
                  leadData = latest;
                  memoriaEstado.set(phone, latest);
              }
          }
      } catch(e) { }
  }

  if (txtL === 'cancelar' && status !== 'CONFIRMANDO_RECADASTRO' && status !== 'CONFIRMANDO_CANCELAMENTO') {
      enviarFluxo(phone, TEXTOS.T13, "13"); 
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONFIRMANDO_CANCELAMENTO', PREV_STATUS: status });
      configurarTimeoutInatividade(phone, mem?.UC);
      return;
  }
  if (txtL.match(/(atendente|humano|consultor|especialista|falar com alg)/)) {
      enviarFluxo(phone, TEXTOS.T20, "20"); 
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'TRANSBORDO_HUMANO' });
      return;
  }

  if (status === 'CONFIRMANDO_CANCELAMENTO') {
      const txtLimpo = textoIn.replace(/\D/g, '');
      if (txtLimpo === '1') {
          if (leadRef) await leadRef.delete();
          memoriaEstado.delete(phone);
          await enviarMensagem(phone, "Cancelamento confirmado. Dados apagados. A iGreen agradece o seu contato!");
      } else if (txtLimpo === '2') {
          await enviarMensagem(phone, "Cancelamento abortado. Por favor, envie o documento solicitado anteriormente.");
          const prev = memoriaEstado.get(phone)?.PREV_STATUS || 'NOVO';
          await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: prev });
          configurarTimeoutInatividade(phone, mem?.UC);
      } else {
          await enviarMensagem(phone, "Opção inválida. Digite 1 para cancelar ou 2 para continuar.");
          configurarTimeoutInatividade(phone, mem?.UC);
      }
      return;
  }

  switch (status) {
      case 'AGUARDANDO_OPCAO_MENU':
          if (isImage || isPDF) {
              await enviarMensagem(phone, "Por favor, digite o *número* da opção desejada (1, 2 ou 3) antes de me enviar documentos. 🎯");
              configurarTimeoutInatividade(phone, null);
              return;
          }
          const opMenu = textoIn.replace(/\D/g, '');
          if (opMenu === '1') {
              await enviarFluxo(phone, TEXTOS.T01, "01"); 
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' });
              configurarTimeoutInatividade(phone, null);
          } else if (opMenu === '2') {
              await enviarMensagem(phone, "Perfeito! Para atualizar os seus dados, por favor, me envie a foto ou PDF da sua conta de luz mais recente.");
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' });
              configurarTimeoutInatividade(phone, null);
          } else if (opMenu === '3') {
              await enviarFluxo(phone, TEXTOS.T13, "13");
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONFIRMANDO_CANCELAMENTO', PREV_STATUS: 'AGUARDANDO_OPCAO_MENU' });
              configurarTimeoutInatividade(phone, null);
          } else {
              await enviarMensagem(phone, "Opção inválida. Por favor, digite *1*, *2* ou *3*.");
              configurarTimeoutInatividade(phone, null);
          }
          break;

      case 'AGUARDANDO_FATURA':
      case 'NOVO':
          if (!isImage && !isPDF) {
              const saudacaoRep = obterSaudacao();
              const menuRep = `${saudacaoRep}! Aqui é o assistente virtual da iGreen Energy 💚\n\nInforme qual a opção que você deseja iniciar:\n\n1️⃣ - Novo Cadastro\n2️⃣ - Atualizar Cadastro\n3️⃣ - Cancelar Cadastro que Iniciei`;
              await enviarMensagem(phone, menuRep);
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_OPCAO_MENU' });
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
              if (analise.TARIFA_SOCIAL) {
                  await enviarFluxo(phone, TEXTOS.T10, "10");
                  return;
              }

              // =========================================================================
              // A MATEMÁTICA EXATA DA EQUATORIAL (SOMA 6 MESES DE BAIXO E DIVIDE POR 6)
              // =========================================================================
              let somaConsumo = 0;
              let consumosExtraidos = [
                  analise.CONSUMO_M1, analise.CONSUMO_M2, analise.CONSUMO_M3, 
                  analise.CONSUMO_M4, analise.CONSUMO_M5, analise.CONSUMO_M6
              ];
              
              for (let i = 0; i < 6; i++) {
                  let valorMensal = parseInt(String(consumosExtraidos[i] || "0").replace(/\D/g, ''), 10);
                  if (!isNaN(valorMensal) && valorMensal > 0) {
                      somaConsumo += valorMensal;
                  }
              }
              
              // Regra Inquebrável: Soma os extraídos e divide por 6.
              analise.MEDIA_CONSUMO = Math.round(somaConsumo / 6);
              analise.ELEGIVEL = analise.MEDIA_CONSUMO >= 150;

              if (analise.ELEGIVEL) {
                  let proximoStatus = 'AGUARDANDO_DOC_FRENTE';
                  let proximoTexto = TEXTOS.T04;
                  
                  let ucLimpa = String(analise.UC || "").replace(/\D/g, '');
                  if (!ucLimpa) ucLimpa = "SEM_UC_" + Date.now();
                  analise.UC = ucLimpa;

                  let leadsColl = db ? db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads') : null;
                  if (leadsColl) leadRef = leadsColl.doc(ucLimpa);

                  let payloadUpdate = {
                      ...analise,
                      STATUS_CADASTRO: proximoStatus,
                      DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                      LINK_FATURA: mediaUrl,
                      TELEFONE: phone
                  };

                  await atualizarEstado(phone, leadRef, payloadUpdate);
                  await enviarFluxo(phone, proximoTexto, "04");
                  configurarTimeoutInatividade(phone, ucLimpa);
              } else {
                  await enviarFluxo(phone, TEXTOS.T25, "25");
                  memoriaEstado.delete(phone); 
              }
          } catch (e) {
              await enviarMensagem(phone, "⚠️ Falha ao ler imagem. Reenvie.");
          }
          break;

      case 'CONFIRMANDO_RECADASTRO':
          if (isImage || isPDF) {
              await enviarMensagem(phone, "Por favor, digite *1*, *2* ou *3* para escolher uma das opções acima antes de me enviar novos documentos. 🎯");
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          const tLimpo = textoIn.replace(/\D/g, ''); 
          if (tLimpo === '1' || textoIn.toLowerCase() === 'novo') {
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
              await enviarFluxo(phone, TEXTOS.T04, "04");
              configurarTimeoutInatividade(phone, mem.UC);
          } else if (tLimpo === '2' || textoIn.toLowerCase() === 'continuar') {
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarMensagem(phone, "✅ Perfeito! A sua nova fatura foi atualizada na nossa base de dados e os seus documentos originais foram mantidos em segurança.\n\nTudo pronto para o próximo passo no painel iGreen! 💚");
              memoriaEstado.delete(phone); 
              cancelarTimeout(phone);
          } else if (tLimpo === '3' || textoIn.toLowerCase() === 'cancelar' || textoIn.toLowerCase() === 'nao') {
              await atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONCLUIDO' }); 
              memoriaEstado.delete(phone); 
              await enviarMensagem(phone, TEXTOS.T29); 
              cancelarTimeout(phone);
          } else {
              await enviarMensagem(phone, "Opção inválida.\n\nDigite *1* para Novo Cadastro\nDigite *2* para Continuar\nDigite *3* para Cancelar");
              configurarTimeoutInatividade(phone, mem.UC);
          }
          break;

      case 'AGUARDANDO_CASA':
          if (isImage || isPDF) {
              await enviarMensagem(phone, "Aviso: Eu pedi para você digitar o número da residência, mas você me enviou um documento/imagem. 😅\n\nPor favor, *digite* apenas o número da sua casa ou apartamento.");
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          if (!textoIn) return;
          const numeroLimpoDaMensagem = textoIn.replace(/\D/g, ''); 
          const numeroFinalSalvo = numeroLimpoDaMensagem || "S/N"; 
          await atualizarEstado(phone, leadRef, { ENDERECO_NUMERO: numeroFinalSalvo, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
          await enviarFluxo(phone, TEXTOS.T04, "04");
          configurarTimeoutInatividade(phone, mem.UC);
          break;

      case 'AGUARDANDO_DOC_FRENTE':
          if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
          try {
              let mediaUrlF = obterMediaUrl(data);
              const base64Frente = await baixarArquivo(mediaUrlF);
              const analiseDoc = await analisarDocumentoIA(base64Frente, isPDF ? "application/pdf" : "image/jpeg", "FRENTE");

              if (analiseDoc.VALIDO) {
                  let dadosDoc = { LINK_DOC_FRENTE: mediaUrlF, STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  await atualizarEstado(phone, leadRef, dadosDoc);
                  await enviarFluxo(phone, TEXTOS.T05, "05");
                  configurarTimeoutInatividade(phone, mem.UC);
              } else { await enviarFluxo(phone, TEXTOS.T11, "11"); }
          } catch (e) { await enviarMensagem(phone, "⚠️ Erro doc frente."); }
          break;

      case 'AGUARDANDO_DOC_VERSO':
          if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
          try {
              let mediaUrlV = obterMediaUrl(data);
              const base64Verso = await baixarArquivo(mediaUrlV);
              const analiseDocV = await analisarDocumentoIA(base64Verso, isPDF ? "application/pdf" : "image/jpeg", "VERSO");

              if (analiseDocV.VALIDO) {
                  await enviarFluxo(phone, TEXTOS.T06, "06");
                  let dadosDocV = { LINK_DOC_VERSO: mediaUrlV, STATUS_CADASTRO: 'AGUARDANDO_EMAIL' };
                  if (analiseDocV.CPF && analiseDocV.CPF !== "Não consta") dadosDocV.CPF = analiseDocV.CPF;
                  await atualizarEstado(phone, leadRef, dadosDocV);
                  setTimeout(async () => { await enviarFluxo(phone, TEXTOS.T07, "07"); }, 4000);
              } else { await enviarFluxo(phone, TEXTOS.T11, "11"); }
          } catch (e) { await enviarMensagem(phone, "⚠️ Erro doc verso."); }
          break;

      case 'AGUARDANDO_EMAIL':
          if (isImage || isPDF) {
              await enviarMensagem(phone, "Por favor, apenas *digite* o seu melhor e-mail para concluirmos.");
              return; 
          }
          if (!textoIn) return;
          
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(textoIn)) {
              await atualizarEstado(phone, leadRef, { EMAIL: textoIn, STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarMensagem(phone, TEXTOS.T08);
              
              // Se tiver os dados de acesso configurados no Render, dispara o Robô
              if (IGREEN_USER !== "" && IGREEN_PASS !== "") {
                  await enviarMensagem(phone, TEXTOS.T_RPA_START);
                  if (leadRef) {
                      const dadosParaRobo = (await leadRef.get()).data();
                      executarRPAIgreen(dadosParaRobo).then(sucesso => {
                          if (sucesso) enviarMensagem(phone, TEXTOS.T_RPA_SUCCESS);
                      });
                  }
              }

              memoriaEstado.delete(phone); 
              cancelarTimeout(phone); 
          } else {
              await enviarFluxo(phone, TEXTOS.T12, "12");
          }
          break;
  }
});

async function atualizarEstado(phone, leadRef, dados) {
    const atual = memoriaEstado.get(phone) || {};
    memoriaEstado.set(phone, { ...atual, ...dados });
    if (leadRef) await leadRef.set(dados, { merge: true }).catch(e => console.error("Falha DB", e));
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
        if (prefixoAudio) setTimeout(async () => await enviarAudioDireto(phone, prefixoAudio, texto), 2000);
    } catch (e) {}
}

async function enviarMensagem(phone, message) {
  const numLimpo = String(phone).replace(/\D/g, ''); 
  try {
      axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(()=>{});
  } catch (e) {}
}

function buscarAudioRecursivo(diretorio, prefixo) {
    if (audioCache.has(prefixo)) return audioCache.get(prefixo);
    let arquivos = fs.readdirSync(diretorio);
    for (let arquivo of arquivos) {
        if (arquivo === 'node_modules' || arquivo === '.git') continue; 
        let c = path.join(diretorio, arquivo);
        if (fs.statSync(c).isDirectory()) {
            let res = buscarAudioRecursivo(c, prefixo); 
            if (res) return res;
        } else if (arquivo.startsWith(prefixo) && arquivo.endsWith('.mp3')) {
            audioCache.set(prefixo, c);
            return c; 
        }
    }
    return null;
}

async function enviarAudioDireto(phone, prefixo, txt) {
    try {
        const numLimpo = String(phone).replace(/\D/g, ''); 
        const filePath = buscarAudioRecursivo(__dirname, prefixo);
        if (filePath) {
            const b64 = fs.readFileSync(filePath, { encoding: 'base64' });
            axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`, { phone: numLimpo, audio: `data:audio/mpeg;base64,${b64}` }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(()=>{});
        }
    } catch (e) {}
}

// -------------------------------------------------------------
// O CÉREBRO DA IA (PREPARADO PARA LER DE BAIXO PARA CIMA)
// -------------------------------------------------------------

async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave ausente");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Aja como um auditor de dados da iGreen.
    🚨 REGRA 1 - DETECÇÃO 🚨: Se a imagem contiver UMA FATURA DE ENERGIA, retorne "VALIDO": true. SÓ retorne false se for ABSOLUTAMENTE um objeto aleatório. Neste caso, descreva em "OBJETO_IDENTIFICADO".
    🚨 REGRA 2 - DATAS E ENDEREÇOS EXTRAS 🚨: 
    1. Identifique o Mês de Referência (ex: 04/2026) -> "CONTA_MES". 
    2. Identifique o Vencimento -> "VENCIMENTO" (DD/MM/AAAA). 
    3. Identifique rigorosamente Bairro e Cidade -> "BAIRRO" e "CIDADE". 
    4. Identifique o Valor Total -> "VALOR_FATURA".
    🚨 REGRA 3 - PF/PJ 🚨: Se achar CPF -> "MASCARA_CPF". Se achar CNPJ -> "MASCARA_CNPJ".
    🚨 REGRA 4 - HISTÓRICO EQUATORIAL (MUITO IMPORTANTE) 🚨:
    Não leia a média impressa na conta. 
    Encontre o quadro de "Histórico de Consumo" em kWh. 
    Extraia exatamente os ÚLTIMOS 6 MESES lendo DE BAIXO PARA CIMA na tabela.
    Atribua apenas os valores numéricos de kWh aos campos "CONSUMO_M1" (de baixo, o mais recente) até "CONSUMO_M6" (subindo). Coloque 0 se não houver 6 meses.
    
    Responda EXATAMENTE com este objeto JSON:
    { "VALIDO": true, "OBJETO_IDENTIFICADO": "", "TARIFA_SOCIAL": false, "TIPO_PERFIL": "PESSOA FISICA", "NOME_CLIENTE": "Nome", "MASCARA_CPF": "Não consta", "CPF": "Não consta", "MASCARA_CNPJ": "Não consta", "CNPJ": "Não consta", "CEP": "00000-000", "ENDERECO": "Rua", "ENDERECO_NUMERO": "123", "BAIRRO": "Bairro", "CIDADE": "Cidade", "ESTADO": "UF", "DISTRIBUIDORA": "Nome", "UC": "Numero da UC", "CONTA_MES": "Não consta", "VENCIMENTO": "Não consta", "VALOR_FATURA": 0.00, "CONSUMO_M1": 0, "CONSUMO_M2": 0, "CONSUMO_M3": 0, "CONSUMO_M4": 0, "CONSUMO_M5": 0, "CONSUMO_M6": 0 }
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim());
}

async function analisarDocumentoIA(base64, mimeType, faceEsperada) {
  if (!GEMINI_API_KEY) throw new Error("Chave ausente");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Você é um perito em extração de dados de CNH e RG brasileiros. Face esperada: ${faceEsperada}.
    Se for a face incorreta, retorne VALIDO: false e descreva o erro em OBJETO_IDENTIFICADO.
    Extraia NOME_DOCUMENTO, CPF e DATA_NASCIMENTO. Se não encontrar, retorne "Não consta".
    Responda APENAS com JSON:
    { "VALIDO": true, "OBJETO_IDENTIFICADO": "", "NOME_DOCUMENTO": "NOME", "CPF": "000.000.000-00", "DATA_NASCIMENTO": "DD/MM/AAAA" }
  `;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim());
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V48 (Matemática Equatorial + Automação) ONLINE`));
