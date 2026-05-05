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
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma está a invadir o *Escritório Virtual iGreen* em background com Força Bruta. Isto leva cerca de 25 segundos...",
    T_RESGATE_FAIL: "⚠️ O Robô varreu toda a tela do sistema da iGreen, mas o cliente não possui CPF registado na plataforma ou a busca falhou."
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
// FUNÇÕES AUXILIARES DE ENVIO E BANCO DE DADOS
// ==========================================

// V90 FIX: Função de envio blindada contra Erro 400
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
    
    try { 
        console.log(`[Z-API] Tentando enviar mensagem para ${numLimpo}...`);
        await axios.post(url, { 
            phone: numLimpo, 
            message: String(message) 
        }, {
            headers: { 'Content-Type': 'application/json' }
        }); 
        console.log(`[Z-API] ✅ Mensagem enviada com sucesso!`);
    } catch (e) {
        // Agora o erro exato da Z-API será impresso para não ficarmos cegos
        const erroDetalhado = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`[Z-API] ❌ Erro 400 (Rejeição da Z-API):`, erroDetalhado);
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
// MÓDULO: EXTRATOR V90 (ESPELHO DE DEPURAÇÃO E BACKSPACE)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] ⚠️ Iniciando Navegador Fantasma V90...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log(`[EXTRATOR] 1. Acessando Escritório iGreen...`);
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

        await page.evaluate(() => {
            const btnRelatorios = Array.from(document.querySelectorAll('div, span, button, a')).find(e => e.textContent.trim() === 'Relatórios');
            if(btnRelatorios) btnRelatorios.click();
        });
        await new Promise(r => setTimeout(r, 1500));
        
        await page.evaluate(() => {
            const btnMapa = Array.from(document.querySelectorAll('div, span, a')).find(e => e.textContent.trim() === 'Mapa de Clientes');
            if(btnMapa) btnMapa.click();
        });
        await new Promise(r => setTimeout(r, 8000)); 

        console.log(`[EXTRATOR] 3. Pesquisando alvo: ${termoBusca}`);
        const searchSelector = 'input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]';
        const searchInput = await page.waitForSelector(searchSelector, { timeout: 15000 });
        
        // A BORRACHA HUMANA (Evita o Bug do React da iGreen)
        await searchInput.click({ clickCount: 3 }); 
        await page.keyboard.press('Backspace'); 
        await new Promise(r => setTimeout(r, 500));
        
        await page.type(searchSelector, termoBusca, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        
        console.log(`[EXTRATOR] Aguardando a tabela atualizar (10s)...`);
        await new Promise(r => setTimeout(r, 10000)); 

        console.log(`[EXTRATOR] 4. Filtrando Tabela...`);
        const dadosExtraidos = await page.evaluate((busca) => {
            const trs = Array.from(document.querySelectorAll('tbody tr'));
            const tr = trs.find(linha => linha.innerText.includes(busca)) || trs[0];
            
            if (!tr || tr.innerText.includes('Nenhum registro')) return null;

            let cpfFinal = "Não encontrado";
            let nascFinal = "Não consta no sistema";
            let nomeFinal = "Cliente Localizado";

            const tds = Array.from(tr.querySelectorAll('td'));

            tds.forEach(td => {
                const txt = td.innerText.trim();
                if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(txt) || /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(txt)) {
                    cpfFinal = txt;
                }
                if (/^\d{2}\/\d{2}\/\d{4}$/.test(txt)) {
                    const ano = parseInt(txt.split('/')[2]);
                    if (ano < 2010) nascFinal = txt;
                }
            });

            for (let td of tds) {
                let txt = td.innerText.trim();
                if (txt.length > 8 && !/\d/.test(txt) && txt.toUpperCase() === txt && txt !== "ATIVO" && txt !== "VALIDADO") {
                    nomeFinal = txt;
                    break;
                }
            }

            return { nome: nomeFinal, cpf: cpfFinal, nasc: nascFinal };
        }, termoBusca);

        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            const textoDaTela = await page.evaluate(() => {
                const tbody = document.querySelector('tbody');
                return tbody ? tbody.innerText.substring(0, 300) : "Tabela não carregou";
            });
            
            await enviarMensagem(phone, `⚠️ O Robô não conseguiu extrair o CPF de ${termoBusca}.\n\n🔍 *OLHA O QUE O ROBÔ ENXERGOU NA TELA:*\n"${textoDaTela}"\n\n*(Se apareceu 'Nenhum registro', a busca falhou. Se apareceu o nome mas não o CPF, a coluna está oculta)*.`);
            await browser.close();
            return;
        }

        await browser.close();

        const mensagemFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n` +
                              `👤 *Nome:* ${dadosExtraidos.nome}\n` +
                              `📄 *Documento:* ${dadosExtraidos.cpf}\n` +
                              `🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n` +
                              `⚡ *Atalhos das Concessionárias:*\n` +
                              `➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/sua-conta/segunda-via/\n` +
                              `➡️ *Cemig MG:* https://atendimento.cemig.com.br/`;

        await enviarMensagem(phone, mensagemFinal);

    } catch (error) {
        console.error("❌ [ERRO EXTRATOR V90]:", error.message);
        await enviarMensagem(phone, `⚠️ O servidor teve um soluço técnico. Erro: ${error.message}`);
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

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V90 ONLINE (Correção de Erro 400)`));
