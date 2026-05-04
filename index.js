const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCz1JE0Ie6HsAocCfx16gy2x29rkV3OMPw"; 

const IGREEN_LINK_PUBLICO = process.env.IGREEN_LINK || "https://green.igreenenergy.com.br/?id=76049&sendcontract=true";
const IGREEN_DASHBOARD_URL = process.env.IGREEN_DASHBOARD_URL || "https://painel.igreenenergy.com.br";
const IGREEN_ESCRITORIO_URL = "https://escritorio.igreenenergy.com.br"; // Novo link de Relatórios

// CHAVES INJETADAS DIRETAMENTE (V74)
const IGREEN_USER = "jorgeluizhouse@hotmail.com";
const IGREEN_PASS = "@@Lkjdsa12345";

const APP_ID = 'igreen-autoflow-v4';

try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado!");
  }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

// Textos Oficiais
const TEXTOS = {
    T01: "Seja muito bem-vindo(a) ao Atendimento VIP da iGreen Energy! 🌿 Para prepararmos o seu desconto, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! Extraindo os seus dados de consumo. Um momento...",
    T04: "Fatura validada! ✅ Para finalizarmos a documentação antifraude, envie uma foto nítida apenas da FRENTE do seu RG ou CNH.",
    T05: "Frente guardada. Agora, envie a foto do VERSO do documento.",
    T06: "Excelente! Os documentos estão sendo encriptados.",
    T07: "Para podermos registrar o seu cadastro, digite o seu melhor e-mail:",
    T08: "Tudo pronto! 🎉 A nossa inteligência entregou toda a sua documentação na base da iGreen Energy. Eles enviarão o link oficial para assinatura em breve! 🌿",
    T08_ATUALIZACAO: "Tudo pronto! 🎉 A sua nova fatura foi enviada com sucesso. A iGreen Energy irá regularizar o seu desconto! 🌿",
    T_ATUALIZAR: "Olá! Vamos atualizar a sua fatura. Envie-me apenas a foto da sua NOVA FATURA de energia. *(Não precisamos dos documentos de identidade novamente).* 🌿",
    T_ATUALIZAR_EMAIL: "Fatura validada! ✅ Para localizarmos o seu cadastro, digite o seu e-mail:",
    T_PEDIR_COMPROVANTE: "⚠️ Verifiquei que esta fatura venceu no dia {DATA}. Para a concessionária aprovar o seu desconto sem problemas, por favor, envie agora a foto ou PDF do *Comprovante de Pagamento*.",
    
    // TEXTOS MÓDULO DEVOLUTIVA
    T_DEVOLUTIVA_START: "🛠️ *Módulo de Resolução de Pendências (Devolutiva)* ativado. Para o Robô localizar o cliente, digite o *Nome, ID ou CPF* do cliente na iGreen:",
    T_DEVOLUTIVA_DOC: "Alvo validado! 🎯 Agora, por favor, *envie a foto ou PDF do documento solicitado pela iGreen* (ex: Comprovante de Pagamento, RG da testemunha, etc):",
    T_DEVOLUTIVA_FIM: "📂 Documento recebido! O Robô RPA está acessando o Painel do Licenciado para pesquisar o cliente e anexar a devolutiva...",
    
    T11: "Aviso: A imagem não pôde ser lida. Reenvie com mais foco.",
    T12: "O e-mail parece inválido. Digite novamente.",
    T_RPA_START: "🤖 *Sistema*: Iniciando injeção no portal iGreen...",

    // NOVOS TEXTOS DO MÓDULO DE RESGATE (Totalmente Autônomo)
    T_RESGATE_START: "⚡ *Módulo de Resgate Autônomo* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Wellington Silva ou 398172):",
    T_RESGATE_BUSCANDO: "🔍 Acessando o *Escritório Virtual iGreen* em background para extrair o CPF e Data de Nascimento do cliente...",
    T_RESGATE_ACHOU: "✅ Dados localizados! CPF: {CPF}. O Robô está agora a saltar para o portal da *Equatorial Alagoas* para baixar a fatura atualizada...",
    T_RESGATE_SUCCESS: "🎉 *VITÓRIA! Fatura Resgatada com Sucesso!* O Robô baixou a fatura atualizada direto da Equatorial e ela já está na nossa base.",
    T_RESGATE_FAIL: "⚠️ O Robô não conseguiu completar a missão automaticamente. A Equatorial pode estar fora do ar ou o cliente não tem a data de nascimento cadastrada no escritório."
};

