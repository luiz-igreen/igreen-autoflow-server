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
    T_RESGATE_START: "⚡ *Módulo de Extração de Dados* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Robson Carlos ou 1119032):",
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma está a extrair os dados no *Escritório Virtual iGreen*. Isto leva cerca de 25 segundos...",
    T_RESGATE_FAIL: "⚠️ O Robô varreu toda a tela da iGreen, mas o cliente não possui CPF registado na plataforma ou a busca falhou."
};

const CHROME_ARGS = [
    "--no-sandbox", 
    "--disable-setuid-sandbox", 
    "--disable-dev-shm-usage", 
    "--disable-gpu",
    "--single-process",
    "--no-zygote",
    "--js-flags=--expose-gc"
];

// ==========================================
// FUNÇÕES AUXILIARES (Z-API BLINDADA)
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        console.log(`[Z-API] Enviando mensagem para ${numLimpo}...`);
        await axios.post(
            `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
            { phone: numLimpo, message: String(message) }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }
        ); 
        console.log(`[Z-API] ✅ Mensagem enviada com sucesso!`);
    } catch (e) {
        console.error(`[Z-API] ❌ Erro ao enviar mensagem (Possível bloqueio na Z-API):`, e.response?.data || e.message);
    }
}

async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) return null;
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
        const prompt = `Você é um auditor da iGreen. Extraia da fatura: "NOME_CLIENTE", "CEP", "MEDIA_CONSUMO" (int), "UC", "DATA_VENCIMENTO" (DD/MM/AAAA), "FATURA_VENCIDA" (boolean). Retorne apenas JSON válido.`;
        const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }], generationConfig: { responseMimeType: "application/json" } };
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        return JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
    } catch (error) { return null; }
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
// MÓDULO: EXTRATOR V91 (FORÇA BRUTA + DIGITAÇÃO REAL)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] ⚠️ Iniciando Navegador Fantasma V91...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log(`[EXTRATOR] 1. Acessando Escritório iGreen...`);
        await page.goto(IGREEN_ESCRITORIO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log(`[EXTRATOR] Fazendo Login...`);
        await page.evaluate((u, p) => {
            const emailInput = document.querySelector('input[type="email"], input[placeholder*="e-mail" i]');
            const passInput = document.querySelector('input[type="password"], input[placeholder*="senha" i]');
            if(emailInput) { emailInput.value = u; emailInput.dispatchEvent(new Event('input')); }
            if(passInput) { passInput.value = p; passInput.dispatchEvent(new Event('input')); }
            const btnLogin = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar'));
            if(btnLogin) btnLogin.click();
        }, IGREEN_USER, IGREEN_PASS);
        
        await new Promise(r => setTimeout(r, 6000));

        console.log(`[EXTRATOR] 2. Navegando para Relatórios...`);
        await page.evaluate(() => {
            const btnRelatorios = Array.from(document.querySelectorAll('div, span, button, a')).find(e => e.textContent.trim() === 'Relatórios');
            if(btnRelatorios) btnRelatorios.click();
        });
        await new Promise(r => setTimeout(r, 1500));
        
        console.log(`[EXTRATOR] Indo para Mapa de Clientes...`);
        await page.evaluate(() => {
            const btnMapa = Array.from(document.querySelectorAll('div, span, a')).find(e => e.textContent.trim() === 'Mapa de Clientes');
            if(btnMapa) btnMapa.click();
        });
        await new Promise(r => setTimeout(r, 8000)); 

        console.log(`[EXTRATOR] 3. Pesquisando alvo com Borracha Humana: ${termoBusca}`);
        const searchSelector = 'input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]';
        const searchInput = await page.waitForSelector(searchSelector, { timeout: 15000 });
        
        // Simula clique triplo e backspace para limpar a barra (Burla a segurança React)
        await searchInput.click({ clickCount: 3 }); 
        await page.keyboard.press('Backspace'); 
        await new Promise(r => setTimeout(r, 500));
        
        // Digita o ID lentamente e carrega no Enter
        await page.type(searchSelector, termoBusca, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        
        console.log(`[EXTRATOR] Aguardando a tabela atualizar após a pesquisa (10s)...`);
        await new Promise(r => setTimeout(r, 10000)); 

        console.log(`[EXTRATOR] 4. Filtrando Tabela com Força Bruta (Regex)...`);
        const dadosExtraidos = await page.evaluate((busca) => {
            // Pega todo o texto da tabela filtrada
            const tbody = document.querySelector('tbody');
            if (!tbody) return null;
            
            const textoGigante = tbody.innerText || "";
            if (textoGigante.includes('Nenhum registro') || textoGigante.trim() === '') return null;

            // Busca o CPF em qualquer lugar do texto
            const padraoCpf = textoGigante.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
            const cpfFinal = padraoCpf ? padraoCpf[0] : "Não encontrado";

            // Busca a Data de Nascimento (datas anteriores a 2010 para não confundir com data de cadastro)
            const padraoDatas = textoGigante.match(/\d{2}\/\d{2}\/\d{4}/g);
            let nascFinal = "Não consta no sistema";
            if (padraoDatas) {
                const datasAntigas = padraoDatas.filter(d => parseInt(d.split('/')[2]) < 2010);
                if (datasAntigas.length > 0) nascFinal = datasAntigas[0];
            }

            // Tenta pegar o nome lendo a linha
            let nomeFinal = "Cliente Localizado";
            const tr = tbody.querySelector('tr');
            if (tr) {
                const tds = Array.from(tr.querySelectorAll('td'));
                for (let td of tds) {
                    let txt = td.innerText.trim();
                    // Nomes não têm números, são maiores que 6 letras e costumam estar em maiúsculas
                    if (txt.length > 6 && !/\d/.test(txt) && txt.toUpperCase() === txt && txt !== "ATIVO" && txt !== "VALIDADO") {
                        nomeFinal = txt;
                        break; // Pegou o nome, para a procura
                    }
                }
            }

            return { nome: nomeFinal, cpf: cpfFinal, nasc: nascFinal };
        }, termoBusca);

        await browser.close();

        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
            return;
        }

        console.log(`[EXTRATOR] 🎉 Dados capturados perfeitamente! Montando mensagem para o WhatsApp...`);
        const mensagemFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n` +
                              `👤 *Nome:* ${dadosExtraidos.nome}\n` +
                              `📄 *Documento:* ${dadosExtraidos.cpf}\n` +
                              `🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n` +
                              `⚡ *Atalhos das Concessionárias:*\n` +
                              `➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/sua-conta/segunda-via/\n` +
                              `➡️ *Cemig MG:* https://atendimento.cemig.com.br/`;

        await enviarMensagem(phone, mensagemFinal);

    } catch (error) {
        console.error("❌ [ERRO EXTRATOR V91]:", error.message);
        await enviarMensagem(phone, `⚠️ O servidor teve um pequeno soluço técnico. Tente enviar o comando novamente.`);
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
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    console.log(`[WEBHOOK] Mensagem recebida de ${phone}: ${txtL}`);

    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: false });
        await enviarMensagem(phone, TEXTOS.T01); return;
    }
    if (['resgatar', 'dados', 'puxar'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
        await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length > 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                setTimeout(() => { fluxoExtracaoDados(textoIn, phone); }, 3000);
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V91 ONLINE (Z-API Estável + Extração Bruta)`));
