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
const IGREEN_ESCRITORIO_URL = "https://escritorio.igreenenergy.com.br"; 

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
    
    T_DEVOLUTIVA_START: "🛠️ *Módulo de Resolução de Pendências (Devolutiva)* ativado. Para o Robô localizar o cliente, digite o *Nome, ID ou CPF* do cliente na iGreen:",
    T_DEVOLUTIVA_DOC: "Alvo validado! 🎯 Agora, por favor, *envie a foto ou PDF do documento solicitado pela iGreen* (ex: Comprovante de Pagamento, RG da testemunha, etc):",
    T_DEVOLUTIVA_FIM: "📂 Documento recebido! O Robô RPA está acessando o Painel do Licenciado para pesquisar o cliente e anexar a devolutiva...",
    
    T_RESGATE_START: "⚡ *Módulo de Extração de Dados* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Wellington Silva ou 398172):",
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma está a invadir o *Escritório Virtual iGreen* em background para capturar o CPF e Nascimento do cliente...",
    T_RESGATE_FAIL: "⚠️ O Robô não conseguiu encontrar o cliente no Escritório Virtual. Verifique se o ID ou nome estão corretos."
};

const CHROME_ARGS = [
    "--no-sandbox", 
    "--disable-setuid-sandbox", 
    "--disable-dev-shm-usage", 
    "--disable-gpu",
    "--single-process",
    "--no-zygote"
];

// ==========================================
// FUNÇÕES AUXILIARES E IA
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
// MÓDULO: EXTRATOR INTELIGENTE DE DADOS (O ROUBO AO ESCRITÓRIO)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] Iniciando o Navegador Fantasma...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log(`[EXTRATOR] 1. Acessando Escritório: ${IGREEN_ESCRITORIO_URL}`);
        await page.goto(IGREEN_ESCRITORIO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.evaluate((u, p) => {
            const emailInput = document.querySelector('input[type="email"], input[placeholder*="e-mail" i]');
            const passInput = document.querySelector('input[type="password"], input[placeholder*="senha" i]');
            if(emailInput) { emailInput.value = u; emailInput.dispatchEvent(new Event('input')); }
            if(passInput) { passInput.value = p; passInput.dispatchEvent(new Event('input')); }
            const btnLogin = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar'));
            if(btnLogin) btnLogin.click();
        }, IGREEN_USER, IGREEN_PASS);
        
        await new Promise(r => setTimeout(r, 6000));

        console.log(`[EXTRATOR] 2. Navegando para Mapa de Clientes...`);
        await page.evaluate(() => {
            const btnRelatorios = Array.from(document.querySelectorAll('div, span, button, a')).find(e => e.textContent.trim() === 'Relatórios');
            if(btnRelatorios) btnRelatorios.click();
        });
        await new Promise(r => setTimeout(r, 1500));
        
        await page.evaluate(() => {
            const btnMapa = Array.from(document.querySelectorAll('div, span, a')).find(e => e.textContent.trim() === 'Mapa de Clientes');
            if(btnMapa) btnMapa.click();
        });
        await new Promise(r => setTimeout(r, 5000));

        console.log(`[EXTRATOR] 3. Pesquisando: ${termoBusca}`);
        await page.evaluate((busca) => {
            const searchInput = document.querySelector('input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]');
            if(searchInput) {
                searchInput.value = busca;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, termoBusca);
        await new Promise(r => setTimeout(r, 4000));

        console.log(`[EXTRATOR] 4. Extraindo Dados Preciosos...`);
        const dadosExtraidos = await page.evaluate(() => {
            const primeiraLinha = document.querySelector('tbody tr');
            if (!primeiraLinha || primeiraLinha.textContent.includes('Nenhum')) return null;

            let textoLinha = primeiraLinha.textContent;
            
            // Regex infalíveis para achar CPF e Data de Nascimento em qualquer parte da linha
            let regexCpf = textoLinha.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
            let regexData = textoLinha.match(/\d{2}\/\d{2}\/\d{4}/g);
            
            // Pega o nome (Geralmente a parte toda em maiúscula no começo da tabela)
            let nomeCliente = "Cliente Localizado";
            const celulas = primeiraLinha.querySelectorAll('td');
            if(celulas.length > 2) {
                nomeCliente = celulas[2].textContent.trim(); // Ajuste conforme a coluna de nome
            }

            return {
                nome: nomeCliente,
                cpf: regexCpf ? regexCpf[0] : "Não encontrado",
                nasc: regexData ? regexData[regexData.length - 1] : "Não encontrado"
            };
        });

        await browser.close();

        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
            return;
        }

        // MONTAGEM DA RESPOSTA DE BANDEJA DE PRATA
        const mensagemFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n` +
                              `👤 *Nome:* ${dadosExtraidos.nome}\n` +
                              `📄 *CPF:* ${dadosExtraidos.cpf}\n` +
                              `🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n` +
                              `⚡ *Atalhos das Concessionárias:*\n` +
                              `➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/sua-conta/segunda-via/\n` +
                              `➡️ *Cemig MG:* https://atendimento.cemig.com.br/`;

        await enviarMensagem(phone, mensagemFinal);

    } catch (error) {
        console.error("❌ [ERRO EXTRATOR]:", error.message);
        await enviarMensagem(phone, `⚠️ Ocorreu um erro no servidor ao tentar aceder ao Escritório Virtual. Motivo: ${error.message}`);
        if(browser) await browser.close();
    }
}

// ==========================================
// LÓGICA DO WEBHOOK
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
    if (['resgatar', 'dados', 'puxar'].includes(txtL)) {
        memoriaEstado.delete(phone);
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
        await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    switch (mem.STATUS_CADASTRO) {
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
            mem.STATUS_CADASTRO = mem.IS_ATUALIZACAO ? 'AGUARDANDO_EMAIL' : 'AGUARDANDO_DOC_FRENTE';
            await enviarMensagem(phone, mem.IS_ATUALIZACAO ? TEXTOS.T_ATUALIZAR_EMAIL : TEXTOS.T04);
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) return;
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T05);
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) return;
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T06);
            setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T07); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) return;
            mem.EMAIL = textoIn;
            mem.STATUS_CADASTRO = mem.IS_ATUALIZACAO ? 'ATUALIZADO' : 'CONCLUIDO';
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, mem.IS_ATUALIZACAO ? TEXTOS.T08_ATUALIZACAO : TEXTOS.T08);
            memoriaEstado.delete(phone); 
            break;

        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length > 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                fluxoExtracaoDados(textoIn, phone); // Vai apenas ao Escritório roubar os dados!
                memoriaEstado.delete(phone); 
            } else {
                await enviarMensagem(phone, "⚠️ Termo muito curto. Digite o Nome ou ID:");
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V78 ONLINE (Extrator Inteligente)`));