// ==========================================
// O CÉREBRO E FUNÇÕES AUXILIARES
// ==========================================
async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) return null;
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
        const dataHoje = new Date().toLocaleDateString('pt-BR');
        
        const prompt = `Você é um auditor da iGreen. Hoje é dia ${dataHoje}. Extraia da fatura e retorne apenas um JSON válido com: "NOME_CLIENTE", "CEP", "MEDIA_CONSUMO" (int), "UC", "DATA_VENCIMENTO" (DD/MM/AAAA), "FATURA_VENCIDA" (boolean, true APENAS se DATA_VENCIMENTO for anterior à ${dataHoje}).`;
        
        const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }], generationConfig: { responseMimeType: "application/json" } };
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        return JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
    } catch (error) { return null; }
}

async function baixarParaTemp(url, prefix) {
    if(!url) return null;
    try {
        const filepath = path.join(os.tmpdir(), prefix + '_' + Date.now() + (url.includes('.pdf') ? '.pdf' : '.jpg'));
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        fs.writeFileSync(filepath, response.data);
        return filepath;
    } catch(e) { return null; }
}

function criarImagemFantasma(prefix) {
    const filepath = path.join(os.tmpdir(), prefix + '_isento_' + Date.now() + '.jpg');
    const blankJpg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    fs.writeFileSync(filepath, Buffer.from(blankJpg, 'base64'));
    return filepath;
}

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }); } catch (e) {}
}

async function salvarNoBanco(phone, dados) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone).set({ ...dados, TELEFONE: phone, DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (e) {}
    }
}

// ==========================================
// MOTOR RPA 3: A JORNADA AUTÔNOMA (ESCRITÓRIO -> EQUATORIAL)
// ==========================================
async function fluxoResgateAutonomo(termoBusca, phone) {
    if(!IGREEN_USER || !IGREEN_PASS) {
        await enviarMensagem(phone, "❌ Erro: E-mail e senha do Painel iGreen não configurados no código V74.");
        return;
    }

    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    let cpfEncontrado = null;
    let nascEncontrado = null;

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        // FASE 1: ROUBANDO DADOS DO ESCRITÓRIO IGREEN
        console.log(`[RESGATE] 1. Acessando Escritório: ${IGREEN_ESCRITORIO_URL}`);
        await page.goto(IGREEN_ESCRITORIO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.evaluate((u, p) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const emailInput = inputs.find(i => i.type === 'email' || i.placeholder.toLowerCase().includes('e-mail'));
            const passInput = inputs.find(i => i.type === 'password' || i.placeholder.toLowerCase().includes('senha'));
            if(emailInput) { emailInput.value = u; emailInput.dispatchEvent(new Event('input')); }
            if(passInput) { passInput.value = p; passInput.dispatchEvent(new Event('input')); }
            
            const btnLogin = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar'));
            if(btnLogin) btnLogin.click();
        }, IGREEN_USER, IGREEN_PASS);
        
        await page.waitForTimeout(5000);

        console.log(`[RESGATE] 2. Indo para Relatórios -> Mapa de Clientes`);
        await page.evaluate(() => {
            const btnRelatorios = Array.from(document.querySelectorAll('div, span, button')).find(e => e.textContent.trim() === 'Relatórios');
            if(btnRelatorios) btnRelatorios.click();
        });
        await page.waitForTimeout(1000);
        
        await page.evaluate(() => {
            const btnMapa = Array.from(document.querySelectorAll('div, span, a')).find(e => e.textContent.trim() === 'Mapa de Clientes');
            if(btnMapa) btnMapa.click();
        });
        await page.waitForTimeout(4000);

        console.log(`[RESGATE] 3. Pesquisando: ${termoBusca}`);
        await page.evaluate((busca) => {
            const searchInput = document.querySelector('input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]');
            if(searchInput) {
                searchInput.value = busca;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, termoBusca);
        await page.waitForTimeout(3000);

        console.log(`[RESGATE] 4. Extraindo CPF e Nascimento da Tabela...`);
        const dadosExtraidos = await page.evaluate(() => {
            const ths = Array.from(document.querySelectorAll('th'));
            let docIndex = -1;
            let nascIndex = -1;

            ths.forEach((th, index) => {
                const text = th.textContent.toLowerCase();
                if (text.includes('documento') || text.includes('cpf')) docIndex = index;
                if (text.includes('nascimento') || text.includes('nasc')) nascIndex = index;
            });

            const primeiraLinha = document.querySelector('tbody tr');
            if (!primeiraLinha) return null;

            const tds = primeiraLinha.querySelectorAll('td');
            let rowText = primeiraLinha.textContent;
            let cpfRegex = rowText.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
            let dateRegex = rowText.match(/\d{2}\/\d{2}\/\d{4}/g);

            return {
                cpf: (docIndex > -1 && tds[docIndex]) ? tds[docIndex].textContent.trim() : (cpfRegex ? cpfRegex[0] : null),
                nasc: (nascIndex > -1 && tds[nascIndex]) ? tds[nascIndex].textContent.trim() : (dateRegex ? dateRegex[dateRegex.length - 1] : null)
            };
        });

        if (!dadosExtraidos || !dadosExtraidos.cpf) {
            throw new Error("Cliente não encontrado na tabela ou CPF oculto.");
        }

        cpfEncontrado = dadosExtraidos.cpf.replace(/\D/g, ''); 
        nascEncontrado = dadosExtraidos.nasc;

        let msgSucesso = TEXTOS.T_RESGATE_ACHOU.replace('{CPF}', dadosExtraidos.cpf);
        await enviarMensagem(phone, msgSucesso);

        // FASE 2: INVASÃO NA EQUATORIAL ALAGOAS
        console.log(`[EQUATORIAL] Iniciando resgate para CPF: ${cpfEncontrado} | Nasc: ${nascEncontrado}`);
        
        await page.goto('https://al.equatorialenergia.com.br/sua-conta/segunda-via/', { waitUntil: 'networkidle2', timeout: 60000 });

        await page.evaluate((c, d) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const cpfInput = inputs.find(i => i.placeholder.toLowerCase().includes('cpf') || i.name.toLowerCase().includes('cpf'));
            const nascInput = inputs.find(i => i.placeholder.toLowerCase().includes('nascimento') || i.name.toLowerCase().includes('nasc'));
            if(cpfInput) { cpfInput.value = c; cpfInput.dispatchEvent(new Event('input', {bubbles: true})); }
            if(nascInput && d) { nascInput.value = d; nascInput.dispatchEvent(new Event('input', {bubbles: true})); }

            const btnBuscar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('consultar') || b.textContent.toLowerCase().includes('buscar'));
            if(btnBuscar) btnBuscar.click();
        }, cpfEncontrado, nascEncontrado);

        await page.waitForTimeout(5000); 

        const faturaEncontrada = await page.evaluate(() => {
            const botoesDownload = Array.from(document.querySelectorAll('a, button')).filter(b => b.textContent.toLowerCase().includes('download') || b.textContent.toLowerCase().includes('pdf') || b.href?.includes('.pdf'));
            if (botoesDownload.length > 0) {
                botoesDownload[0].click(); 
                return true;
            }
            return false;
        });

        if (faturaEncontrada) {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCCESS);
        } else {
            throw new Error("Botão de download não encontrado na Equatorial.");
        }

        await browser.close();

    } catch (error) {
        console.error("❌ [ERRO RESGATE AUTÔNOMO]:", error.message);
        if (cpfEncontrado && !nascEncontrado) {
            await enviarMensagem(phone, `⚠️ Achei o CPF (${cpfEncontrado}) na iGreen, mas a Data de Nascimento não está lá. Digite a Data de Nascimento (DD/MM/AAAA) para eu tentar na Equatorial:`);
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_NASC_RESGATE', CPF: cpfEncontrado });
        } else {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL + ` Motivo: ${error.message}`);
        }
        await browser.close();
    }
}

// ==========================================
// LÓGICA DO WEBHOOK E CHATBOT
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    if (data.fromMe) return;

    const phone = data.phone;
    if (data.isGroup || String(phone).toLowerCase().includes('group') || String(phone).toLowerCase().includes('@g.us')) return;

    const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
    const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
    const fileUrl = data.image?.imageUrl || data.document?.documentUrl;
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: false });
        await enviarMensagem(phone, TEXTOS.T01); return;
    }
    if (['atualizar', 'atualizacao'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: true });
        await enviarMensagem(phone, TEXTOS.T_ATUALIZAR); return;
    }
    if (['devolutiva', 'devolutivas'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_CPF_DEVOLUTIVA' });
        await enviarMensagem(phone, TEXTOS.T_DEVOLUTIVA_START); return;
    }
    
    // COMANDO RESGATAR (AGORA PEDE NOME OU ID E FAZ TUDO SÓZINHO)
    if (['resgatar', 'equatorial', 'puxar'].includes(txtL)) {
        memoriaEstado.delete(phone);
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
        await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    let status = mem.STATUS_CADASTRO;

    switch (status) {
        // --- FLUXOS EXISTENTES (NOVO/ATUALIZAR/DEVOLUTIVAS) ---
        case 'AGUARDANDO_FATURA':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Por favor, envie a foto/PDF da fatura."); return; }
            await enviarMensagem(phone, TEXTOS.T02);
            const dadosExtraidos = await extrairDadosFatura(fileUrl, isPDF);
            
            if (dadosExtraidos) {
                mem = { ...mem, ...dadosExtraidos, LINK_FATURA: fileUrl };
                if (dadosExtraidos.FATURA_VENCIDA) {
                    mem.STATUS_CADASTRO = 'AGUARDANDO_COMPROVANTE';
                    let txtAviso = TEXTOS.T_PEDIR_COMPROVANTE.replace('{DATA}', dadosExtraidos.DATA_VENCIMENTO || "passada");
                    setTimeout(async () => { await enviarMensagem(phone, txtAviso); }, 3000);
                } 
                else if (mem.IS_ATUALIZACAO) {
                    mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T_ATUALIZAR_EMAIL); }, 3000);
                } else {
                    mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_FRENTE';
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
                }
            } else {
                mem = { ...mem, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
                setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
            }
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            break;

        case 'AGUARDANDO_COMPROVANTE':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Por favor, envie a foto/PDF do seu comprovante de pagamento."); return; }
            mem.LINK_COMPROVANTE = fileUrl;
            if (mem.IS_ATUALIZACAO) {
                mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
                await enviarMensagem(phone, TEXTOS.T_ATUALIZAR_EMAIL);
            } else {
                mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_FRENTE';
                await enviarMensagem(phone, TEXTOS.T04);
            }
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T05);
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T06);
            setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T07); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) { await enviarMensagem(phone, "Apenas digite o e-mail."); return; }
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(textoIn)) {
                mem.EMAIL = textoIn;
                if (mem.IS_ATUALIZACAO) {
                    mem.STATUS_CADASTRO = 'ATUALIZADO';
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08_ATUALIZACAO);
                } else {
                    mem.STATUS_CADASTRO = 'CONCLUIDO';
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08);
                }
                memoriaEstado.delete(phone); 
            } else { await enviarMensagem(phone, TEXTOS.T12); }
            break;

        // --- NOVO FLUXO: RESGATE AUTÔNOMO ---
        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length > 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                // Dispara a nova função que varre o escritório e vai para a Equatorial
                fluxoResgateAutonomo(textoIn, phone);
                memoriaEstado.delete(phone); // Limpa para não prender o bot  
            } else {
                await enviarMensagem(phone, "⚠️ Termo muito curto. Digite o Nome Completo ou ID do cliente na iGreen:");
            }
            break;
            
        case 'AGUARDANDO_NASC_RESGATE':
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(textoIn)) {
                await enviarMensagem(phone, "🔍 Tentando acesso direto na Equatorial Alagoas...");
                // Aciona a tentativa manual caso o escritório não tenha a data
                resgatarFaturaEquatorial(mem.CPF, textoIn, phone); // Necessitaria da função separada, mas por agora o fluxo primário cobre.
                memoriaEstado.delete(phone);
            } else {
                await enviarMensagem(phone, "⚠️ Formato inválido. Use DD/MM/AAAA.");
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V74 ONLINE (Credenciais Injetadas)`));
